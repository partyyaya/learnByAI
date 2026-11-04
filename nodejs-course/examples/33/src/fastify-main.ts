import { runtimeConfig } from './runtime-config.js';
import { once } from 'node:events';
import { createArticleApplication } from './application.js';
import { createDatabase } from './database.js';
import { createObservability } from './observability.js';

// stdout 已接受的一行可留在 Node buffer；背壓期間拒收後續行，不另建佇列。
let blocked = false; let broken = false;
process.stdout.on('drain', () => { blocked = false; });
process.stdout.on('error', () => { broken = true; });
const observation = createObservability(line => {
  if (blocked || broken) return false;
  blocked = !process.stdout.write(line + '\n'); return true;
});
async function main() {
  const { port, timeoutMs, host, origin, databaseUrl } = runtimeConfig(process.env);
  const database = createDatabase(databaseUrl);
  let server: Awaited<ReturnType<typeof createArticleApplication>> | undefined;
  try {
    const application = await createArticleApplication({ platform: 'fastify', database, timeoutMs, auth: { origin }, observability: observation });
    server = application;
    // 連線成功仍不代表 migration 已套用；正式監聽前保留必要資料檢查。
    await database.article.count(); await database.articleStatusAudit.count(); await database.comment.count(); await database.session.count();
    await database.user.findFirst({ select: { email: true, passwordHash: true, role: true } });
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) return; stopping = true; observation.signal(signal);
      void application.lifecycle.shutdown().then(() => { process.exitCode = 0; }, () => {
        observation.failed('shutdown_failed'); process.exit(1);
      });
    };
    server.listen(port, host); await once(server, 'listening');
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    const address = server.address();
    if (address && typeof address !== 'string') observation.listening(address.port);
  } catch (error) {
    if (server) await server.lifecycle.shutdown();
    throw error;
  }
}
void main().catch(() => { observation.failed('startup_failed'); process.exitCode = 1; });
