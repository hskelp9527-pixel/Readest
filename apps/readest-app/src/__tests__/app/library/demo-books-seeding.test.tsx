import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import type { Book } from '@/types/book';

/**
 * 预置书播种：9 本 22MB 的 epub 在跨境线路上要一分钟。等整批 settle 再上架，
 * 意味着这一分钟里书架是空的——访客看到的是「开启你的书库」导入引导，
 * 而这个 fork 的书架本来就不该是空的。
 *
 * 所以两条不变量：单本导入完就上架；整单没跑完就不置 PRESET_FLAG，
 * 下次进来只补缺的那几本，不重下 22MB。
 */

const URL_A = '/books/a.epub';
const URL_B = '/books/b.epub';
const PRESET_FLAG = 'presetBooksFetched.v13-drop-pdf';
const PRESET_DONE = 'presetBooksDone.v13-drop-pdf';

const appService = vi.hoisted(() => ({
  importBook: vi.fn(async (file: File) => ({
    hash: file.name,
    title: file.name,
    author: 'A',
    format: 'EPUB',
    createdAt: 1,
    updatedAt: 1,
  })),
  saveLibraryBooks: vi.fn(async () => {}),
  loadLibraryBooks: vi.fn(async () => []),
  deleteBook: vi.fn(async () => {}),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: { getAppService: async () => appService } }),
}));

vi.mock(import('@/services/environment'), async (importOriginal) => ({
  ...(await importOriginal()),
  isWebAppPlatform: () => true,
}));

vi.mock('@/services/demoBooks', () => ({
  demoLibraries: { en: { library: [URL_A, URL_B] }, zh: { library: [URL_A, URL_B] } },
}));

const { useDemoBooks } = await import('@/app/library/hooks/useDemoBooks');
const { useLibraryStore } = await import('@/store/libraryStore');

/** 让 b.epub 的下载挂着，模拟一本慢书拖住整批 */
let releaseB: () => void = () => {};
let bHang: Promise<void>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useLibraryStore.setState({ library: [], libraryLoaded: true });
  bHang = new Promise<void>((r) => {
    releaseB = r;
  });
  const blob = new Blob(['epub']);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('b.epub')) await bHang;
      return { ok: true, status: 200, blob: async () => blob } as unknown as Response;
    }),
  );
});

const titles = () => useLibraryStore.getState().library.map((b) => b.title);

describe('预置书播种', () => {
  it('单本导入完就上架，不等慢的那本', async () => {
    renderHook(() => useDemoBooks());

    await waitFor(() => expect(titles()).toEqual(['a.epub']));
    expect(localStorage.getItem(PRESET_FLAG)).toBeNull();

    releaseB();
    await waitFor(() => expect(titles()).toEqual(['a.epub', 'b.epub']));
    await waitFor(() => expect(localStorage.getItem(PRESET_FLAG)).toBe('true'));
  });

  it('续跑只补缺的那本', async () => {
    localStorage.setItem(PRESET_DONE, JSON.stringify({ [URL_A]: 'a.epub' }));
    useLibraryStore.setState({
      library: [{ hash: 'a.epub', title: 'a.epub', author: 'A', format: 'EPUB' } as Book],
    });

    const { result } = renderHook(() => useDemoBooks());
    expect(result.current).toBe(true);

    releaseB();
    await waitFor(() => expect(localStorage.getItem(PRESET_FLAG)).toBe('true'));
    const fetched = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls.map(
      (c) => c[0]!,
    );
    expect(fetched.some((u) => u.includes('a.epub'))).toBe(false);
    expect(fetched.some((u) => u.includes('b.epub'))).toBe(true);
    await waitFor(() => expect(result.current).toBe(false));
  });
});
