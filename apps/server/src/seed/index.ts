/**
 * `pnpm seed` — the demo seeder CLI (plans/02 §7, plans/06 Phase 5 task 1).
 *
 *   pnpm seed                      wipe + recreate alex (~140-commit history)
 *                                  and sam (empty workspace); purges every
 *                                  other user (QA/dev leftovers) so the login
 *                                  picker shows exactly alex, sam
 *   pnpm seed --user alex --force  reset alex only, preserving the User row
 *                                  (id + authId/Clerk link)
 *   pnpm seed --now <iso>          deterministic seed-day override (tests)
 *
 * Run with the API server stopped, or restart it after seeding — it caches
 * dashboard payloads in memory. Requires `pnpm db:setup` to have run once.
 */
import { loadConfig } from '../config.js';
import { createPrisma } from '../db.js';
import { seedDemo } from './seed.js';

export { seedDemo, type SeedOptions, type SeedSummary, type UserSeedReport } from './seed.js';
export { seedAlexWorkspace, ALEX_TIMEZONE, type AlexSeedResult } from './alex.js';

interface CliArgs {
  user?: 'alex' | 'sam';
  force: boolean;
  now?: Date;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      continue; // pnpm run forwards its conventional option separator
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--user') {
      const value = argv[++i];
      if (value !== 'alex' && value !== 'sam') {
        throw new Error(`--user must be "alex" or "sam", got ${JSON.stringify(value ?? '')}`);
      }
      args.user = value;
    } else if (arg === '--now') {
      const value = argv[++i];
      const parsed = value !== undefined ? Date.parse(value) : Number.NaN;
      if (Number.isNaN(parsed)) {
        throw new Error(`--now needs an ISO datetime, got ${JSON.stringify(value ?? '')}`);
      }
      args.now = new Date(parsed);
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)} (expected --user, --force, --now)`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const prisma = createPrisma(config.databaseUrl);
  console.log(
    `Seeding ${args.user ?? 'alex + sam'} into ${config.dataDir}\n` +
      'Note: stop (or restart) the API server around seeding — it caches dashboards in memory.',
  );
  try {
    const summary = await seedDemo({
      config,
      prisma,
      ...(args.now !== undefined ? { now: args.now } : {}),
      ...(args.user !== undefined ? { only: args.user } : {}),
      force: args.force,
    });
    if (summary.alex) {
      const a = summary.alex;
      console.log(`\nalex  ${a.commits} commits at ${a.workspacePath}`);
      if (a.exam) {
        console.log(
          `      mock exam (2 days back): readiness ${a.exam.before} → ${a.exam.after} (+${a.exam.delta})`,
        );
      }
      if (a.dashboard) {
        const d = a.dashboard;
        console.log(
          `      dashboard: sql-interview ${d.sqlReadiness} (Δ7d +${d.sqlDelta7d}) · ` +
            `python-dsa ${d.pythonReadiness} · streak ${d.streakDays}d · ` +
            `${d.srsDueToday} due today · fading [${d.fading.join(', ')}]\n` +
            `      continue CTA: ${d.continueCta ?? '(none)'}`,
        );
      }
      if (a.roadmaps) {
        console.log(
          `      roadmaps: ${a.roadmaps
            .map(
              (roadmap) =>
                `${roadmap.slug} day ${roadmap.head}/${roadmap.total} (${roadmap.valid ? 'valid' : 'INVALID'})`,
            )
            .join(' · ')}`,
        );
      }
    }
    if (summary.sam) {
      console.log(`sam   empty workspace at ${summary.sam.workspacePath}`);
    }
    console.log(`\nDone in ${(summary.elapsedMs / 1000).toFixed(1)}s`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nSeed failed: ${message}`);
    if (/no such table|does not exist/i.test(message)) {
      console.error('Hint: run `pnpm db:setup` first to create the SQLite schema.');
    }
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Only run as a CLI when invoked directly (tsx src/seed/index.ts), not when
// the test suite imports seedDemo from this module.
const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('src/seed/index.ts') ?? false;
if (invokedDirectly) {
  void main();
}
