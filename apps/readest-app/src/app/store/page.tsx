'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import MobileTabBar from '@/components/MobileTabBar';

/* 与「暖阳」主题一致的设计 token */
const C = {
  bg: '#F7F3EC',
  card: '#FFFDF8',
  ink: '#3E3833',
  inkDim: '#96897B',
  brand: '#D97757',
  brandSoft: '#F6E3D9',
  green: '#7A9E7E',
  line: '#E8E1D5',
};

interface BookFormat {
  type: string;
  url: string;
  direct: boolean;
  authRequired?: boolean;
}
interface BookResult {
  id: string;
  source: 'gutenberg' | 'standardebooks' | 'archive' | 'zlibrary';
  sourceLabel: string;
  title: string;
  author: string;
  category?: string;
  cover?: string;
  language?: string;
  downloads?: number;
  formats: BookFormat[];
  action: 'read';
  note?: string;
  externalUrl?: string;
}
interface ZlibQuota {
  configured: boolean;
  downloadsToday?: number;
  downloadsLimit?: number;
}
interface SearchResponse {
  query: string;
  total: number;
  sources: Record<string, { ok: boolean; count: number; error?: string }>;
  results: BookResult[];
  zlibConfigured?: boolean;
  zlibQuota?: ZlibQuota;
}

const SOURCE_TABS = [
  { id: 'all', label: '全部书源' },
  { id: 'gutenberg', label: 'Gutenberg' },
  { id: 'standardebooks', label: 'Standard Ebooks' },
  { id: 'archive', label: 'Internet Archive' },
  { id: 'zlibrary', label: 'Z-Library' },
] as const;

/** 结果排序：公版直读源在前，Z-Library 兜底在后 */
const SOURCE_RANK: Record<string, number> = {
  gutenberg: 0,
  standardebooks: 1,
  archive: 2,
  zlibrary: 3,
};

const dedupeKey = (b: BookResult) => `${b.title}|${b.author}`.toLowerCase().replace(/\s+/g, '');

/** 把单个书源的返回并进已有结果（跨源按「书名+作者」去重，再按源优先级/下载量排序） */
function mergeSearch(
  prev: SearchResponse | null,
  query: string,
  part: SearchResponse,
): SearchResponse {
  const base = prev && prev.query === query ? prev : { query, total: 0, sources: {}, results: [] };
  const seen = new Set(base.results.map(dedupeKey));
  const results = [...base.results];
  for (const r of part.results) {
    if (seen.has(dedupeKey(r))) continue;
    seen.add(dedupeKey(r));
    results.push(r);
  }
  results.sort(
    (a, b) =>
      (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9) ||
      (b.downloads ?? 0) - (a.downloads ?? 0),
  );
  return {
    query,
    total: results.length,
    sources: { ...base.sources, ...part.sources },
    results,
    zlibConfigured: part.zlibConfigured ?? base.zlibConfigured,
    zlibQuota: part.zlibQuota ?? base.zlibQuota,
  };
}

const LANG_TABS = [
  { id: 'all', label: '全部' },
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
] as const;

/** 书房精选：预置书单，点击即搜。公版源优先；现代版权书可切到 Z-Library 书源查找。 */
const CURATED: Array<{ title: string; author: string; query: string; tip?: string }> = [
  {
    title: '失控',
    author: '凯文·凯利',
    query: '失控 Out of Control',
    tip: '切 Z-Library 可找中译',
  },
  {
    title: '人有人的用处',
    author: '诺伯特·维纳',
    query: 'Human Use of Human Beings',
    tip: '切 Z-Library 可找中译',
  },
  {
    title: '系统之美',
    author: '德内拉·梅多斯',
    query: 'Thinking in Systems',
    tip: '切 Z-Library 可找中译',
  },
  { title: '事实', author: '汉斯·罗斯林', query: 'Factfulness', tip: '切 Z-Library 可找中译' },
  {
    title: '理解媒介',
    author: '麦克卢汉',
    query: 'Understanding Media',
    tip: '切 Z-Library 可找中译',
  },
  { title: '反脆弱', author: '塔勒布', query: 'Antifragile', tip: '切 Z-Library 可找中译' },
  {
    title: '一生的旅程',
    author: '罗伯特·艾格',
    query: 'Ride of a Lifetime',
    tip: '切 Z-Library 可找中译',
  },
  {
    title: '千面英雄',
    author: '约瑟夫·坎贝尔',
    query: 'The Hero with a Thousand Faces',
    tip: '切 Z-Library 可找中译',
  },
  {
    title: '第一哲学沉思集',
    author: '笛卡尔',
    query: 'Meditations on First Philosophy',
    tip: '公版书，可直读',
  },
  {
    title: '毛泽东选集',
    author: '毛泽东',
    query: '毛泽东 Selected Works Mao',
    tip: '可尝试 Archive 开放文本',
  },
];

const styles = {
  page: {
    minHeight: '100vh',
    background: C.bg,
    color: C.ink,
    fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  wrap: { maxWidth: 880, margin: '0 auto', padding: '0 20px 96px' },
  header: { display: 'flex', alignItems: 'center', gap: 12, padding: '20px 0 8px' },
  backBtn: {
    border: `1px solid ${C.line}`,
    background: C.card,
    color: C.ink,
    borderRadius: 999,
    padding: '6px 14px',
    fontSize: 14,
    cursor: 'pointer',
  },
  title: { fontSize: 20, fontWeight: 600, letterSpacing: 1 },
  searchRow: { display: 'flex', gap: 10, marginTop: 14 },
  input: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    border: `1px solid ${C.line}`,
    background: C.card,
    padding: '0 16px',
    fontSize: 15,
    color: C.ink,
    outline: 'none',
  },
  searchBtn: {
    height: 46,
    padding: '0 22px',
    borderRadius: 14,
    border: 'none',
    background: C.brand,
    color: '#FFFDF8',
    fontSize: 15,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  tabs: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  tab: {
    border: `1px solid ${C.line}`,
    background: 'transparent',
    color: C.inkDim,
    borderRadius: 999,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
  },
  tabActive: { background: C.brandSoft, color: C.brand, borderColor: C.brand, fontWeight: 600 },
  status: { fontSize: 12, color: C.inkDim, marginTop: 10 },
  sectionTitle: { fontSize: 15, fontWeight: 600, margin: '26px 0 12px', color: C.ink },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 },
  curatedCard: {
    background: C.card,
    border: `1px solid ${C.line}`,
    borderRadius: 14,
    padding: '14px 12px',
    cursor: 'pointer',
    textAlign: 'left',
  },
  curatedTitle: { fontSize: 14, fontWeight: 600, color: C.ink, lineHeight: 1.4 },
  curatedAuthor: { fontSize: 12, color: C.inkDim, marginTop: 4 },
  curatedTip: { fontSize: 11, color: C.brand, marginTop: 6 },
  resultCard: {
    display: 'flex',
    gap: 14,
    background: C.card,
    border: `1px solid ${C.line}`,
    borderRadius: 16,
    padding: 14,
    marginTop: 12,
  },
  cover: {
    width: 64,
    height: 88,
    borderRadius: 8,
    objectFit: 'cover',
    background: C.brandSoft,
    flexShrink: 0,
  },
  coverPlaceholder: {
    width: 64,
    height: 88,
    borderRadius: 8,
    background: C.brandSoft,
    color: C.brand,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    flexShrink: 0,
  },
  rTitle: { fontSize: 15, fontWeight: 600, lineHeight: 1.4 },
  rMeta: { fontSize: 12, color: C.inkDim, marginTop: 4, lineHeight: 1.6 },
  badge: {
    display: 'inline-block',
    fontSize: 11,
    borderRadius: 6,
    padding: '1px 8px',
    marginRight: 6,
    background: C.brandSoft,
    color: C.brand,
  },
  badgeGreen: {
    display: 'inline-block',
    fontSize: 11,
    borderRadius: 6,
    padding: '1px 8px',
    marginRight: 6,
    background: '#E6EFE7',
    color: C.green,
  },
  badgeWarn: {
    display: 'inline-block',
    fontSize: 11,
    borderRadius: 6,
    padding: '1px 8px',
    marginRight: 6,
    background: '#F4EAD2',
    color: '#B07A2B',
  },
  badgeRed: {
    display: 'inline-block',
    fontSize: 11,
    borderRadius: 6,
    padding: '1px 8px',
    marginRight: 6,
    background: '#F3D9D2',
    color: '#B5483A',
  },
  quotaRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    marginTop: 10,
    fontSize: 12,
    flexWrap: 'wrap',
  },
  langRow: {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    marginTop: 14,
    flexWrap: 'wrap',
    fontSize: 13,
    color: C.inkDim,
  },
  langTabs: { display: 'flex', gap: 6 },
  rActions: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  actionBtn: {
    fontSize: 13,
    borderRadius: 999,
    padding: '6px 14px',
    border: 'none',
    background: C.brand,
    color: '#FFFDF8',
    cursor: 'pointer',
    textDecoration: 'none',
  },
  actionBtnGhost: {
    fontSize: 13,
    borderRadius: 999,
    padding: '6px 14px',
    border: `1px solid ${C.line}`,
    background: 'transparent',
    color: C.ink,
    cursor: 'pointer',
    textDecoration: 'none',
  },
  empty: { textAlign: 'center', color: C.inkDim, fontSize: 14, marginTop: 48 },
} satisfies Record<string, React.CSSProperties>;

export default function StorePage() {
  const router = useRouter();
  const { envConfig } = useEnv();
  const [q, setQ] = useState('');
  const [source, setSource] = useState<string>('all');
  const [lang, setLang] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState('');
  const [addState, setAddState] = useState<Record<string, 'adding' | 'done' | 'error'>>({});
  const [addError, setAddError] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  /** 每次检索递增，用于丢弃过期请求的回包（切源/连点时） */
  const searchIdRef = useRef(0);

  /** 直链 epub 一键入库：经本站代理取回文件后直接导入书架 */
  const addToShelf = useCallback(
    async (b: BookResult, epub: BookFormat) => {
      setAddState((m) => ({ ...m, [b.id]: 'adding' }));
      try {
        const appService = await envConfig.getAppService();
        const res = await fetch(`/api/proxy?url=${encodeURIComponent(epub.url)}`);
        if (!res.ok) {
          // 服务端的失败原因（额度用完、凭据失效…）比一句「加入失败」有用
          const reason = await res
            .json()
            .then((j: { error?: string }) => j.error)
            .catch(() => '');
          throw new Error(reason || `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const file = new File([blob], `${b.title}.epub`, { type: 'application/epub+zip' });
        const { library } = useLibraryStore.getState();
        const book = await appService.importBook(file, library, { saveBook: true });
        if (!book) throw new Error('import failed');
        // 与书架页导入流程一致：入库后还需更新 store 并持久化 library.json
        await useLibraryStore.getState().updateBooks(envConfig, [book]);
        await appService.saveLibraryBooks(useLibraryStore.getState().library);
        setAddState((m) => ({ ...m, [b.id]: 'done' }));
      } catch (e) {
        console.error('addToShelf failed:', e);
        setAddState((m) => ({ ...m, [b.id]: 'error' }));
        setAddError((m) => ({ ...m, [b.id]: e instanceof Error ? e.message : '加入失败' }));
      }
    },
    [envConfig],
  );

  /**
   * 检索：每个书源各发一个请求，谁先回谁先渲染。
   * 以前是一次 source=all 的聚合请求，最慢的源（本机访问不到 archive.org）决定整体等待，
   * 快源的结果白白陪跑十几秒。
   */
  const doSearch = useCallback(async (keyword: string, src: string, lg: string) => {
    const query = keyword.trim();
    if (!query) return;
    const runId = ++searchIdRef.current;
    const sources =
      src === 'all' ? SOURCE_TABS.filter((t) => t.id !== 'all').map((t) => t.id) : [src];

    setLoading(true);
    setError('');
    setData({ query, total: 0, sources: {}, results: [] });

    await Promise.all(
      sources.map(async (s) => {
        try {
          const res = await fetch(
            `/api/search?q=${encodeURIComponent(query)}&source=${s}&lang=${lg}`,
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const part = (await res.json()) as SearchResponse;
          if (runId !== searchIdRef.current) return; // 已被新的检索取代
          setData((prev) => mergeSearch(prev, query, part));
        } catch (e) {
          if (runId !== searchIdRef.current) return;
          setData((prev) =>
            mergeSearch(prev, query, {
              query,
              total: 0,
              sources: { [s]: { ok: false, count: 0, error: String(e) } },
              results: [],
            }),
          );
        }
      }),
    );
    if (runId === searchIdRef.current) setLoading(false);
  }, []);

  // 切书源或语言时若有结果则重搜
  useEffect(() => {
    if (data) doSearch(q, source, lang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, lang]);

  const epubOf = (b: BookResult) => b.formats.find((f) => f.type === 'epub' && f.direct);

  /** Z-Library 今日下载额度是否已用完（用于禁用「加入书架」按钮） */
  const quotaExhausted =
    !!data?.zlibQuota &&
    data.zlibQuota.configured &&
    typeof data.zlibQuota.downloadsToday === 'number' &&
    typeof data.zlibQuota.downloadsLimit === 'number' &&
    data.zlibQuota.downloadsToday >= data.zlibQuota.downloadsLimit;
  const quotaRemaining =
    data?.zlibQuota && typeof data.zlibQuota.downloadsLimit === 'number'
      ? (data.zlibQuota.downloadsLimit ?? 0) - (data.zlibQuota.downloadsToday ?? 0)
      : undefined;

  return (
    <div style={styles.page}>
      <div style={styles.wrap}>
        <div style={styles.header}>
          <button style={styles.backBtn} onClick={() => router.push('/library')}>
            ← 书架
          </button>
          <div style={styles.title}>找书</div>
        </div>

        <form
          style={styles.searchRow}
          onSubmit={(e) => {
            e.preventDefault();
            doSearch(q, source, lang);
          }}
        >
          <input
            ref={inputRef}
            style={styles.input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder='搜索书名、作者（中英文均可）'
          />
          <button type='submit' style={styles.searchBtn} disabled={loading}>
            {loading ? '搜索中…' : '搜索'}
          </button>
        </form>

        <div style={styles.tabs}>
          {SOURCE_TABS.map((t) => (
            <button
              key={t.id}
              style={{ ...styles.tab, ...(source === t.id ? styles.tabActive : {}) }}
              onClick={() => setSource(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={styles.langRow}>
          <span>语言</span>
          <div style={styles.langTabs}>
            {LANG_TABS.map((t) => (
              <button
                key={t.id}
                style={{ ...styles.tab, ...(lang === t.id ? styles.tabActive : {}) }}
                onClick={() => setLang(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {data && (
          <div style={styles.status}>
            共 {data.total} 条结果 ·{' '}
            {Object.entries(data.sources)
              .map(([k, v]) => `${k}${v.ok ? ` ${v.count} 条` : ' 不可用'}`)
              .join(' · ')}
          </div>
        )}
        {data?.zlibQuota?.configured && typeof quotaRemaining === 'number' && (
          <div style={styles.quotaRow}>
            <span style={quotaExhausted ? styles.badgeRed : styles.badgeWarn}>
              Z-Library 今日下载
            </span>
            <span style={{ color: quotaExhausted ? '#B5483A' : C.inkDim }}>
              {quotaExhausted
                ? `今日下载额度已用完（${data.zlibQuota.downloadsToday}/${data.zlibQuota.downloadsLimit}），次日重置。可改用公版源。`
                : `Z-Library 加入书架会消耗额度：今日剩 ${quotaRemaining} / ${data.zlibQuota.downloadsLimit} 次`}
            </span>
          </div>
        )}
        {error && <div style={{ ...styles.status, color: C.brand }}>⚠ {error}</div>}

        {!data && !loading && (
          <>
            <div style={styles.sectionTitle}>书房精选 · 点击即搜</div>
            <div style={styles.grid}>
              {CURATED.map((b) => (
                <button
                  key={b.title}
                  style={styles.curatedCard}
                  onClick={() => {
                    setQ(b.query);
                    doSearch(b.query, source, lang);
                  }}
                >
                  <div style={styles.curatedTitle}>《{b.title}》</div>
                  <div style={styles.curatedAuthor}>{b.author}</div>
                  {b.tip && <div style={styles.curatedTip}>{b.tip}</div>}
                </button>
              ))}
            </div>
          </>
        )}

        {loading && <div style={styles.status}>正在检索其余书源…</div>}

        {!loading && data && data.results.length === 0 && (
          <div style={styles.empty}>没有找到相关书籍，换个关键词或切换书源试试</div>
        )}

        {data?.results.map((b) => {
          const epub = epubOf(b);
          // Z-Library：配了凭据就能服务端换直链入库（走 /api/proxy），否则降级为跳转下载
          const isZlib = !!epub?.authRequired;
          const canRead = !!epub && (!isZlib || (!!data.zlibConfigured && !quotaExhausted));
          const showJump = isZlib && !!b.externalUrl && !canRead;
          return (
            <div key={b.id} style={styles.resultCard}>
              {b.cover ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/proxy?url=${encodeURIComponent(b.cover)}`}
                  alt=''
                  style={styles.cover}
                  loading='lazy'
                />
              ) : (
                <div style={styles.coverPlaceholder}>书</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.rTitle}>{b.title}</div>
                <div style={styles.rMeta}>
                  {b.author}
                  {b.category ? ` · ${b.category}` : ''}
                </div>
                <div style={{ marginTop: 6 }}>
                  {canRead && !isZlib ? (
                    <span style={styles.badgeGreen}>epub 直链 · 可直读</span>
                  ) : canRead && isZlib ? (
                    <span style={styles.badgeWarn}>可加入书架 · 消耗 1 次额度</span>
                  ) : isZlib && quotaExhausted ? (
                    <span style={styles.badgeRed}>额度已用完 · 跳转下载</span>
                  ) : (
                    <span style={styles.badgeWarn}>Z-Library · 跳转下载</span>
                  )}
                  <span style={styles.badge}>{b.sourceLabel}</span>
                  {b.language && <span style={styles.badge}>{b.language}</span>}
                </div>
                {b.note && <div style={styles.rMeta}>{b.note}</div>}
                {addState[b.id] === 'error' && addError[b.id] && (
                  <div style={{ ...styles.rMeta, color: '#B5483A' }}>⚠ {addError[b.id]}</div>
                )}
                <div style={styles.rActions}>
                  {canRead && addState[b.id] !== 'done' && (
                    <button
                      style={styles.actionBtn}
                      disabled={addState[b.id] === 'adding'}
                      onClick={() => epub && addToShelf(b, epub)}
                    >
                      {addState[b.id] === 'adding'
                        ? '加入中…'
                        : addState[b.id] === 'error'
                          ? '加入失败，重试'
                          : '加入书架'}
                    </button>
                  )}
                  {canRead && addState[b.id] === 'done' && (
                    <a style={styles.actionBtn} href='/library'>
                      已在书架，去阅读 →
                    </a>
                  )}
                  {(showJump || (isZlib && b.externalUrl)) && (
                    <a
                      style={showJump ? styles.actionBtn : styles.actionBtnGhost}
                      href={b.externalUrl}
                      target='_blank'
                      rel='noopener noreferrer'
                    >
                      去 Z-Library →
                    </a>
                  )}
                  {epub && !isZlib && (
                    <a
                      style={styles.actionBtnGhost}
                      href={`/api/proxy?url=${encodeURIComponent(epub.url)}&filename=${encodeURIComponent(`${b.title}.epub`)}`}
                    >
                      下载 EPUB
                    </a>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {!loading && data && data.results.length > 0 && (
          <div style={{ ...styles.empty, marginTop: 24 }}>
            点「加入书架」即可直接阅读；Z-Library 每加入一本消耗一次每日下载额度
          </div>
        )}
      </div>
      <MobileTabBar />
    </div>
  );
}
