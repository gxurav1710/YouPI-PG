import http from 'node:http';
import { URL } from 'node:url';

/** Security headers applied to every response emitted by the gateway. */
const BASE_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN'
});

function configuredOrigins() {
  return new Set(String(process.env.YOUPI_ALLOWED_ORIGINS || '').split(/[\s,]+/).map(value => {
    try { return new URL(value).origin; } catch { return ''; }
  }).filter(Boolean));
}

const requestWindows = new Map();
function isRateLimited(req, pathname) {
  if (req.method !== 'POST') return false;
  const now = Date.now();
  const ip = req.socket?.remoteAddress || 'unknown';
  const windowMs = 60_000;
  const limit = pathname === '/api/v1/payments' ? 20
    : (/\/manual-utr$/.test(pathname) ? 8 : 120);
  const key = `${ip}:${pathname}`;
  let bucket = requestWindows.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    requestWindows.set(key, bucket);
  }
  bucket.count++;
  if (requestWindows.size > 10_000) {
    for (const [entry, value] of requestWindows) if (now - value.startedAt >= windowMs) requestWindows.delete(entry);
  }
  return bucket.count > limit;
}

/**
 * Lightweight, high-performance HTTP router and server with native SSE and CORS.
 */
export class HttpServer {
  constructor() {
    this.routes = [];
    this.guards = [];
    this.sseClients = new Map(); // sessionId -> Set of res objects
  }

  /**
   * Registers a route.
   * @param {'GET'|'POST'|'PUT'|'DELETE'} method
   * @param {string} pattern E.g. "/api/v1/checkout/:id/state"
   * @param {(req: any, res: any, params: Record<string, string>) => void} handler
   */
  register(method, pattern, handler) {
    const paramNames = [];
    const regexPattern = pattern.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });

    this.routes.push({
      method: method.toUpperCase(),
      regex: new RegExp(`^${regexPattern}$`),
      paramNames,
      handler
    });
  }

  /**
   * Registers a guard that runs before routing. Return true when the guard has
   * already answered the request (e.g. 401), so no route handler runs.
   * @param {(req: any, res: any, pathname: string, url: URL) => boolean|Promise<boolean>} guard
   */
  use(guard) {
    this.guards.push(guard);
  }

  get(pattern, handler) {
    this.register('GET', pattern, handler);
  }

  post(pattern, handler) {
    this.register('POST', pattern, handler);
  }

  delete(pattern, handler) {
    this.register('DELETE', pattern, handler);
  }

  /**
   * Dispatches SSE event to all connected clients listening on a specific topic/key.
   * @param {string} topic
   * @param {string} event
   * @param {any} data
   */
  broadcastSse(topic, event, data) {
    const clients = this.sseClients.get(topic);
    if (!clients || clients.size === 0) return;

    const safeJson = (obj) => JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? v.toString() : v);
    const namedPayload = `event: ${event}\ndata: ${safeJson(data)}\n\n`;
    const defaultPayload = `data: ${safeJson({ type: event, ...data, event })}\n\n`;
    const combinedPayload = namedPayload + defaultPayload;
    for (const res of clients) {
      try {
        res.write(combinedPayload);
      } catch {
        clients.delete(res);
      }
    }
  }

  /**
   * Sets up SSE connection for a client response.
   * @param {string} topic
   * @param {http.ServerResponse} res
   */
  initSse(topic, res) {
    const corsOrigin = res.corsOrigin;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin, 'Vary': 'Origin' } : {}),
      ...BASE_SECURITY_HEADERS
    });

    res.write('event: connected\ndata: {"status":"connected"}\n\n');

    if (!this.sseClients.has(topic)) {
      this.sseClients.set(topic, new Set());
    }
    const set = this.sseClients.get(topic);
    set.add(res);

    const pingInterval = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(pingInterval);
      }
    }, 15000);
    if (pingInterval.unref) pingInterval.unref();

    res.on('close', () => {
      clearInterval(pingInterval);
      set.delete(res);
      if (set.size === 0) {
        this.sseClients.delete(topic);
      }
    });
  }

  /**
   * Helper to send JSON responses with standard headers.
   */
  static json(res, statusCode, data) {
    const jsonStr = JSON.stringify(data, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      ...(res.corsOrigin ? { 'Access-Control-Allow-Origin': res.corsOrigin, 'Vary': 'Origin' } : {}),
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, X-Device-Id, X-Device-Token, X-Device-Signature, X-Device-Payload, X-Customer-Token, X-Timestamp, X-Signature',
      ...BASE_SECURITY_HEADERS
    });
    res.end(jsonStr);
  }

  /**
   * Parses JSON body from request.
   */
  static async parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      let tooLarge = false;
      req.on('data', chunk => {
        if (tooLarge) return;
        body += chunk;
        if (body.length > 2 * 1024 * 1024) { // 2MB limit
          tooLarge = true;
          body = '';
          reject(new Error('Payload Too Large'));
        }
      });
      req.on('end', () => {
        if (tooLarge) return;
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Malformed JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Creates native HTTP server.
   */
  createServer() {
    return http.createServer(async (req, res) => {
      const origin = req.headers.origin;
      const origins = configuredOrigins();
      if (origin && !origins.has(origin)) {
        HttpServer.json(res, 403, { error: 'Origin is not allowed.' });
        return;
      }
      if (origin) res.corsOrigin = origin;
      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        if (!origin || !res.corsOrigin) {
          HttpServer.json(res, 403, { error: 'Origin is not allowed.' });
          return;
        }
        res.writeHead(204, {
          'Access-Control-Allow-Origin': res.corsOrigin,
          'Vary': 'Origin',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, X-Device-Id, X-Device-Token, X-Device-Signature, X-Device-Payload, X-Customer-Token, X-Timestamp, X-Signature',
          ...BASE_SECURITY_HEADERS
        });
        res.end();
        return;
      }

      let parsedUrl;
      try {
        // Fixed base: the Host header is attacker-controlled and can make URL parsing throw.
        parsedUrl = new URL(req.url, 'http://localhost');
      } catch {
        HttpServer.json(res, 400, { error: 'Malformed request URL' });
        return;
      }
      const pathname = parsedUrl.pathname;
      const method = req.method.toUpperCase();

      if (isRateLimited(req, pathname)) {
        res.setHeader('Retry-After', '60');
        HttpServer.json(res, 429, { error: 'Too many requests. Please retry shortly.' });
        return;
      }

      try {
        for (const guard of this.guards) {
          if (await guard(req, res, pathname, parsedUrl)) return;
        }
      } catch (err) {
        console.error(`Guard Error [${method} ${pathname}]:`, err);
        HttpServer.json(res, 500, { error: 'Internal Server Error' });
        return;
      }

      for (const route of this.routes) {
        if (route.method === method) {
          const match = pathname.match(route.regex);
          if (match) {
            const params = {};
            route.paramNames.forEach((name, index) => {
              params[name] = match[index + 1];
            });

            req.query = Object.fromEntries(parsedUrl.searchParams.entries());

            try {
              await route.handler(req, res, params);
            } catch (err) {
              // Log the detail server-side; never echo stack/SQL text to an anonymous caller.
              console.error(`Route Error [${method} ${pathname}]:`, {
                name: err?.name || 'Error',
                code: typeof err?.code === 'string' ? err.code : 'unclassified'
              });
              HttpServer.json(res, 500, { error: 'Internal Server Error' });
            }
            return;
          }
        }
      }

      // Not found
      HttpServer.json(res, 404, { error: `Route not found: ${method} ${pathname}` });
    });
  }
}
