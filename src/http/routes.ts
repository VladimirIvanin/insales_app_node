import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config.js';
import { getDb, isReady } from '../storage/database.js';
import { getSession } from './auth.js';
import { handleInstall, handleUninstall, verifyCandidate } from '../application/installation.js';
import { normalizeShop } from '../insales/protocol.js';
import { ProtocolError, ApiError } from '../insales/errors.js';
import { getStore, decryptStorePassword } from '../storage/installations.js';
import { createChallenge, createSession, consumeChallenge } from '../storage/sessions.js';
import { getAccount } from '../insales/resources/account.js';
import { randomId } from '../storage/credentials.js';

export interface RouteDependencies {
  config: ReturnType<typeof loadConfig>;
}

/**
 * Register all HTTP routes on the Fastify instance.
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { config } = deps;

  // Health check — always responds regardless of DB state
  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  // Readiness check — verifies DB is accessible
  app.get('/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (isReady()) {
      return reply.status(200).send({ status: 'ready' });
    }
    return reply.status(503).send({ status: 'not ready' });
  });

  // Install callback from InSales
  app.get('/install', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.query as Record<string, string>;
      const shop = params.shop as string;
      const insalesId = params.insales_id as string;
      const token = params.token as string;

      if (!shop || !insalesId || !token) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }

      handleInstall(config, shop, insalesId, token);
      return reply.status(200).send({ status: 'ok' });
    } catch (err: unknown) {
      if (err instanceof ProtocolError) {
        return reply.status(400).send({ error: 'Invalid request' });
      }
      request.log.error({ err }, 'Install failed');
      return reply.status(503).send({ error: 'Storage unavailable' });
    }
  });

  // Login initiation (redirect to InSales)
  app.get('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.query as Record<string, string>;
      const shop = params.shop as string;
      const insalesId = params.insales_id as string;

      if (!shop || !insalesId) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }

      const normalizedShop = normalizeShop(shop);
      if (!config.allowedShops.includes(normalizedShop)) {
        return reply.status(400).send({ error: 'Invalid shop' });
      }

      // Try to verify candidate first
      const transportOpts = {
        appId: config.insalesAppId,
        allowHttp: config.localDemo,
        timeout: 5000,
      };

      const { diagnostic } = await verifyCandidate(config, insalesId, normalizedShop, transportOpts);

      // Get active store (either existing or just activated)
      const store = getStore(insalesId);
      if (!store) {
        if (diagnostic === 'transient_error') {
          return reply.status(503).send({ error: 'Temporary verification failure' });
        }
        return reply.status(400).send({ error: 'Store not installed' });
      }

      // Verify that the store's shop matches the requested domain
      if (store.shop !== normalizedShop) {
        return reply.status(400).send({ error: 'Shop mismatch' });
      }

      // Generate challenge: browser_binding is a random value stored in cookie
      const browserBinding = randomId(16);
      const { challengeId, nonce } = createChallenge(store.id, store.generation, browserBinding);

      // Build redirect URL to InSales login page
      const callbackUrl = `${config.appBaseUrl}/autologin`;
      const redirectUrl = `${config.localDemo ? 'http' : 'https'}://${store.shop}/admin/applications/${encodeURIComponent(config.insalesAppId)}/login?token=${encodeURIComponent(nonce)}&login=${encodeURIComponent(callbackUrl)}`;

      // Set browser binding cookie (browser_binding value, not challengeId)
      return reply
        .status(302)
        .header('Location', redirectUrl)
        .header('Set-Cookie', `demo_session=${browserBinding}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${config.appBaseUrl.startsWith('https') ? '; Secure' : ''}`)
        .send();
    } catch (err: unknown) {
      if (err instanceof ProtocolError) {
        return reply.status(400).send({ error: 'Invalid request' });
      }
      request.log.error({ err }, 'Login failed');
      return reply.status(503).send({ error: 'Service unavailable' });
    }
  });

  // Autologin callback from InSales (token3 verification)
  app.get('/autologin', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.query as Record<string, string>;
      const signature = params.token3;
      const userEmail = params.user_email ?? '';
      const userName = params.user_name ?? '';
      const userId = params.user_id ?? '';
      const emailConfirmed = params.email_confirmed ?? 'false';

      if (!signature || !userId) {
        return reply.status(401).send({ error: 'Missing signature' });
      }

      // Get browser binding from cookie
      const browserBinding = request.cookies['demo_session'];
      if (!browserBinding) {
        return reply.status(401).send({ error: 'No challenge' });
      }

      // We need to know the store and nonce before we can verify token3.
      // So we first read the challenge by browser_binding, not by challengeId.
      const db = getDb();

      // Find challenge by browser_binding (the cookie value)
      type ChallengeData = { id: string; store_id: string; nonce: string; generation: number; browser_binding: string };
      const challengeRow = db.prepare(`
        SELECT * FROM login_challenges WHERE browser_binding = ? AND expires_at > datetime('now')
      `).get(browserBinding) as ChallengeData | undefined;

      if (!challengeRow) {
        return reply.status(401).send({ error: 'Challenge expired or invalid' });
      }

      // Get store to get password
      const store = getStore(challengeRow.store_id);
      if (!store) {
        return reply.status(401).send({ error: 'Store not found' });
      }

      // Verify store generation matches challenge
      if (store.generation !== challengeRow.generation) {
        return reply.status(401).send({ error: 'Store generation changed' });
      }

      // Decrypt password
      const password = decryptStorePassword(config, store);

      // Compute expected token3
      const { computeToken3, isValidHexSignature, constantTimeEqual } = await import('../insales/protocol.js');
      const expected = computeToken3(challengeRow.nonce, userEmail, userName, userId, emailConfirmed, password);

      if (!isValidHexSignature(signature) || !constantTimeEqual(expected, signature)) {
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      // Atomically consume challenge and verify browser binding
      const consumed = consumeChallenge(challengeRow.id, browserBinding, store.generation);
      if (!consumed) {
        return reply.status(401).send({ error: 'Challenge already consumed' });
      }

      // Create session
      const sessionId = createSession(store.id, userId, store.generation);

      // Set session cookie
      return reply
        .status(302)
        .header('Location', config.appBaseUrl + '/')
        .header('Set-Cookie', `demo_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${config.appBaseUrl.startsWith('https') ? '; Secure' : ''}`)
        .send();
    } catch (err: unknown) {
      if (err instanceof ProtocolError || err instanceof ApiError) {
        return reply.status(401).send({ error: 'Authentication failed' });
      }
      request.log.error({ err }, 'Autologin failed');
      return reply.status(503).send({ error: 'Service unavailable' });
    }
  });

  // Uninstall callback from InSales
  app.get('/uninstall', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.query as Record<string, string>;
      const shop = params.shop as string;
      const insalesId = params.insales_id as string;
      const token = params.token as string;

      if (!shop || !insalesId || !token) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }

      handleUninstall(config, shop, insalesId, token);
      return reply.status(200).send({ status: 'ok' });
    } catch (err: unknown) {
      if (err instanceof ProtocolError) {
        // Invalid request parameters — no-op, but respond 200
        // to not reveal existence
        return reply.status(200).send({ status: 'ok' });
      }
      // Storage errors or unexpected errors — respond 503
      // so the platform retries the uninstall callback
      request.log.error({ err }, 'Uninstall failed');
      return reply.status(503).send({ error: 'Storage unavailable' });
    }
  });

  // Dashboard — main page for authenticated users
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = getSession(request);
    if (!session) {
      return reply.status(401).view('401');
    }

    const db = getDb();
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(session.storeId) as {
      title: string;
      shop: string;
    } | undefined;

    if (!store) {
      return reply.status(404).send({ error: 'Store not found' });
    }

    const csrfToken = await reply.generateCsrf();

    return reply.view('dashboard', {
      title: store.title || store.shop,
      shop: store.shop,
      connected: true,
      csrfToken,
    });
  });

  // Probe — read-only API check for the authenticated store
  app.get('/probe', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = getSession(request);
    if (!session) {
      return reply.status(401).view('401');
    }

    try {
      const store = getStore(session.storeId);
      if (!store) {
        return reply.status(404).send({ error: 'Store not found' });
      }

      const password = decryptStorePassword(config, store);
      const transportOpts = {
        appId: config.insalesAppId,
        shop: store.shop,
        password,
        allowHttp: config.localDemo,
        timeout: 5000,
      };

      const { account, usage } = await getAccount(transportOpts);

      return reply.view('probe', {
        result: { title: account.title || store.shop, id: account.id, usage },
        shop: store.shop,
        error: null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        return reply.view('probe', {
          result: null,
          shop: '',
          error: { status: err.status, detail: err.usage || 'сетевая ошибка' },
        });
      }
      throw err;
    }
  });

  app.post('/logout', { preValidation: app.csrfProtection }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = getSession(request);
    if (session) {
      const { deleteSession } = await import('../storage/sessions.js');
      deleteSession(session.sessionId);
    }
    return reply
      .status(303)
      .header('Location', config.appBaseUrl + '/')
      .header('Set-Cookie', 'demo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
      .send();
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}