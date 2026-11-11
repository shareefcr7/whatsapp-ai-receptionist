import { Router } from 'express';
import * as c from '../controllers/index.ts';
import { requireAdmin, requireAuth } from '../middleware/auth.ts';

export const apiRouter = Router();

// Public. Meta signs its webhook requests and cannot sign in.
apiRouter.get('/health', c.health);
apiRouter.post('/auth/login', c.login);
apiRouter.post('/auth/logout', c.logout);
// Google's redirect is cross-site, so the SameSite=Strict session cookie is absent: the OAuth state authenticates it.
apiRouter.get('/integrations/google/callback', c.googleCallback);
apiRouter.get('/webhooks/whatsapp', c.whatsappVerify);
apiRouter.post('/webhooks/whatsapp', c.whatsappWebhook);

// Everything below needs a session, so a new route is protected by default.
apiRouter.use(requireAuth);

apiRouter.get('/auth/me', c.me);
apiRouter.get('/', c.apiIndex);
apiRouter.get('/health/database', c.databaseHealth);
apiRouter.get('/dashboard/summary', c.dashboardSummary);
apiRouter.get('/conversations', c.listConversations);
apiRouter.get('/leads', c.listLeads);
apiRouter.get('/appointments', c.listAppointments);
apiRouter.get('/usage', c.usage);

apiRouter.get('/business-info', c.businessInfo);
apiRouter.put('/business-info/profile', requireAdmin, c.saveBusinessProfile);
apiRouter.post('/business-info/entries', requireAdmin, c.createBusinessEntry);
apiRouter.put('/business-info/entries/:id', requireAdmin, c.updateBusinessEntry);
apiRouter.delete('/business-info/entries/:id', requireAdmin, c.deleteBusinessEntry);

apiRouter.get('/services', c.listServices);
apiRouter.post('/services', requireAdmin, c.createService);
apiRouter.put('/services/:id', requireAdmin, c.updateService);
apiRouter.delete('/services/:id', requireAdmin, c.deleteService);

apiRouter.get('/integrations/google/status', c.googleStatus);
apiRouter.post('/integrations/google/authorize', requireAdmin, c.googleAuthorize);
apiRouter.post('/integrations/google/test', requireAdmin, c.googleTest);
apiRouter.delete('/integrations/google', requireAdmin, c.googleDisconnect);
