import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { allowedOrigins } from './config/env.ts';
import { rejectForeignOrigin, requireProxy } from './middleware/auth.ts';
import { errorHandler, notFound } from './middleware/errors.ts';
import { apiRouter } from './routes/index.ts';

export const app = express();

app.disable('x-powered-by');
// Leave as is: forwarding headers are never trusted. The client IP comes from the authenticated Vercel proxy
// (requireProxy); req.ip is only the local-development fallback.
app.set('trust proxy', 'loopback');
app.use(helmet());
// Before CORS and body parsing: a direct request is refused before anything reads it.
app.use(requireProxy);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(rejectForeignOrigin);
// Meta signs the exact bytes it sends, so the webhook keeps its raw body. express.json() skips a body already read.
app.use('/api/webhooks/whatsapp', express.raw({ type: () => true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', apiRouter);
app.use(notFound);
app.use(errorHandler);
