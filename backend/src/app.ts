import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { allowedOrigins } from './config/env.ts';
import { rejectForeignOrigin } from './middleware/auth.ts';
import { errorHandler, notFound } from './middleware/errors.ts';
import { apiRouter } from './routes/index.ts';

export const app = express();

app.disable('x-powered-by');
// The API sits behind a local reverse proxy; login rate limits need the real client IP.
app.set('trust proxy', 'loopback');
app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(rejectForeignOrigin);
// Meta signs the exact bytes it sends, so the webhook keeps its raw body. express.json() skips a body already read.
app.use('/api/webhooks/whatsapp', express.raw({ type: () => true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', apiRouter);
app.use(notFound);
app.use(errorHandler);
