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
};

export default nextConfig;
