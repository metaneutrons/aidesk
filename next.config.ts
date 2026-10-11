import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
};
export default createNextIntlPlugin("./src/i18n/request.ts")(config);
