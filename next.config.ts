import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
// Bind mounts from a VM (for example Colima/virtiofs) may not deliver file
// events into the container; the development stack then polls instead.
const pollIntervalMs = Number(process.env.NEXT_WATCH_POLL_MS) || undefined;
const config: NextConfig = {
  ...(pollIntervalMs ? { watchOptions: { pollIntervalMs } } : {}),
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
};
export default createNextIntlPlugin("./src/i18n/request.ts")(config);
