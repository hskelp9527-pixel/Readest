---
name: cf-free-plan-static-export-deploy
description: Deploying this fork to a Cloudflare free-plan account; Windows symlink
metadata:
  node_type: memory
  type: project
---

Deploying the fork to a **free-plan** Cloudflare account (`readest-airainyu`, custom domain `readest.airainyu.xyz`). Two independent blockers, both now solved.

## 1. Windows: esbuild "Cannot read directory ...: Access is denied"

`opennextjs-cloudflare build` died with 66 of these, all under `.open-next/server-functions/default/node_modules/.pnpm/<pkg>/node_modules/<dep>`.

**Root cause (non-obvious):** those are pnpm's node_modules symlinks, and on Windows they were created as **file-type** symlinks pointing at directories (`Get-Item` shows `Archive, ReparsePoint` instead of `Directory, ReparsePoint`). Win32 directory enumeration rejects that with ACCESS_DENIED, which esbuild (Go `os.ReadDir`) reports as "Cannot read directory". They are **not dangling** — `find -xtype l` finds nothing and Git Bash `[ -d ]` says DIR, because MSYS follows the link through POSIX emulation. That is what makes this look like a broken-link problem when it isn't.

Origin is `copyTracedFiles.js` calling `symlinkSync(target, to)` with no type (Next's standalone writer does the same, mirroring `next/src/build/utils.ts`). Fixed in `patches/@opennextjs__aws@4.0.2.patch`: create a **junction** when the target is a directory. Two gotchas the patch encodes:
- junctions need an **absolute** target and Node resolves a relative one against `cwd`, not against the link's own directory — must `path.resolve(path.dirname(to), symlink)`.
- **`statSync(from)` cannot be used to test dir-ness**: `from` is the standalone copy, which has the same broken link type, so it throws EPERM. Stat `path.resolve(path.dirname(from), symlink)` instead.

A `--import` shim patching `fs.symlinkSync` does **not** work: `import { symlinkSync } from "node:fs"` is a stale ESM binding, unaffected by monkeypatching the module object.

## 2. Free plan caps Worker code at 3 MiB compressed

OpenNext's server bundle is **6.53 MiB gzipped** (25 MiB raw). No single dependency to cut — `@aws-sdk`, `opencc-js`, `franc` are not even in the bundle (1 grep hit each); the weight is the app's own SSR code spread across ~50 chunks of ~0.3 MB. Paid plan (10 MiB) would fit; the free-plan answer is to stop shipping a server.

**Shipped: static export + a tiny API Worker.**
- `next.config.mjs`: `EXPORT_STATIC=true` opts the *web* platform into `output: 'export'` (previously only non-web/Tauri did). `productionBrowserSourceMaps` stays off for web.
- `pageExtensions: ['jsx','tsx']` in export mode already drops every `.ts` route handler, so API routes vanish from the static build for free.
- `/api/search` and `/api/proxy` moved from `src/pages/api/*.ts` to **app-router** `src/app/api/*/route.ts` — Web-standard `GET(Request)`, so `worker.ts` imports the very same function. No adapter layer, no duplicated logic. Wrangler's esbuild resolves the `@/*` tsconfig path natively.
- `worker.ts` routes those two paths and falls through to `env.ASSETS.fetch(request)`. wrangler.toml: `main = "worker.ts"`, `[assets] directory = "out"`, `not_found_handling = "404-page"`.
- Result: **503 KiB gzip** worker + 788 static assets. `pnpm deploy` = `pnpm build-cf && wrangler deploy`.
- Proxy streams the upstream body through a byte-counting `TransformStream` instead of `Buffer.from(await arrayBuffer())` — a Worker has 128 MB memory and the cap is 80 MB.

## 3. `rewrites()` don't survive the export — books 404 on open

`next.config.mjs` declares three `rewrites()` (`/reader/:ids`, `/o/book/:hash/annotation/:id`, `/s/:token`). The build warns "rewrites will not automatically work with output: export" and it is not cosmetic: `navigateToReader` (`utils/nav.ts`) pushes the pretty `/reader/<ids>` on web-non-PWA, and the pages-router `[ids]` route exports to a **literal `out/reader/[ids].html`**, so every book open 404'd.

Reimplemented as a `REWRITES` table in `worker.ts`, which keeps external deep links working and fixes `/s/:token` and `/o/...` in the same six lines. The pages already recover the parameter from the path (`ReaderContent` reads `pathname.split('/reader/')[1]`), so serving the parameterless page is enough. The serwist SW is NetworkFirst for `/reader*` navigations, so it goes to the network and picks the rewrite up.

**The worker rewrite alone is not enough, and this is the part that looks fixed but isn't.** It only covers *document* requests. In-app clicks go through the client router, and `/reader/<ids>` is a **pages-router** route being pushed from an **app-router** page: the app router can't resolve it, so in a static export it fetches the segment file `/reader/<ids>/__next._index.txt`, gets a 404, and falls back to a full page reload (the tell is `Language changed to zh-CN` logging twice). Segment files live at `/<route>/__next.*.txt`, so no single-segment rewrite can cover them. Fixed properly in `nav.ts`: under `NEXT_PUBLIC_EXPORT_STATIC` push the app router's own `/reader?ids=` instead. The dead `/reader/${ids}` branch then folds away at build time — grep the chunks for `` `/reader `` to confirm only the query form survives.

Debugging note: verifying this with `curl` is misleading, because the *document* URL returns 200 the whole time. The 404 is a different URL than the one the console prints.

**Verification trap:** after deploying the fix, `curl` still returned 404 for some paths and 200 for others, seemingly at random. It was the edge cache holding the pre-fix 404s (`CF-Cache-Status: HIT`); a `?cb=<random>` buster returned 200 every time. The assets carry `max-age=0, must-revalidate` so it cleared within minutes. The deploy token has no cache-purge permission — don't waste time on the purge API.

## Windows: `pnpm` runs scripts through cmd.exe

POSIX `VAR=value cmd` prefixes in package.json scripts fail here ("'NEXT_PUBLIC_EXPORT_STATIC' 不是内部或外部命令"). Upstream scripts use that syntax freely, so any new one needs another mechanism — `build-cf` puts the flag in `.env.cf` and chains `dotenv -e .env.cf -e .env.web`. No `cross-env` in this repo.

## Trimmed to the core four features

Per the owner: keep 搜书 / 找书 / 加入书架 / 看书 only. Removed Sign In + the whole logged-in submenu, Settings, Advanced Settings, Download Readest and About from `SettingsMenu` (it is now theme cycle + platform-gated window toggles), the Online Library / OPDS row from `ImportMenu`, and the "Sign in to sync your library" CTA from `LibraryEmptyState`. `onPullLibrary` / `onOpenCatalogManager` stay in the prop interfaces but are no longer destructured, so no call-site ripple through `LibraryHeader` → `library/page.tsx`.

`/` is not redirected to `/library` on purpose: `app/page.tsx` already renders `<LibraryPage />`, and a redirect would unmount `useDemoBooks` mid-import and restart the nine epub fetches. `MobileTabBar` maps `/` to `/library` for tab highlighting instead.

## `runtime-config.js` 404s on every page

`src/app/runtime-config.js` is a route handler, and `pageExtensions: ['jsx','tsx']` drops it from any export — `layout.tsx` / `_document.tsx` already knew this but gated the `<Script>` on `APP_PLATFORM === 'web'` alone, which does not exclude the new "web *and* exported" combination. The `beforeInteractive` script then loaded the 404 HTML as JS. Both guards now also check `NEXT_PUBLIC_EXPORT_STATIC !== 'true'`. Harmless to the app (`getRuntimeConfig()` returning undefined falls back to the baked `NEXT_PUBLIC_*`), but it is loud in the console and sends every visitor through a 404.

## CJK fonts fail CORS off readest.com

`styles/fonts.ts` links four CJK stylesheets from `storage.readest.com`, with `crossorigin="anonymous"`. That host echoes `Access-Control-Allow-Origin` **only for readest.com origins** (curl with `Origin: https://web.readest.com` gets it back; any other origin gets no header at all, on a 200), so on any fork deployment those four fonts silently disappear. Fixed by reverse-proxying them under `/fonts/readest/` in `worker.ts` — the `url("./x.woff2")` references inside each stylesheet are **relative**, so they follow the proxy prefix with no rewriting. Verified all four stylesheets plus a woff2 return 200.

A 404 immediately after `wrangler deploy` can just be propagation: the assets layer answers with `404.html` (~20 KB `text/html`) before the new Worker version is live in that colo. Probe with a path only the Worker can answer (a nonexistent font returns a 9-byte `text/plain`) to tell "Worker not reached" from "Worker returned 404".

## SharedArrayBuffer / crossOriginIsolated — do not chase

`DataCloneError: SharedArrayBuffer transfer requires self.crossOriginIsolated` on load comes from **turso** (the local SQLite/libSQL wasm, built with pthreads) — confirmed by grepping the chunk in the stack trace for `turso`/`pthread`. It powers reading statistics, the Reedy AI assistant and the TTS cache; reading itself is unaffected. Fixing it means COOP `same-origin` + COEP `require-corp`, which puts every cross-origin CDN (Google Fonts, jsdelivr, cdnjs, onlinewebfonts) at risk for features this fork does not ship.

## Debugging an empty shelf

`useDemoBooks` writes `window.__presetImportReport` (per-book ok/null/err) and `window.__presetError`, and only sets `localStorage['presetBooksFetched.<version>']` after a successful import.

**All three being empty at once is diagnostic, not "nothing happened":** the flag is `null`, so the guard passed and `fetchDemoBooks()` ran; the report is written immediately after `Promise.allSettled` and the error in the `catch`, so neither being set means the batch never settled. Everything awaited before it is local (OPFS), so the only thing that can hang is a fetch — and `importOne` had no timeout, so a single stalled connection kept all nine pending forever. Its retry only fires on rejection, never on a stall. Fixed with `AbortSignal.timeout(FETCH_TIMEOUT_MS)` (60s; also aborts an in-flight body read). Worst case is now a bounded ~2 min instead of a permanently empty shelf.

Run the console check one line at a time — pasting several lines only prints the last expression's value, which is how `__presetImportReport` got mistaken for `undefined` once.

**A shelf that is empty for the first minute is not the same bug.** The nine epubs total 22 MB and measured 6–41s each on a cross-border link, so waiting for the whole batch before shelving anything meant a full minute of the "Open Your Library" import prompt — which is what an anonymous visitor reads as "the shelf is broken". Each import now commits on its own (queued, because `updateBooks` awaits `saveLibraryBooks` and concurrent callers can land a stale snapshot last), and `presetBooksDone.<version>` maps url → hash so a partial run resumes instead of re-downloading 22 MB. `PRESET_FLAG` is only set once the whole list is on the shelf.

## `/s` export blocker

`/s` (share landing) blocked the export with `dynamic = "error"` + `await searchParams` in `generateMetadata`. Its existing guard keyed on `NEXT_PUBLIC_APP_PLATFORM !== 'web'`; extended to also take the static branch when `EXPORT_STATIC === 'true'`. Only the rich unfurl metadata is lost — `ShareLanding` reads the token client-side.

**Cost of the static path:** every other `/api/*` route (sync, storage, deepl, send, IAP, share create/og) 404s in production. Accepted deliberately — this fork only needs search / browse / add-to-shelf / read.

Still needed for Z-Library downloads: `wrangler secret put ZLIB_REMIX_USERID` and `ZLIB_REMIX_USERKEY`. Without them Z-Library is skipped as a source and the other three sources still work.

`--webpack` is still mandatory (see [CF Worker 64 MiB regression](cf-worker-64mb-turbopack-regression.md)); `build-cf` passes it explicitly instead of relying on the `patch-build-webpack` sed.
