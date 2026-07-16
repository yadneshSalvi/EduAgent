/**
 * Agent host entrypoint. Boot order per plans/03 §1:
 *   config → Prisma → [WorkspaceManager → AppServerClient → UiToolRelay]* → routes → WS gateway
 * (* = Phase 1; their module stubs live in src/workspace, src/codex, src/relay.)
 */
import { buildApp } from './app.js';
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

  // Phase 1 boots here, between Prisma and the routes:
  //   WorkspaceManager → AppServerClient (spawn `${CODEX_BIN} app-server`) → UiToolRelay.

  const app = await buildApp({ config, prisma });
  app.log.info(configSummary(config), 'config loaded (secrets shown as presence booleans only)');

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    // Phase 1: terminate the codex app-server child before closing the app.
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
