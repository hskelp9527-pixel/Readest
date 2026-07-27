import {
  getActiveZlibDomain,
  getZlibCookieHeader,
  invalidateZlibDomain,
  isZlibFileEndpoint,
  isZlibHost,
  resolveZlibFileLink,
} from '@/libs/booksearch/zlibrary';

/**
 * 限域文件代理
 *
 * GET /api/proxy?url=<encodeURIComponent(文件地址)>&filename=<可选文件名>
 *
 * 仅放行白名单域名，避免成为开放代理：
 * - *.gutenberg.org（Project Gutenberg epub/封面）
 * - *.standardebooks.org（Standard Ebooks 精校 epub/封面）
 * - *.archive.org（Internet Archive 开放获取全文/封面）
 * - *.cdn-zlib.sk（Z-Library 封面，免登录）
 * - Z-Library 活跃域名（epub 下载，需 cookie 凭据，未配置时返回 401）
 *
 * Web 标准签名，Cloudflare 的 worker.ts 直接复用同一个 GET。
 */

const ALLOWED_HOSTS = ['gutenberg.org', 'standardebooks.org', 'archive.org'];
const MAX_BYTES = 80 * 1024 * 1024; // 80MB 上限
const FETCH_TIMEOUT_MS = 30_000;

function isCdnZlibCover(host: string): boolean {
  // Z-Library 封面 CDN：s3proxy-*-covers.cdn-zlib.sk 等，免登录
  return host.endsWith('.cdn-zlib.sk');
}

async function isAllowed(url: URL): Promise<boolean> {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (ALLOWED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  if (isCdnZlibCover(host)) return true;
  // Z-Library 活跃域名（动态）+ 内置兜底域名
  if (isZlibHost(host)) return true;
  // 兜底：再触发一次域名发现，确保 getActiveZlibDomain 缓存已填充后重判
  const active = await getActiveZlibDomain();
  return !!active && (host === active || host.endsWith(`.${active}`));
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const raw = params.get('url') ?? '';
  const filename = params.get('filename')?.slice(0, 120) ?? '';

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return Response.json({ error: '非法的 url 参数' }, { status: 400 });
  }
  let host = target.hostname.toLowerCase();

  if (!(await isAllowed(target))) {
    return Response.json({ error: '该域名不在允许列表中' }, { status: 403 });
  }

  // Z-Library epub 下载需登录 cookie；封面 CDN 免登录
  let cookieHeader: string | null = null;
  if (isZlibHost(host)) {
    cookieHeader = getZlibCookieHeader();
    if (!cookieHeader) {
      return Response.json(
        { error: 'Z-Library 凭据未配置（需设置 ZLIB_REMIX_USERID / ZLIB_REMIX_USERKEY）' },
        { status: 401 },
      );
    }
    // eapi 换链端点：先拿一次性 CDN 直链，再按普通文件下载（CDN 不需要 cookie）
    if (isZlibFileEndpoint(target.pathname)) {
      const resolved = await resolveZlibFileLink(target.toString());
      if ('error' in resolved) {
        return Response.json({ error: resolved.error }, { status: 502 });
      }
      try {
        target = new URL(resolved.link);
      } catch {
        return Response.json({ error: 'Z-Library 返回的下载链接无效' }, { status: 502 });
      }
      // 之后按 CDN 主机处理：不带 cookie，也不再走 zlib 的 401/403 域名失效判定
      host = target.hostname.toLowerCase();
      cookieHeader = null;
    }
  }

  try {
    const headers: Record<string, string> = { 'User-Agent': 'readest-fork-booksearch/0.1' };
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    const upstream = await fetch(target.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers,
    });
    // Z-Library 401/403：域名/凭据可能失效，清域名缓存让下次搜索重选
    if (isZlibHost(host) && (upstream.status === 401 || upstream.status === 403)) {
      invalidateZlibDomain();
      return Response.json(
        { error: `Z-Library 拒绝访问（${upstream.status}），凭据可能失效或域名已更换` },
        { status: 502 },
      );
    }
    if (!upstream.ok || !upstream.body) {
      return Response.json({ error: `源站返回 ${upstream.status}` }, { status: 502 });
    }

    const length = Number(upstream.headers.get('content-length') || 0);
    if (length > MAX_BYTES) {
      return Response.json({ error: '文件超过大小限制' }, { status: 413 });
    }

    const outHeaders = new Headers({
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
    });
    if (length > 0) outHeaders.set('Content-Length', String(length));
    if (filename) {
      const encoded = encodeURIComponent(filename).replace(/'/g, '%27');
      outHeaders.set(
        'Content-Disposition',
        `attachment; filename="download"; filename*=UTF-8''${encoded}`,
      );
    }

    // 流式透传：Worker 只有 128MB 内存，不能把 80MB 的 epub 整个读进 Buffer。
    // 没有 content-length 的源站靠这里的计数兜住上限。
    let seen = 0;
    const capped = upstream.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > MAX_BYTES) {
            controller.error(new Error('文件超过大小限制'));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(capped, { headers: outHeaders });
  } catch (e) {
    const aborted = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return Response.json(
      { error: aborted ? '源站响应超时' : '代理下载失败' },
      { status: aborted ? 504 : 502 },
    );
  }
}
