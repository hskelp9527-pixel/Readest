import { describe, test, expect } from 'vitest';

import { Book } from '@/types/book';
import { findStaleBooks } from '@/app/library/hooks/useDemoBooks';
import { queryVariants } from '@/libs/booksearch/sources';

const book = (over: Partial<Book>): Book =>
  ({ hash: 'h', title: 't', author: 'a', format: 'EPUB', ...over }) as Book;

describe('findStaleBooks（书架重复的根因）', () => {
  test('同名的历史占位书要删，本次导入的真书要留', () => {
    const real = book({ hash: 'new1', title: '失控' });
    const placeholder = book({ hash: 'old1', title: '失控' });
    const stale = findStaleBooks([real, placeholder], new Set(['new1']));
    expect(stale).toEqual([placeholder]);
  });

  test('用户自己的书不受影响', () => {
    const mine = book({ hash: 'mine', title: 'Meditations' });
    expect(findStaleBooks([mine], new Set(['new1']))).toEqual([]);
  });

  test('墓碑与上一版官方演示书一并清掉', () => {
    const tomb = book({ hash: 'x', title: '随便', deletedAt: Date.now() });
    const legacyDemo = book({
      hash: 'y',
      title: 'Journey',
      url: 'https://cdn.readest.com/books/journey-to-the-west.epub',
    });
    expect(findStaleBooks([tomb, legacyDemo], new Set())).toHaveLength(2);
  });
});

describe('queryVariants（公版源的中文书多为繁体入库）', () => {
  test('简体查询额外带出繁体变体', () => {
    expect(queryVariants('红楼梦')).toEqual(['红楼梦', '紅樓夢']);
  });

  test('英文与本就是繁体的查询不重复发请求', () => {
    expect(queryVariants('Antifragile')).toEqual(['Antifragile']);
    expect(queryVariants('紅樓夢')).toEqual(['紅樓夢']);
  });
});
