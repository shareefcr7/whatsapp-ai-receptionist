import { app } from './app.ts';
import { env } from './config/env.ts';
import { closePool, isDatabaseConfigured } from './database/pool.ts';

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`API listening on http://${env.HOST}:${env.PORT}/api (${env.NODE_ENV})`);
  if (!isDatabaseConfigured) console.warn('DATABASE_URL is not set: data endpoints return database_not_configured.');
});

server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down.`);
  server.close(() => void closePool().finally(() => process.exit(0)));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
