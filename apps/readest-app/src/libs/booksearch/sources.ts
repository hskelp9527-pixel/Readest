/**
 * 多书源聚合搜索（公版源提供 epub 直链，可「一键加入书架」直接阅读）。
 *
 * 源说明：
 * - gutenberg      Project Gutenberg / Gutendex（公版书，epub 直链，含部分中文书）
 * - standardebooks Standard Ebooks（志愿者精校的公版书，epub 直链，排版质量高）
 * - archive        Internet Archive（开放获取文本，epub 直链）
 * - zlibrary       Z-Library（兜底源，多为在版版权书；搜索免登录，下载需 cookie 凭据；
 *                  未配凭据时结果降级为「去 Z-Library」跳转链接）
 */

import * as OpenCC from 'opencc-js/cn2t';

import { getZlibDownloadQuota, isZlibConfigured, searchZlib, type ZlibQuota } from './zlibrary';

export type BookSourceId = 'gutenberg' | 'standardebooks' | 'archive' | 'zlibrary';

/** 语言筛选：all 全部 / zh 中文 / en 英文 */
export type SearchLang = 'all' | 'zh' | 'en';

export interface BookFormat {
  type: string; // epub / html
  url: string;
  /** true = 直链文件，可在线阅读或直接下载 */
  direct: boolean;
  /** true = 下载需凭据（zlib），未配凭据时前端改显示跳转链接 */
  authRequired?: boolean;
}

export interface BookResult {
  id: string;
  source: BookSourceId;
  sourceLabel: string;
  title: string;
  author: string;
  category?: string;
  cover?: string;
  language?: string;
  downloads?: number;
  formats: BookFormat[];
  /** read = 有直链可立即阅读 */
  action: 'read';
  note?: string;
  /** 外站落地页（zlib 未配凭据时的跳转目标） */
  externalUrl?: string;
}

/** 单源超时：本机访问不到的源（如 archive.org）不该把整次聚合检索拖满 10 秒 */
const FETCH_TIMEOUT_MS = 5_000;
/** Internet Archive 元数据查询数量多，单独放宽超时 */
const ARCHIVE_META_TIMEOUT_MS = 6_000;
/** 单本 epub 大小上限（与 /api/proxy 一致） */
const MAX_EPUB_BYTES = 80 * 1024 * 1024;

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'readest-fork-booksearch/0.2' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  return JSON.parse(await fetchText(url, timeoutMs)) as T;
}

/** 简 → 繁转换器（懒加载：只有出现中文查询时才建） */
let s2tConverter: ((s: string) => string) | null = null;

/**
 * 公版书源（Gutenberg / Archive）里的中文书基本都以繁体入库
 * （如《红楼梦》只有「紅樓夢」条目），搜简体是 0 条。
 * 这里把简体查询额外转出一个繁体变体一起查。
 */
export function queryVariants(q: string): string[] {
  if (!/[一-鿿]/.test(q)) return [q];
  s2tConverter ??= OpenCC.Converter({ from: 'cn', to: 'tw' });
  const t = s2tConverter(q);
  return t === q ? [q] : [q, t];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

/* ----------------------------- gutenberg ---------------------------- */

interface GutendexBook {
  id: number;
  title: string;
  authors: Array<{ name: string }>;
  languages: string[];
  download_count: number;
  formats: Record<string, string>;
}

async function searchGutenberg(q: string, limit: number, lang?: SearchLang): Promise<BookResult[]> {
  // Gutendex 不支持 OR，简繁变体分别查一次后按 id 去重
  const settled = await Promise.allSettled(
    queryVariants(q).map((v) => {
      const params = new URLSearchParams({ search: v });
      if (lang === 'zh') params.set('languages', 'zh');
      else if (lang === 'en') params.set('languages', 'en');
      return fetchJson<{ results: GutendexBook[] }>(
        `https://gutendex.com/books?${params.toString()}`,
      );
    }),
  );
  // 全部变体都失败才算源不可用（保留报错让前端显示「不可用」）
  const ok = settled.filter(
    (r): r is PromiseFulfilledResult<{ results: GutendexBook[] }> => r.status === 'fulfilled',
  );
  if (ok.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
  const byId = new Map<number, GutendexBook>();
  for (const r of ok) for (const b of r.value.results || []) byId.set(b.id, b);

  return [...byId.values()]
    .filter((b) => b.formats['application/epub+zip'])
    .slice(0, limit)
    .map((b) => {
      const formats: BookFormat[] = [
        { type: 'epub', url: b.formats['application/epub+zip']!, direct: true },
      ];
      const html = b.formats['text/html'];
      if (html) formats.push({ type: 'html', url: html, direct: true });
      return {
        id: `gutenberg:${b.id}`,
        source: 'gutenberg' as const,
        sourceLabel: 'Gutenberg 公版书',
        title: b.title,
        author: b.authors.map((a) => a.name).join(', ') || '未知作者',
        cover: b.formats['image/jpeg'],
        language: b.languages.join(','),
        downloads: b.download_count,
        formats,
        action: 'read' as const,
        note: '公版书，epub 直链，可直接阅读',
      };
    });
}

/* --------------------------- standardebooks -------------------------- */

async function searchStandardEbooks(
  q: string,
  limit: number,
  lang?: SearchLang,
): Promise<BookResult[]> {
  // Standard Ebooks 仅有英文精校公版书，中文筛选时直接跳过
  if (lang === 'zh') return [];
  const xml = await fetchText(
    `https://standardebooks.org/feeds/opds/all?query=${encodeURIComponent(q)}`,
  );
  const entries = xml.split('<entry>').slice(1);
  const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

  const results: BookResult[] = [];
  for (const entry of entries) {
    const title = decodeEntities(/<title>([^<]*)<\/title>/.exec(entry)?.[1] ?? '').trim();
    const author = decodeEntities(/<author>\s*<name>([^<]*)<\/name>/.exec(entry)?.[1] ?? '').trim();
    const links = [...entry.matchAll(/<link\b[^>]*\/?>/g)].map((m) => m[0]);
    const epubTag = links.find(
      (t) => attr(t, 'type') === 'application/epub+zip' && attr(t, 'href'),
    );
    const thumbTag = links.find((t) =>
      (attr(t, 'rel') ?? '').includes('opds-spec.org/image/thumbnail'),
    );
    if (!title || !epubTag) continue;
    results.push({
      id: `standardebooks:${attr(epubTag, 'href')}`,
      source: 'standardebooks',
      sourceLabel: 'Standard Ebooks',
      title,
      author: author || '未知作者',
      cover: thumbTag ? attr(thumbTag, 'href') : undefined,
      language: 'en',
      formats: [{ type: 'epub', url: attr(epubTag, 'href')!, direct: true }],
      action: 'read',
      note: '精校公版书，epub 直链，可直接阅读',
    });
    if (results.length >= limit) break;
  }
  return results;
}

/* ------------------------------ archive ------------------------------ */

interface ArchiveDoc {
  identifier: string;
  title?: string;
  creator?: string | string[];
  downloads?: number;
  language?: string | string[];
}

interface ArchiveMeta {
  files?: Array<{ name: string; size?: string | number; private?: string }>;
}

/** 在条目文件列表里挑一个可直接下载的 epub（跳过加密/私有/超大文件） */
function pickArchiveEpub(id: string, files: ArchiveMeta['files']): string | null {
  const candidates = (files ?? []).filter((f) => {
    if (!/\.epub$/i.test(f.name)) return false;
    if (/encrypted/i.test(f.name)) return false;
    if (f.private === 'true') return false;
    const size = Number(f.size || 0);
    if (size > MAX_EPUB_BYTES) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  // 优先官方命名 <id>.epub，其次第一个
  const preferred = candidates.find((f) => f.name === `${id}.epub`) ?? candidates[0]!;
  return preferred.name;
}

async function searchArchive(q: string, limit: number, lang?: SearchLang): Promise<BookResult[]> {
  // 排除纯借阅（inlibrary）条目，只保留开放获取的文本；中文查询带上繁体变体
  const query = `(${queryVariants(q).join(' OR ')}) AND mediatype:texts AND NOT collection:inlibrary`;
  const data = await fetchJson<{ response?: { docs?: ArchiveDoc[] } }>(
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}` +
      `&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&fl[]=language` +
      `&sort[]=downloads desc&rows=12&output=json`,
  );
  const docs = (data.response?.docs ?? []).slice(0, 10);

  const settled = await Promise.allSettled(
    docs.map(async (d): Promise<BookResult | null> => {
      const meta = await fetchJson<ArchiveMeta>(
        `https://archive.org/metadata/${encodeURIComponent(d.identifier)}`,
        ARCHIVE_META_TIMEOUT_MS,
      );
      const epubName = pickArchiveEpub(d.identifier, meta.files);
      if (!epubName) return null;
      const author = Array.isArray(d.creator) ? d.creator.join(', ') : d.creator;
      const docLang = Array.isArray(d.language) ? d.language[0] : d.language;
      // Archive 的 language 是后端字段，这里按筛选条件后过滤
      if (lang === 'zh' && !/zh|chi|chinese/i.test(docLang || '')) return null;
      if (lang === 'en' && !/en|eng|english/i.test(docLang || '')) return null;
      return {
        id: `archive:${d.identifier}`,
        source: 'archive',
        sourceLabel: 'Internet Archive',
        title: d.title || d.identifier,
        author: author || '未知作者',
        cover: `https://archive.org/services/img/${d.identifier}`,
        language: docLang,
        downloads: d.downloads,
        formats: [
          {
            type: 'epub',
            url: `https://archive.org/download/${d.identifier}/${encodeURIComponent(epubName)}`,
            direct: true,
          },
        ],
        action: 'read',
        note: '开放获取，epub 直链，可直接阅读',
      };
    }),
  );

  return settled
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((r): r is BookResult => r !== null)
    .slice(0, limit);
}

/* ---------------------------- aggregator ---------------------------- */

export interface SearchResponse {
  query: string;
  total: number;
  sources: Record<BookSourceId, { ok: boolean; count: number; error?: string }>;
  results: BookResult[];
  /** Z-Library 是否配置了下载凭据（前端据此决定「加入书架」/「去 Z-Library」） */
  zlibConfigured?: boolean;
  /** Z-Library 今日下载配额（配了凭据才返回实时数据，前端用于限量提醒） */
  zlibQuota?: ZlibQuota;
}

const SOURCE_ORDER: BookSourceId[] = ['gutenberg', 'standardebooks', 'archive', 'zlibrary'];

/** 单个书源的总耗时上限（含内部串联请求），超时按「该源不可用」处理 */
const SOURCE_DEADLINE_MS = 8_000;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`源响应超时（${ms}ms）`)), ms)),
  ]);
}

/** 把外部字符串归一成 SearchLang，非法值当 'all' */
function normalizeLang(v?: string): SearchLang {
  return v === 'zh' || v === 'en' ? v : 'all';
}

export async function aggregateSearch(
  rawQ: string,
  sourceFilter?: string,
  langRaw?: string,
): Promise<SearchResponse> {
  const q = rawQ.trim();
  const lang = normalizeLang(langRaw);
  const enabled: BookSourceId[] = (
    sourceFilter && sourceFilter !== 'all'
      ? (sourceFilter.split(',') as BookSourceId[])
      : SOURCE_ORDER
  ).filter((s) => SOURCE_ORDER.includes(s));

  const jobs: Array<[BookSourceId, Promise<BookResult[]>]> = [];
  if (enabled.includes('gutenberg')) jobs.push(['gutenberg', searchGutenberg(q, 20, lang)]);
  if (enabled.includes('standardebooks'))
    jobs.push(['standardebooks', searchStandardEbooks(q, 20, lang)]);
  if (enabled.includes('archive')) jobs.push(['archive', searchArchive(q, 12, lang)]);
  if (enabled.includes('zlibrary')) {
    const zlibLang = lang === 'all' ? undefined : lang;
    jobs.push(['zlibrary', searchZlib(q, 20, zlibLang)]);
  }

  // 配额查询与搜索并行，不要串在后面多加一个往返
  const quotaJob = enabled.includes('zlibrary')
    ? getZlibDownloadQuota()
    : Promise.resolve(undefined);

  // 单源硬上限：archive 的「查询 + 逐条元数据」是嵌套请求，光靠单次 fetch 超时压不住
  const settled = await Promise.allSettled(
    jobs.map(([, p]) => withDeadline(p, SOURCE_DEADLINE_MS)),
  );

  const sources = {} as SearchResponse['sources'];
  const seen = new Set<string>();
  const results: BookResult[] = [];

  settled.forEach((outcome, i) => {
    const id = jobs[i]![0];
    if (outcome.status === 'fulfilled') {
      sources[id] = { ok: true, count: outcome.value.length };
      for (const r of outcome.value) {
        const dedupeKey = `${r.title}|${r.author}`.toLowerCase().replace(/\s+/g, '');
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        results.push(r);
      }
    } else {
      sources[id] = {
        ok: false,
        count: 0,
        error: outcome.reason instanceof Error ? outcome.reason.message : 'unknown error',
      };
    }
  });

  // 保持书源顺序（公版源 → Z-Library 兜底），源内按下载量
  const rank = (r: BookResult) => SOURCE_ORDER.indexOf(r.source);
  results.sort((a, b) => rank(a) - rank(b) || (b.downloads ?? 0) - (a.downloads ?? 0));

  return {
    query: q,
    total: results.length,
    sources,
    results,
    zlibConfigured: isZlibConfigured(),
    // 只在启用了 zlib 源时才查配额（省一次请求；未配凭据返回 configured:false）
    zlibQuota: await quotaJob,
  };
}
