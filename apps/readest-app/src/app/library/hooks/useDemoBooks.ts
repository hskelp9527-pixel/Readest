import { useEffect, useRef, useState } from 'react';

import { useEnv } from '@/context/EnvContext';
import { Book } from '@/types/book';
import { getUserLang } from '@/utils/misc';
import { isWebAppPlatform, EnvConfigType } from '@/services/environment';
import { demoLibraries as libraries } from '@/services/demoBooks';
import { useLibraryStore } from '@/store/libraryStore';

interface DemoBooks {
  library: string[];
}

/**
 * 单本预置书的下载超时。最大的一本 7MB，实测跨境线路要 41s；超过这个时间说明连接
 * 已经不可用，交给下面那次重试比继续干等更划算。AbortSignal 也会掐断正在读的 body。
 */
const FETCH_TIMEOUT_MS = 120_000;

/** 预置书单版本号：更换书单时递增，老用户也会自动换新版 */
const PRESET_VERSION = 'v13-drop-pdf';
const PRESET_FLAG = `presetBooksFetched.${PRESET_VERSION}`;
/**
 * 已成功上架的预置书 url → hash。整批没跑完时下次进来只补缺的那几本，不重下 22MB；
 * 记 hash 是因为下面的清理要靠它认出「这是本版真书」——Book 行本身没有 url 字段。
 */
const PRESET_DONE = `presetBooksDone.${PRESET_VERSION}`;

const readDone = (): Record<string, string> => {
  try {
    const v = JSON.parse(localStorage.getItem(PRESET_DONE) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

/** 上一版演示书（Readest 官方示例），播种新书单前清理掉 */
const LEGACY_DEMO_URLS = [
  'https://cdn.readest.com/books/four-great-classics.epub',
  'https://cdn.readest.com/books/journey-to-the-west.epub',
];

/**
 * 历史占位书的书名（v2~v10 用生成的占位 epub 占坑，v11 起换成真书）。
 *
 * 这些行删不掉是书架重复的根因：老逻辑按 `url.startsWith('/books/')` 识别，但预置书是走
 * `importBook(File)` 导入的，Book 行**根本没有 url 字段**，判定恒为 false，于是每换一版
 * 书单就多堆一层。改成按书名识别，并用「不在本次导入的 hash 集合里」兜住误删——真书即使
 * 同名（《失控》《反脆弱》），也因为在新导入集合里而被保留。
 */
const PLACEHOLDER_TITLES = new Set([
  '失控',
  '人有人的用处',
  '系统之美',
  '事实',
  '理解媒介',
  '反脆弱',
  '一生的旅程',
  '千面英雄',
  '第一哲学沉思集',
  '毛泽东选集',
]);

/** 等书架数据从磁盘加载完成，避免在空 store 上执行清理/判重 */
const waitLibraryLoaded = async (timeoutMs = 10_000) => {
  const start = Date.now();
  while (!useLibraryStore.getState().libraryLoaded && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
  }
};

/** 删掉书的本地文件（不打墓碑——墓碑正是上一轮留下的脏数据来源） */
const purgeBookFiles = async (
  appService: Awaited<ReturnType<EnvConfigType['getAppService']>>,
  b: Book,
) => {
  try {
    await appService.deleteBook(b, 'purge');
  } catch (e) {
    console.warn('Failed to purge legacy book files:', b.title, e);
  }
};

/**
 * 挑出要从书架彻底移除的行：上一版官方演示书 + 历史占位书。
 * `keepHashes` 是本次导入的真书，同名也不能删。
 */
export const findStaleBooks = (library: Book[], keepHashes: Set<string>): Book[] =>
  library.filter(
    (b) =>
      (b.url && LEGACY_DEMO_URLS.includes(b.url)) ||
      b.deletedAt ||
      (PLACEHOLDER_TITLES.has(b.title.trim()) && !keepHashes.has(b.hash)),
  );

/** 返回「正在播种预置书」——书架页据此显示加载态，而不是「开启你的书库」空态 */
export const useDemoBooks = (): boolean => {
  const { envConfig } = useEnv();
  const [seeding, setSeeding] = useState(
    () => typeof window !== 'undefined' && isWebAppPlatform() && !localStorage.getItem(PRESET_FLAG),
  );
  const isLoading = useRef(false);

  useEffect(() => {
    if (isLoading.current) return;
    isLoading.current = true;

    const userLang = getUserLang() as keyof typeof libraries;
    const fetchDemoBooks = async () => {
      try {
        await waitLibraryLoaded();
        const appService = await envConfig.getAppService();

        const demoBooks = libraries[userLang] || (libraries.en as DemoBooks);
        // 单本失败重试：dev 冷启动时大文件抓取可能偶发超时，重试一次兜底
        const importOne = async (url: string, attempt = 0): Promise<Book | null> => {
          // 支持相对路径：预置书存放在 public/books/ 下，同源提供
          const absUrl = url.startsWith('/') ? `${window.location.origin}${url}` : url;
          try {
            // 直接 GET 成 File 再导入：绕过 RemoteFile 的 HEAD/Range 探测
            // （PWA Service Worker 对 Range/HEAD 请求支持不稳），URL 带版本号防旧缓存
            const bustUrl = `${absUrl}${absUrl.includes('?') ? '&' : '?'}v=${PRESET_VERSION}`;
            // 必须带超时：`Promise.allSettled` 要等全部 9 本 settle，一个僵住的连接
            // （不报错也不返回）会让整批永远不 resolve —— 书架空着、诊断字段不写、
            // PRESET_FLAG 不置位，下次进来重来一遍再卡住。最大的一本 7MB，跨境慢链
            // 也要留够余量。
            const res = await fetch(bustUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const file = new File([blob], url.split('/').pop() || 'preset.epub');
            // saveBook: true —— 把 epub 文件持久化到 OPFS/IndexedDB。
            // 之前 false 只入库元数据，点开读书时报 BookFileNotFoundError（文件找不到）。
            // 传入当前 library：importBook 靠它按 hash 复用已有条目，传 [] 会每次新建一行。
            return await appService.importBook(file, useLibraryStore.getState().library, {
              saveBook: true,
            });
          } catch (e) {
            if (attempt < 1) {
              await new Promise((r) => setTimeout(r, 1500));
              return importOne(url, attempt + 1);
            }
            throw e;
          }
        };
        const done = readDone();
        const pending = demoBooks.library.filter((url) => !done[url]);

        // 每本导入完就立刻上架，不等整批 settle：9 本 22MB 在跨境线路上要一分钟，
        // 等齐意味着这一分钟里书架是空的（正是「开启你的书库」那个空态）。
        // 提交必须排队：updateBooks 内部 await saveLibraryBooks，并发调用会让先算出的
        // 旧快照后落盘，把刚上架的书从 library.json 里抹掉。
        let queue: Promise<unknown> = Promise.resolve();
        const shelve = (book: Book, url: string) => {
          queue = queue.then(async () => {
            await useLibraryStore.getState().updateBooks(envConfig, [book]);
            done[url] = book.hash;
            localStorage.setItem(PRESET_DONE, JSON.stringify(done));
          });
          return queue;
        };

        // 临时诊断：逐本记录导入结果到 window，便于定位单本失败拖垮整批的问题
        const settled = await Promise.allSettled(
          pending.map(async (url) => {
            const book = await importOne(url);
            if (book) await shelve(book, url);
            return book;
          }),
        );
        (window as unknown as { __presetImportReport?: string[] }).__presetImportReport =
          settled.map((r, i) =>
            r.status === 'fulfilled'
              ? r.value
                ? `ok:${r.value.title}`
                : `null:${pending[i]}`
              : `err:${pending[i]}:${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
          );
        const books = settled
          .filter((r): r is PromiseFulfilledResult<Book | null> => r.status === 'fulfilled')
          .map((r) => r.value)
          .filter((book): book is Book => book !== null);
        if (books.length > 0) {
          // 导入完成后再清历史遗留：此时才知道哪些 hash 属于本版真书，
          // 同名的老占位书（《失控》《反脆弱》…）才能安全删掉。
          // 硬删除而不是打墓碑——墓碑正是上几版留下的脏数据。
          // keepHashes 取 PRESET_DONE 全量而非本次导入：续跑那次只补几本，
          // 之前几本同样是真书，只按本次导入判定会把它们当占位书误删。
          const keepHashes = new Set(Object.values(done));
          const lib = useLibraryStore.getState().library;
          const stale = findStaleBooks(lib, keepHashes);
          if (stale.length > 0) {
            const staleHashes = new Set(stale.map((b) => b.hash));
            await Promise.all(stale.map((b) => purgeBookFiles(appService, b)));
            const cleaned = lib.filter((b) => !staleHashes.has(b.hash));
            useLibraryStore.getState().setLibrary(cleaned);
            await appService.saveLibraryBooks(cleaned);
          }
        }
        // 只在整单都上架后才收工：有失败的就不置位，下次进来靠 PRESET_DONE 只补缺的那几本
        if (demoBooks.library.every((url) => done[url])) {
          localStorage.setItem(PRESET_FLAG, 'true');
        }
      } catch (error) {
        (window as unknown as { __presetError?: string }).__presetError = String(error);
        console.error('Failed to import demo books:', error);
      } finally {
        setSeeding(false);
      }
    };

    const presetFetchedFlag = localStorage.getItem(PRESET_FLAG);
    if (isWebAppPlatform() && !presetFetchedFlag) {
      fetchDemoBooks();
    } else {
      setSeeding(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return seeding;
};
