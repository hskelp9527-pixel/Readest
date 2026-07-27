import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// 不接 R2 增量缓存：本部署账号没有 R2，且应用不用 ISR / revalidate / unstable_cache，
// 增量缓存本来就是空转（下面 disableIncrementalCache 也说明了这点）。
const config = defineCloudflareConfig();

// Skip the deploy-time R2 incremental-cache populate step. The app uses no ISR /
// `revalidate` / `unstable_cache`, so the runtime incremental cache is a no-op
// anyway. Remove this line to re-enable (deploy from a network that can reach the
// Cloudflare edge).
config.dangerous = { ...config.dangerous, disableIncrementalCache: true };

export default config;
