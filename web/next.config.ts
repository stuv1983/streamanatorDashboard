import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // scripts/deploy.sh builds into a side directory while the live server keeps
  // serving .next, then swaps the two. Unset, this is the usual .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
