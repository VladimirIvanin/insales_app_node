const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie'];

/**
 * Keep only the request path. Callback query carries install passwords and token3.
 */
export function redactUrl(url: string): string {
  const query = url.indexOf('?');
  const withoutQuery = query === -1 ? url : url.slice(0, query);
  if (!withoutQuery.includes('://')) return withoutQuery;
  try {
    return new URL(withoutQuery).pathname;
  } catch {
    return withoutQuery;
  }
}

export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = val;
    }
  }
  return result;
}

export function requestSerializer(req: { method?: string; url?: string; hostname?: string; host?: string; ip?: string }): Record<string, unknown> {
  return {
    method: req.method,
    url: redactUrl(typeof req.url === 'string' ? req.url : ''),
    hostname: req.hostname ?? req.host,
    remoteAddress: req.ip,
  };
}

export function errorSerializer(err: Error): { type: string; message: string; stack: string } {
  return {
    type: err.name,
    message: err.message,
    stack: err.stack ?? '',
  };
}
