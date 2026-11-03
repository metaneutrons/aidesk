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
  // The development indicator lies over the first tab of the menu on a phone and over controls in the tests; it has
  // no effect on a production build.
  devIndicators: false,
  // The sandbox of the file extraction builds its code with esbuild at run time. A route that reaches
  // it (the worker tick) must not have the compiler and its binary bundled.
  serverExternalPackages: ["esbuild"],
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
};
export default createNextIntlPlugin("./src/i18n/request.ts")(config);
