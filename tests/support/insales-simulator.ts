import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * A lightweight InSales platform simulator for testing.
 * Supports only the endpoints needed by the application protocol.
 */
export class InSalesSimulator {
  private server;
  private _port = 0;
  private scenarios: Map<string, SimulatedResponse> = new Map();
  private _password = '';
  private _appId = '';
  private _accountId = 42;
  private _accountTitle = 'Test shop';
  private _nextResponses: Map<string, SimulatedResponse[]> = new Map();

  constructor() {
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  setPassword(password: string): void {
    this._password = password;
  }

  setAppId(id: string): void {
    this._appId = id;
  }

  setAccount(id: number, title = 'Test shop'): void {
    this._accountId = id;
    this._accountTitle = title;
  }

  /**
   * Set a fixed response for a given method+path combination.
   */
  setResponse(method: string, path: string, response: SimulatedResponse): void {
    this.scenarios.set(`${method}:${path}`, response);
  }

  /**
   * Queue a response for the next N requests to a given method+path.
   */
  respondNext(method: string, path: string, response: SimulatedResponse): void {
    const key = `${method}:${path}`;
    if (!this._nextResponses.has(key)) {
      this._nextResponses.set(key, []);
    }
    this._nextResponses.get(key)!.push(response);
  }

  /**
   * Start the simulator on a random port.
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this._port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  /**
   * Stop the simulator.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method || 'GET';
    const path = req.url || '/';
    const key = `${method}:${path}`;

    // Check for queued responses first
    const queue = this._nextResponses.get(key);
    if (queue && queue.length > 0) {
      const response = queue.shift()!;
      this.sendResponse(res, response);
      return;
    }

    // Check static scenarios
    const scenario = this.scenarios.get(key);
    if (scenario) {
      this.sendResponse(res, scenario);
      return;
    }

    // Dynamic: /admin/account.json — check Basic auth
    if (path === '/admin/account.json' && method === 'GET') {
      const auth = req.headers['authorization'] || '';
      const expected = 'Basic ' + Buffer.from(`${this._appId}:${this._password}`).toString('base64');
      if (auth === expected) {
        this.sendResponse(res, {
          status: 200,
          headers: { 'content-type': 'application/json', 'api-usage-limit': '1/500' },
          body: JSON.stringify({ id: this._accountId, title: this._accountTitle }),
        });
      } else {
        this.sendResponse(res, { status: 401, headers: {}, body: 'Unauthorized' });
      }
      return;
    }

    // Unknown — return error
    this.sendResponse(res, { status: 404, headers: {}, body: 'Not found' });
  }

  private sendResponse(res: ServerResponse, response: SimulatedResponse): void {
    res.writeHead(response.status, response.headers || {});
    if (response.disconnect) {
      res.socket?.destroy();
      return;
    }
    res.end(response.body || '');
  }
}

export interface SimulatedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  disconnect?: boolean;
}

/**
 * Create an account.json response for a given store ID.
 */
export function accountResponse(storeId: number, title: string): SimulatedResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', 'api-usage-limit': '1/500' },
    body: JSON.stringify({ id: storeId, title }),
  };
}

/**
 * Rate limit (429) response.
 */
export function rateLimitResponse(retryAfter: string = '60'): SimulatedResponse {
  return {
    status: 429,
    headers: { 'retry-after': retryAfter, 'content-type': 'text/plain' },
    body: 'Rate limit exceeded',
  };
}

/**
 * Server error (5xx) response.
 */
export function serverErrorResponse(): SimulatedResponse {
  return {
    status: 503,
    headers: { 'content-type': 'text/plain' },
    body: 'Service Unavailable',
  };
}