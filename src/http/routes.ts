import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config.js';
import { isReady } from '../storage/database.js';
import { authorize, clientForContext, completeAutologin, sessionCookie } from './auth.js';
import {
  receiveInstallation,
  handleUninstall,
  verifyCandidate,
} from '../application/installation.js';
import { lifecycleHooks } from '../application/hooks.js';
import { normalizeShop } from '../insales/protocol.js';
import { ApiError, InsalesError, ProtocolError } from '../insales/errors.js';
import { PendingQuotaError, getStore } from '../storage/installations.js';
import { createChallenge, deleteSession } from '../storage/sessions.js';
import { randomId } from '../storage/credentials.js';

export interface RouteDependencies {
  config: ReturnType<typeof loadConfig>;
}

/**
 * Register all HTTP routes on the Fastify instance.
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { config } = deps;
  const secureCookie = config.appBaseUrl.startsWith('https');

  app.get(
    '/health',
    { config: { rateLimit: false } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.status(200).send({ status: 'ok' });
    },
  );

  app.get(
    '/ready',
    { config: { rateLimit: false } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      if (isReady()) {
        return reply.status(200).send({ status: 'ready' });
      }
      return reply.status(503).send({ status: 'not ready' });
    },
  );

  app.get('/install', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.query as Record<string, string>;
      const shop = params.shop;
      const insalesId = params.insales_id;
      const token = params.token;

      if (!shop || !insalesId || !token) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }

      await receiveInstallation(config, shop, insalesId, token);
      return reply.status(200).send({ status: 'ok' });
    } catch (err: unknown) {
      if (err instanceof PendingQuotaError) {
        return reply
          .status(503)
          .header('Retry-After', '5')
          .send({ error: 'Installation verification unavailable; retry later' });
      }
      if (err instanceof ProtocolError) {
        return reply.status(400).send({ error: 'Invalid request' });
      }
      request.log.error({ err }, 'Install failed');
      return reply.status(503).send({ error: 'Storage unavailable' });
    }
  });

  app.get('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.query as Record<string, string>;
      const shop = params.shop;
      const insalesId = params.insales_id;

      if (!shop || !insalesId) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }

      const normalizedShop = normalizeShop(shop);
      if (!config.allowedShops.includes(normalizedShop)) {
        return reply.status(400).send({ error: 'Invalid shop' });
      }

      const { diagnostic } = await verifyCandidate(config, insalesId, normalizedShop, {
        appId: config.insalesAppId,
        allowHttp: config.localDemo,
        timeout: 5000,
      });

      const store = getStore(insalesId);
      if (!store) {
        if (diagnostic === 'transient_error') {
          return reply.status(503).send({ error: 'Temporary verification failure' });
        }
        return reply.status(400).send({ error: 'Store not installed' });
      }

      if (store.shop !== normalizedShop) {
        return reply.status(400).send({ error: 'Shop mismatch' });
      }

      const browserBinding = randomId(16);
      const { nonce } = createChallenge(store.id, store.generation, browserBinding);
      const callbackUrl = `${config.appBaseUrl}/autologin?flow=${encodeURIComponent(nonce)}`;
      const redirectUrl = `${config.localDemo ? 'http' : 'https'}://${store.shop}/admin/applications/${encodeURIComponent(config.insalesAppId)}/login?token=${encodeURIComponent(nonce)}&login=${encodeURIComponent(callbackUrl)}`;

      return reply
        .status(302)
        .header('Location', redirectUrl)
        .header('Set-Cookie', [
          sessionCookie(browserBinding, secureCookie, 300),
          flowCookie(nonce, browserBinding, secureCookie, 300),
        ])
        .send();
    } catch (err: unknown) {
      if (err instanceof ProtocolError) {
        return reply.status(400).send({ error: 'Invalid request' });
      }
      request.log.error({ err }, 'Login failed');
      return reply.status(503).send({ error: 'Service unavailable' });
    }
  });

  app.get('/autologin', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.query as Record<string, string>;
      const signature = params.token3;
      const userId = params.user_id ?? '';
      const flow = params.flow;
      if (flow && !/^[a-zA-Z0-9_-]{1,128}$/.test(flow))
        return reply.status(401).send({ error: 'Invalid flow' });
      const browserBinding = request.cookies[flow ? `login_${flow}` : 'demo_session'];

      if (!signature || !userId || !browserBinding) {
        return reply.status(401).send({ error: 'Missing signature' });
      }

      const opened = await completeAutologin(config, {
        signature,
        userEmail: params.user_email ?? '',
        userName: params.user_name ?? '',
        userId,
        emailConfirmed: params.email_confirmed ?? 'false',
        browserBinding,
      });
      if (!opened.ok) {
        return reply.status(401).send({ error: 'Authentication failed' });
      }

      return reply
        .status(302)
        .header('Location', `${config.appBaseUrl}/?store_id=${encodeURIComponent(opened.storeId)}`)
        .header('Set-Cookie', [
          sessionCookie(opened.sessionId, secureCookie, 3600),
          ...(flow ? [flowCookie(flow, '', secureCookie, 0)] : []),
        ])
        .send();
    } catch (err: unknown) {
      request.log.error({ err }, 'Autologin failed');
      return reply.status(503).send({ error: 'Service unavailable' });
    }
  });

  app.get('/uninstall', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.query as Record<string, string>;
      const shop = params.shop;
      const insalesId = params.insales_id;
      const token = params.token;

      if (!shop || !insalesId || !token) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }

      handleUninstall(config, shop, insalesId, token);
      return reply.status(200).send({ status: 'ok' });
    } catch (err: unknown) {
      if (err instanceof ProtocolError) {
        return reply.status(200).send({ status: 'ok' });
      }
      request.log.error({ err }, 'Uninstall failed');
      return reply.status(503).send({ error: 'Storage unavailable' });
    }
  });

  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = authorize(config, request);
    if (!session) {
      return reply.status(401).view('401');
    }

    if (wrongTab(request, session.storeId))
      return reply
        .status(409)
        .send('Другая вкладка сменила магазин. Откройте приложение из нужного магазина.');
    const csrfToken = await reply.generateCsrf();
    return reply.view('dashboard', {
      title: session.title || session.shop,
      shop: session.shop,
      connected: true,
      storeId: session.storeId,
      csrfToken,
    });
  });

  app.get('/probe', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = authorize(config, request);
    if (!session) {
      return reply.status(401).view('401');
    }

    if (wrongTab(request, session.storeId))
      return reply
        .status(409)
        .send('Другая вкладка сменила магазин. Откройте приложение из нужного магазина.');
    try {
      if (lifecycleHooks.afterAuthorized) await lifecycleHooks.afterAuthorized();
      const client = clientForContext(config, session);
      const { account, usage } = await client.account.get();

      return reply.view('probe', {
        result: { title: account.title || session.shop, id: account.id, usage },
        shop: session.shop,
        error: null,
        storeId: session.storeId,
      });
    } catch (err: unknown) {
      if (err instanceof InsalesError) {
        return reply.view('probe', {
          result: null,
          storeId: session.storeId,
          shop: '',
          error: {
            status: err instanceof ApiError ? err.status : 0,
            detail: err instanceof ApiError && err.usage ? err.usage : 'сетевая ошибка',
          },
        });
      }
      throw err;
    }
  });

  app.post(
    '/logout',
    { preValidation: app.csrfProtection },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const session = authorize(config, request);
      if (session && wrongTab(request, session.storeId))
        return reply.status(409).send('Другая вкладка сменила магазин.');
      if (session) deleteSession(session.sessionId);
      return reply
        .status(303)
        .header('Location', `${config.appBaseUrl}/`)
        .header('Set-Cookie', sessionCookie('', secureCookie, 0))
        .send();
    },
  );
}

function flowCookie(flow: string, value: string, secure: boolean, maxAge: number): string {
  return `login_${flow}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function wrongTab(request: FastifyRequest, storeId: string): boolean {
  const expected = (request.query as Record<string, string>).store_id;
  return expected !== undefined && expected !== storeId;
}
