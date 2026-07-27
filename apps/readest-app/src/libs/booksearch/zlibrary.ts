/**
 * Z-Library 书源（兜底源，排在三公版源之后）。
 *
 * 设计要点：
 * - 搜索免登录：POST {domain}/eapi/book/search（实测 2026-07-26）。
 * - 配额查询免登录外的接口：配了 remix cookie 后 GET /eapi/user/profile 返回
 *   downloads_today / downloads_limit，用于「今日剩 N/10 次」限量提醒。
 * - 下载：`/dl/` 走不通（镜像对普通页面挂了「Checking your browser」挑战，整站 503，
 *   带 remix cookie 也过不去）；但 `/eapi/*` 免挑战——带 cookie 请求
 *   `/eapi/book/{id}/{hash}/file` 会返回 CDN 一次性直链，服务端即可拉 epub 入库。
 *   配了凭据 → 结果卡显示「加入书架」；未配 → 降级为「去 Z-Library」跳转下载。
 *   （2026-07-26 实测：dln1.ncdn.ec 返回 application/epub+zip，配额 -1。）
 *
 * 合规：Z-Library 多为在版版权书。搜索默认可用。建议仅自托管启用。
 *
 * 实测响应字段（2026-07-26 本机经 tw.zlib0.ru 验证）：
 *   id, title, author, year, publisher, language(全名如 "Chinese"), extension,
 *   filesizeString, cover(完整 URL, *.cdn-zlib.sk), dl(相对路径如 /dl/xxxx), hash,
 *   md5, href(完整落地页 URL)
 */

import type { BookResult } from './sources';

/** 导航站：列出可用镜像域名（含官方域，需特殊网络） */
const NAV_SCRIPT_URL = 'https://zlibrary.zyfx6.xyz/script.js';
/** ZLIB_DOMAIN 未配置、导航站不可达时的内置兜底（本机直连实测可用） */
const FALLBACK_DOMAINS = [
  'tw.zlib0.ru',
  'zh.zlib0.ru',
  // 官方域：本机常不可达，Cloudflare 边缘可能可达，作为最后兜底
  'z-library.sk',
  '1lib.sk',
  'z-lib.fm',
];
/** 域名缓存有效期 */
const DOMAIN_TTL_MS = 6 * 60 * 60 * 1000; // 6h
/** 搜索/探测超时：慢源不该拖住整次聚合检索 */
const FETCH_TIMEOUT_MS = 5_000;
/** 域名探测超时：活着的镜像 1 秒内就会应答，等更久只是在陪死域 */
const PROBE_TIMEOUT_MS = 2_500;
/** 下载链路超时：拿签名链接 + 拉文件都比搜索慢，单独放宽 */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** 模块级域名缓存（dev 下持久；prod Worker best-effort，最坏每搜索多一次活性探测） */
let cachedDomain: string | null = null;
let cachedAt = 0;
let discovering: Promise<string | null> | null = null;

/* ----------------------------- 环境凭据 ----------------------------- */

/**
 * 是否配置了 Z-Library 下载凭据（remix_userid + remix_userkey 同时存在）。
 * 前端据 zlibConfigured 决定「加入书架」还是「去 Z-Library」。
 */
export function isZlibConfigured(): boolean {
  return !!(process.env['ZLIB_REMIX_USERID'] && process.env['ZLIB_REMIX_USERKEY']);
}

/**
 * 拼接下载用的 Cookie 头。未配置返回 null（proxy 此时直接 401）。
 */
export function getZlibCookieHeader(): string | null {
  const uid = process.env['ZLIB_REMIX_USERID'];
  const ukey = process.env['ZLIB_REMIX_USERKEY'];
  if (!uid || !ukey) return null;
  return `remix_userid=${uid}; remix_userkey=${ukey}`;
}

/* ----------------------------- 域名发现 ----------------------------- */

/** Z-Library 今日下载配额（eapi /user/profile 实时返回） */
export interface ZlibQuota {
  /** 是否配置了凭据（未配则 quota 字段无意义） */
  configured: boolean;
  /** 今日已下载次数（未配凭据时为 0） */
  downloadsToday?: number;
  /** 每日下载上限（免费账号通常 10） */
  downloadsLimit?: number;
}

/**
 * 查询今日下载配额。配了凭据才调 /eapi/user/profile；
 * 未配、查询失败、域名不可达时都安全降级（configured 反映真实状态）。
 * 用于前端「今日剩 N/10 次」提醒，避免用户不知情耗尽额度。
 */
export async function getZlibDownloadQuota(): Promise<ZlibQuota> {
  if (!isZlibConfigured()) return { configured: false };
  const cookie = getZlibCookieHeader();
  const domain = await getActiveZlibDomain();
  if (!domain || !cookie) return { configured: true };
  try {
    const res = await fetchWithTimeout(`https://${domain}/eapi/user/profile`, {
      headers: {
        Cookie: cookie,
        'User-Agent': 'readest-fork-booksearch/0.2',
      },
    });
    if (!res.ok) return { configured: true };
    const data = (await res.json()) as {
      success?: number;
      user?: { downloads_today?: number; downloads_limit?: number };
    };
    if (data.success !== 1 || !data.user) return { configured: true };
    return {
      configured: true,
      downloadsToday: data.user.downloads_today ?? 0,
      downloadsLimit: data.user.downloads_limit ?? 10,
    };
  } catch {
    return { configured: true };
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 从导航站 script.js 抠出域名清单（解析 `domain: 'xxx'`） */
async function fetchNavDomains(): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(NAV_SCRIPT_URL);
    if (!res.ok) return [];
    const text = await res.text();
    const matches = [...text.matchAll(/domain:\s*'([^']+)'/g)];
    return matches.map((m) => m[1]!.toLowerCase()).filter((d) => d.includes('.'));
  } catch {
    return [];
  }
}

/**
 * 探测单个域名是否可用：对 eapi 搜索端点发一个最小查询。
 *
 * 只认 2xx 和 4xx（含 400「query incorrect」）——说明 eapi 本身在响应。
 * **3xx 一律判死**：导航站清单里的 z-lib.work / zlib.ch 等对 eapi 直接 301/302 跳回首页，
 * 早先把它们当「活着」会缓存一个坏域名，之后每次搜索都拿到 HTML、JSON 解析失败返回 0 条。
 */
export async function probeDomain(domain: string): Promise<boolean> {
  const url = `https://${domain}/eapi/book/search`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'readest-fork-booksearch/0.2',
        },
        redirect: 'manual',
        body: new URLSearchParams({
          message: 'a',
          limit: '1',
          'extensions[]': 'epub',
        }).toString(),
      },
      PROBE_TIMEOUT_MS,
    );
    return res.status < 300 || (res.status >= 400 && res.status < 500);
  } catch {
    return false;
  }
}

/**
 * 取当前可用的 Z-Library 域名。
 * 优先级：ZLIB_DOMAIN env → 内置清单 → 导航站清单；并行活性探测，取优先级最高的活域。
 * 结果缓存 6h。并发去重（同一进程内多次调用复用同一次发现）。
 */
export async function getActiveZlibDomain(): Promise<string | null> {
  const now = Date.now();
  if (cachedDomain && now - cachedAt < DOMAIN_TTL_MS) return cachedDomain;

  if (!discovering) {
    discovering = (async () => {
      // 1. env 直配优先（部署者已知可用域名时可跳过探测）
      const envDomain = process.env['ZLIB_DOMAIN']?.trim().toLowerCase();
      const candidates: string[] = [];
      if (envDomain) candidates.push(envDomain);
      // 2. 内置清单（实测可用的镜像，优先于导航站——导航站列的多是跳首页的门户域）
      for (const d of FALLBACK_DOMAINS) if (!candidates.includes(d)) candidates.push(d);
      // 3. 导航站清单：内置全挂时的自动发现兜底
      const nav = await fetchNavDomains();
      for (const d of nav) if (!candidates.includes(d)) candidates.push(d);

      // 并行探测：串行时每个死域都要等满超时，最坏几十秒；并行后总耗时 = 最慢的一个。
      // 结果按候选优先级取第一个活着的。
      const alive = await Promise.all(candidates.map((d) => probeDomain(d)));
      const idx = alive.findIndex(Boolean);
      if (idx < 0) return null;
      cachedDomain = candidates[idx]!;
      cachedAt = Date.now();
      return cachedDomain;
    })().finally(() => {
      discovering = null;
    });
  }
  return discovering;
}

/** 清除域名缓存（proxy 遇 401/403 时调用，让下次搜索重新探测） */
export function invalidateZlibDomain(): void {
  cachedDomain = null;
  cachedAt = 0;
}

/** 判断 host 是否属于 Z-Library 域（用于 proxy 白名单匹配） */
export function isZlibHost(host: string): boolean {
  const h = host.toLowerCase();
  if (cachedDomain && (h === cachedDomain || h.endsWith(`.${cachedDomain}`))) return true;
  return [...FALLBACK_DOMAINS].some((d) => h === d || h.endsWith(`.${d}`));
}

/* ------------------------------- 下载 ------------------------------- */

/** eapi 取文件直链的路径形态：/eapi/book/{id}/{hash}/file */
const FILE_ENDPOINT_RE = /^\/eapi\/book\/\d+\/[a-z0-9]+\/file$/i;

/** 该 URL 是否是 eapi 换直链端点（proxy 据此决定是否先换链接再下载） */
export function isZlibFileEndpoint(pathname: string): boolean {
  return FILE_ENDPOINT_RE.test(pathname);
}

/**
 * 用 eapi 换一次性 CDN 直链。
 *
 * 2026-07-26 复测修正了旧结论：镜像对 `/dl/` 挂了「Checking your browser」挑战（整站 503，
 * 带 remix cookie 也过不去），但 `/eapi/*` 免挑战——带 cookie 请求
 * `/eapi/book/{id}/{hash}/file` 直接返回 `{ file: { downloadLink } }`，链接指向 CDN
 * （dln*.ncdn.ec）且无需凭据即可拉取。因此服务端入库是可行的，走这条路。
 *
 * 注意：每成功换一次链接消耗一次每日下载配额。
 */
export async function resolveZlibFileLink(
  endpoint: string,
): Promise<{ link: string } | { error: string }> {
  const cookie = getZlibCookieHeader();
  if (!cookie) return { error: 'Z-Library 凭据未配置' };
  try {
    const res = await fetchWithTimeout(
      endpoint,
      { headers: { Cookie: cookie, 'User-Agent': 'readest-fork-booksearch/0.2' } },
      DOWNLOAD_TIMEOUT_MS,
    );
    if (!res.ok) return { error: `Z-Library 返回 ${res.status}` };
    const data = (await res.json()) as {
      success?: number;
      file?: { downloadLink?: string; allowDownload?: boolean; disallowDownloadMessage?: string };
    };
    // 额度用完时 success 仍是 1，靠 allowDownload 判断（站点消息带 HTML，剥标签后透出）
    if (data.file?.allowDownload === false) {
      const msg = (data.file.disallowDownloadMessage ?? '').replace(/<[^>]*>/g, '').trim();
      return { error: msg || '今日下载额度已用完' };
    }
    const link = data.file?.downloadLink;
    return link ? { link } : { error: 'Z-Library 未返回下载链接' };
  } catch {
    return { error: 'Z-Library 取下载链接超时' };
  }
}

/* ------------------------------- 搜索 ------------------------------- */

interface ZlibBook {
  id: number;
  title: string;
  author: string;
  year?: number;
  publisher?: string;
  language?: string; // 全名："Chinese" / "English"
  extension?: string;
  filesizeString?: string;
  cover?: string; // 完整 URL，*.cdn-zlib.sk
  dl?: string; // 相对路径：/dl/xxxx
  hash?: string;
  href?: string; // 完整落地页 URL
}

interface ZlibSearchResponse {
  success: number;
  books?: ZlibBook[];
  error?: string;
}

/**
 * 搜索 Z-Library。搜索本身不需登录。
 * @param q      搜索词（中英文均可）
 * @param limit  返回条数上限
 * @param lang   'zh' → languages[]=chinese；'en' → languages[]=english；undefined 不限
 */
export async function searchZlib(
  q: string,
  limit: number,
  lang?: 'zh' | 'en',
): Promise<BookResult[]> {
  const domain = await getActiveZlibDomain();
  if (!domain) return [];

  const form = new URLSearchParams();
  form.set('message', q);
  form.set('limit', String(limit));
  form.append('extensions[]', 'epub');
  if (lang === 'zh') form.append('languages[]', 'chinese');
  else if (lang === 'en') form.append('languages[]', 'english');

  let res: Response;
  try {
    res = await fetchWithTimeout(`https://${domain}/eapi/book/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'readest-fork-booksearch/0.2',
      },
      body: form.toString(),
    });
  } catch {
    // 网络层失败：域名可能已失效，清缓存让下次重选
    invalidateZlibDomain();
    return [];
  }

  if (!res.ok) return [];
  let data: ZlibSearchResponse;
  try {
    data = (await res.json()) as ZlibSearchResponse;
  } catch {
    return [];
  }
  if (data.success !== 1 || !Array.isArray(data.books)) return [];

  const configured = isZlibConfigured();
  return data.books.slice(0, limit).map((b) => {
    // 下载走 eapi 换直链端点（免浏览器挑战），由 /api/proxy 带 cookie 解析后回源
    const file = b.hash ? `https://${domain}/eapi/book/${b.id}/${b.hash}/file` : undefined;
    const formats = file ? [{ type: 'epub', url: file, direct: true, authRequired: true }] : [];
    return {
      id: `zlibrary:${b.id}`,
      source: 'zlibrary' as const,
      sourceLabel: 'Z-Library',
      title: b.title,
      author: b.author || '未知作者',
      category: b.publisher,
      cover: b.cover,
      language: b.language,
      formats,
      // 落地页：优先 eapi 给的完整 href；拼不出用 dl 的 token 反推
      externalUrl: b.href,
      action: 'read' as const,
      note: configured
        ? 'Z-Library，可直接加入书架（消耗每日下载额度）'
        : 'Z-Library，未配置凭据，点「去 Z-Library」跳转下载',
    };
  });
}
