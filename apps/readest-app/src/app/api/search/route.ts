import { aggregateSearch } from '@/libs/booksearch/sources';

/**
 * 多书源聚合搜索 API
 *
 * GET /api/search?q=关键词&source=all|gutenberg|standardebooks|archive|zlibrary&lang=all|zh|en
 * - q       搜索词
 * - source  可选，限定书源，默认全部聚合
 * - lang    可选，语言筛选：all（默认）/ zh（中文）/ en（英文）
 *
 * Web 标准签名，Cloudflare 的 worker.ts 直接复用同一个 GET。
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const q = params.get('q') ?? '';
  const source = params.get('source') ?? undefined;
  const lang = params.get('lang') ?? undefined;

  if (!q.trim()) {
    return Response.json({ error: '缺少搜索关键词 q' }, { status: 400 });
  }

  try {
    const data = await aggregateSearch(q, source, lang);
    // 聚合结果允许 CDN/浏览器缓存 5 分钟
    return Response.json(data, { headers: { 'Cache-Control': 'public, max-age=300' } });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : '搜索服务暂时不可用' },
      { status: 502 },
    );
  }
}
