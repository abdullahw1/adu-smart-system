import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the root so a stray lockfile higher up (e.g. ~/package-lock.json)
  // isn't picked as the workspace root.
  turbopack: { root: __dirname },
};

export default nextConfig;
