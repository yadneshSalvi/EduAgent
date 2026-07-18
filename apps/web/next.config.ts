import path from 'node:path';
import { config as loadRootEnv } from 'dotenv';
import type { NextConfig } from 'next';

// Real keys (Clerk, OpenAI) live in the repo-root .env (01_architecture §6).
// Next only auto-loads env files from the app directory, so load the root one
// explicitly. Runs before anything else in this file; never overrides vars
// already set in the environment.
loadRootEnv({ path: path.resolve(process.cwd(), '../../.env'), quiet: true });

const nextConfig: NextConfig = {
  transpilePackages: ['@eduagent/shared'],
  // Docker builds (deploy/Dockerfile.web) set NEXT_STANDALONE=1 to get the
  // self-contained .next/standalone server. Gated so `next start` keeps its
  // normal behavior in local dev.
  ...(process.env.NEXT_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
  // Dev-only: `next dev` binds to localhost and silently blocks its own
  // scripts/HMR when the page is opened via 127.0.0.1, leaving the page
  // server-rendered but never hydrated (dead buttons, stuck spinners). The
  // app supports both hosts (api base derives from window.location — QA m4),
  // so allow both in dev too. Ignored by production builds.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
};

export default nextConfig;
