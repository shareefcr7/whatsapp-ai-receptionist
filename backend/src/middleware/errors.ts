import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { AppError } from '../types/errors.ts';

const CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P01', '57P03', '3D000', '28P01']);

function classify(err: unknown): { status: number; code: string; message: string; details?: unknown } {
  if (err instanceof AppError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof ZodError) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details: z.flattenError(err).fieldErrors,
    };
  }
  const { code, status, type, message } = err as { code?: string; status?: number; type?: string; message?: string };
  // pg raises AggregateError for dual-stack localhost, and uncoded messages for pool timeouts,
  // dropped sockets and a password missing from DATABASE_URL (SASL).
  if ((code && CONNECTION_ERRORS.has(code)) || err instanceof AggregateError || /^(timeout expired|Connection terminated|SASL:)/.test(message ?? '')) {
    return { status: 503, code: 'DATABASE_UNAVAILABLE', message: 'The database is unreachable.' };
  }
  if (code === '42P01') {
    return { status: 503, code: 'DATABASE_NOT_MIGRATED', message: 'Database tables are missing. Run the migrations.' };
  }
  if (code === '23505') {
    return { status: 409, code: 'CONFLICT', message: 'A record with that value already exists.' };
  }
  // body-parser errors (malformed JSON, oversized body) are the client's fault.
  if (status && status >= 400 && status < 500) {
    return { status, code: type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message: 'Invalid request.' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong.' };
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const { status, ...error } = classify(err);
  // Detail stays in the server log; clients get only the classified message.
  // AppErrors are expected states (e.g. no database set, polled every 30s), so one line is enough.
  if (err instanceof AppError) {
    if (status >= 500 && status !== 503) console.error(`${req.method} ${req.path} -> ${error.code}: ${err.message}`);
  } else if (status >= 500) {
    console.error(`${req.method} ${req.path} -> ${error.code}:`, err);
  }
  res.status(status).json({ success: false, error });
};
