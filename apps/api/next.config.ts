import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value: "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
          },
        ],
      },
    ];
  },
  turbopack: {
    root: path.join(import.meta.dirname, "../.."),
  },
};

export default nextConfig;
