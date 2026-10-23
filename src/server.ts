import { loadConfig } from './config.js';
import { buildApp } from './app.js';

/** Close waits this long, then the process exits with code 1. */
const SHUTDOWN_MS = 10_000;

async function start() {
  const { fastify, config } = await buildApp(loadConfig());
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timer = setTimeout(() => {
      console.error(`Shutdown exceeded ${SHUTDOWN_MS}ms`);
      process.exit(1);
    }, SHUTDOWN_MS);
    timer.unref();
    fastify.log.info({ signal }, 'Shutting down');
    fastify
      .close()
      .then(() => {
        clearTimeout(timer);
        process.exit(0);
      })
      .catch((err: unknown) => {
        fastify.log.error(err);
        process.exit(1);
      });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  try {
    const address = await fastify.listen({
      host: config.bindHost,
      port: config.port,
    });
    console.log(`Server listening at ${address}`);
  } catch (err) {
    fastify.log.error(err);
    await fastify.close();
    process.exit(1);
  }
}

start();
