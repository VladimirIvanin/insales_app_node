import { loadConfig } from './config.js';
import { buildApp } from './app.js';

async function start() {
  const { fastify, config } = await buildApp(loadConfig());

  try {
    const address = await fastify.listen({
      host: config.bindHost,
      port: config.port,
    });
    console.log(`Server listening at ${address}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();