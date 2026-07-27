import { GET as searchGET } from './src/app/api/search/route';
import { GET as proxyGET } from './src/app/api/proxy/route';

/**
 * Cloudflare Workers entry point.
 *
 * The web app is deployed as a static export (`EXPORT_STATIC=true next build`)
 * served from Workers Static Assets, because the OpenNext server bundle is
 * ~6.5 MiB gzipped and the free plan caps Worker code at 3 MiB. Only the two
 * routes that genuinely need a server live here; they are the same Web-standard
 * `GET` handlers Next serves at `/api/search` and `/api/proxy` in dev.
 *
 * Everything else falls through to the static assets.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const routes: Record<string, (request: Request) => Promise<Response>> = {
  '/api/search': searchGET,
  '/api/proxy': proxyGET,
};

/**
 * `next.config.mjs` declares these as `rewrites()`, which a static export cannot
 * apply ("rewrites will not automatically work with output: export"). Without
 * them `/reader/<ids>` 404s, because the pages-router `[ids]` route exports to a
 * literal `reader/[ids].html`. The pages below already recover the parameter
 * from the path (`ReaderContent` reads `pathname.split('/reader/')[1]`), so
 * serving the parameterless page is enough.
 */
const REWRITES: [RegExp, string][] = [
  [/^\/reader\/[^/]+$/, '/reader'],
  [/^\/o\/book\/[^/]+\/annotation\/[^/]+$/, '/o'],
  [/^\/s\/[^/]+$/, '/s'],
];

/**
 * The reader's CJK stylesheets live on storage.readest.com, which only sends
 * `Access-Control-Allow-Origin` for readest.com origins — from here they fail
 * CORS and those fonts vanish. Reverse-proxy them under our own origin so no
 * CORS is involved. The prefix is fixed, so this is not an open proxy, and the
 * `url("./x.woff2")` references inside each stylesheet are relative and resolve
 * back through the same prefix.
 */
const FONT_PREFIX = '/fonts/readest/';
const FONT_UPSTREAM = 'https://storage.readest.com/public/font/dist/';

async function proxyFont(pathname: string): Promise<Response> {
  const upstream = await fetch(FONT_UPSTREAM + pathname.slice(FONT_PREFIX.length));
  if (!upstream.ok) return new Response('Not Found', { status: 404 });
  const headers = new Headers(upstream.headers);
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(upstream.body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(FONT_PREFIX)) return proxyFont(url.pathname);

    const handler = routes[url.pathname];
    if (handler) {
      if (request.method !== 'GET') {
        return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
      }
      return handler(request);
    }

    const rewrite = REWRITES.find(([pattern]) => pattern.test(url.pathname));
    if (rewrite) {
      url.pathname = rewrite[1];
      return env.ASSETS.fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  },
};
