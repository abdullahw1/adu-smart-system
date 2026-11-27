import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Pin the root so a stray lockfile higher up (e.g. ~/package-lock.json)
  // isn't picked as the workspace root.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
