
import { app } from './app.ts';
import { env } from './config/env.ts';
import { closePool, isDatabaseConfigured } from './database/pool.ts';
import { startRecovery } from './services/ai/reply.ts';

// Render production server configuration
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT) || env.PORT;

const server = app.listen(PORT, HOST, () => {
  console.log(`API listening on http://${HOST}:${PORT}/api (${env.NODE_ENV})`);

  if (!isDatabaseConfigured) {
    console.warn(
      'DATABASE_URL is not set: data endpoints return database_not_configured.'
    );
  }
  // Hands to staff any messages left unanswered by a previous process (restart or deploy).
  startRecovery();
});

server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down.`);

  server.close(() => {
    void closePool().finally(() => process.exit(0));
  });

  server.closeIdleConnections();

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
