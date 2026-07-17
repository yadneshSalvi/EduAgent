/**
 * Agent host entrypoint. Boot order per plans/03 §1:
 *   config → Prisma → WorkspaceManager (+skills) → AppServerClient (spawn
 *   codex) → MemoryPipeline → ThreadManager → routes + WS gateway.
 * (UiToolRelay joins the graph in Phase 2.)
 */
import { buildApp } from './app.js';
import { createServices } from './boot.js';
import { configSummary, loadConfig } from './config.js';
import { createPrisma } from './db.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const prisma = createPrisma(config.databaseUrl);
  try {
    await prisma.user.count();
  } catch (err) {
    console.error(
      `[server] database not ready at ${config.databaseUrl} — run \`pnpm db:setup\` first.`,
    );
    throw err;
  }

  const app = await buildApp({
    config,
    prisma,
    services: (instance) => createServices({ config, prisma, logger: instance.log }),
  });
  app.log.info(configSummary(config), 'config loaded (secrets shown as presence booleans only)');

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    // app.close() runs the onClose hooks, which terminate the codex child.
    void app
      .close()
      .then(() => prisma.$disconnect())
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.serverPort, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
