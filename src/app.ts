import Fastify, { FastifyInstance, LogController } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import view from '@fastify/view';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import csrf from '@fastify/csrf-protection';
import ejs from 'ejs';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AppConfig } from './config.js';
import { initDb, applyMigrations, closeDb } from './storage/database.js';
import { registerRoutes } from './http/routes.js';
import { registerErrorHandler } from './http/error-handler.js';
import { requestSerializer, errorSerializer } from './http/logging.js';

const PRIVATE_PATHS = new Set([
  '/',
  '/install',
  '/login',
  '/autologin',
  '/uninstall',
  '/probe',
  '/logout',
]);

export interface AppOptions {
  moduleDir?: string;
  logStream?: Writable;
  rateLimitMax?: number;
}

export interface AppInstance {
  fastify: FastifyInstance;
  config: AppConfig;
}

function thisModuleDir(): string {
  return typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));
}

/**
 * Templates and static files sit next to the compiled module in dist,
 * or one level above src when the process runs from TypeScript.
 */
export function locateAssets(moduleDir: string): { templatesDir: string; publicDir: string } {
  const layouts = [
    { templatesDir: resolve(moduleDir, 'templates'), publicDir: resolve(moduleDir, 'public') },
    {
      templatesDir: resolve(moduleDir, '..', 'templates'),
      publicDir: resolve(moduleDir, '..', 'public'),
    },
  ];
  for (const layout of layouts) {
    if (existsSync(resolve(layout.templatesDir, '401.ejs'))) return layout;
  }
  throw new Error(`Cannot find templates near ${moduleDir}`);
}

export async function buildApp(config: AppConfig, options: AppOptions = {}): Promise<AppInstance> {
  initDb(config);
  applyMigrations(config);

  const logger: {
    level: string;
    serializers: { req: typeof requestSerializer; err: typeof errorSerializer };
    stream?: Writable;
  } = {
    level: config.logLevel,
    serializers: {
      req: requestSerializer,
      err: errorSerializer,
    },
  };
  if (options.logStream) logger.stream = options.logStream;

  const fastify = Fastify({
    logger,
    trustProxy: config.trustProxy === false ? false : config.trustProxy,
    requestIdHeader: 'x-request-id',
    logController: new LogController({ requestIdLogLabel: 'req_id' }),
  }).withTypeProvider<TypeBoxTypeProvider>();

  await fastify.register(cookie);
  await fastify.register(formbody);

  const { templatesDir, publicDir } = locateAssets(options.moduleDir ?? thisModuleDir());
  await fastify.register(view, {
    engine: { ejs },
    root: templatesDir,
    includeViewExtension: true,
    defaultContext: {
      escape: (text: string) =>
        String(text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#x27;'),
    },
  });

  if (existsSync(publicDir)) {
    await fastify.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
    });
  }

  await fastify.register(helmet, {
    contentSecurityPolicy: false,
  });

  await fastify.register(rateLimit, {
    max: options.rateLimitMax ?? 100,
    timeWindow: '1 minute',
  });

  await fastify.register(csrf, {
    cookieOpts: {
      signed: false,
      sameSite: 'lax',
      httpOnly: true,
      path: '/',
    },
  });

  registerErrorHandler(fastify);

  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    const qIdx = url.indexOf('?');
    if (qIdx === -1) return;
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const seen = new Set<string>();
    for (const [key] of params) {
      if (seen.has(key)) return reply.status(400).send({ error: 'Duplicate parameter' });
      seen.add(key);
    }
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0];
    if (PRIVATE_PATHS.has(path)) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
    }
    return payload;
  });

  registerRoutes(fastify, { config });

  fastify.addHook('onClose', async () => {
    closeDb();
  });

  return { fastify, config };
}
