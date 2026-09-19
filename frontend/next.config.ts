import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // proxy.ts runs on every /api request, and Next buffers the request body
    // in memory for it (default 10 MB), silently TRUNCATING anything bigger.
    // Upload limits are enforced by the routes themselves (lib/file-validation:
    // 5 MB PDFs, 2 MB CSVs, plus a small multipart envelope). This caps what
    // Next will buffer just above that, so an oversized request costs little
    // memory instead of 10 MB.
    proxyClientMaxBodySize: "6mb",
  },
};

export default nextConfig;
