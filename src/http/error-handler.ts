import { FastifyInstance } from 'fastify';
import { ApiError, InsalesError, ProtocolError, StorageError } from '../insales/errors.js';

/**
 * Register a custom error handler for the Fastify instance.
 * Maps domain errors to appropriate HTTP status codes without leaking secrets.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    // Don't log internal details for known errors
    if (error instanceof ProtocolError) {
      return reply.status(400).send({ error: 'Invalid request' });
    }

    if (error instanceof ApiError) {
      return reply.status(502).send({
        error: 'Upstream API error',
        apiStatus: error.status,
        usage: error.usage,
        retryAfter: error.retryAfter,
      });
    }

    if (error instanceof InsalesError) {
      return reply.status(502).send({ error: 'Upstream API error' });
    }

    if (error instanceof StorageError) {
      return reply.status(503).send({ error: 'Storage unavailable' });
    }

    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: statusCode === 429 ? 'Too many requests' : 'Invalid request',
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({ error: 'Internal server error' });
  });
}
