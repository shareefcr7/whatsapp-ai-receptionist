# Setup and deployment guide

## Prerequisites

- **Node.js 24 LTS.** Run `nvm use` in the project root. Node 20 cannot run this project: development relies on Node 24's native TypeScript support.
- **PostgreSQL 13 or newer.** Optional for first run. Tested on 18.6.

## Local setup

```bash
nvm use
npm install
cp backend/.env.example backend/.env
npm run dev
```

| Service | URL |
| --- | --- |
| Dashboard | http://localhost:5173 |
| API | http://localhost:4000/api |
| Health check | http://localhost:4000/api/health |

Without a database, the dashboard shows "Database not configured" and no data, and there is no login.

## Adding PostgreSQL

macOS with Homebrew:

```bash
brew install postgresql@18
brew services start postgresql@18
"$(brew --prefix postgresql@18)/bin/createdb" whatsapp_receptionist
```

In `backend/.env`, using your local username (add a password if your setup needs one):

```bash
DATABASE_URL=postgresql://YOUR_USER@localhost:5432/whatsapp_receptionist
```

Then apply the migrations and restart the backend:

```bash
npm run migrate
```

Create the first admin, and check the connection by signing in at http://localhost:5173 (the Database status should say Connected):

```bash
npm run staff:create
```

It prompts for email, name, role (`admin` or `agent`, default `admin`; `agent` is read-only) and a hidden password. Invalid answers are explained and asked again, and Ctrl-C cancels without saving. Passwords need at least 12 characters, and common words, repeated characters, numbers alone, and your name or email are refused. Long passphrases work well.

An email that already has an account is refused. To change a forgotten password, which also signs that person out everywhere:

```bash
npm run staff:reset-password
```

The database user needs permission to create the `btree_gist` extension. It is a trusted extension, so owning the database is enough on PostgreSQL 13+.

## Tests

```bash
npm test
```

To include the PostgreSQL tests, create a **separate, disposable** database whose name ends in `_test` (PostgreSQL 14 or later). The tests commit rows, and delete every row in `services`, `business_info`, `usage_logs`, WhatsApp `webhook_events` and the Google Calendar tables, plus all test customers (`+1555000…` phone numbers) and test staff (`…@example.test`). They refuse to start against a database whose name does not end in `_test`:

```bash
createdb receptionist_test
TEST_DATABASE_URL=postgresql://YOUR_USER@localhost:5432/receptionist_test npm test
```

Use a `postgres://` or `postgresql://` URL: those are the only kinds the app accepts. The `_test` check reads `TEST_DATABASE_URL` the way the PostgreSQL driver does. It also recognises `socket:` URLs (whose database is the `?db=` parameter), but only so it can refuse unsafe ones; the app would reject them anyway. The tests then confirm the name with the server itself before any clean-up, so a connection pooler alias that leads to a different database is refused too.

If a run is interrupted, the next run cleans up after it automatically (leftover test rows, temporary `test_*` triggers and functions, and test sessions still holding locks) and prints what it removed. Test files must run one at a time against one database, as `npm test` does (`--test-concurrency=1`); running them in parallel against the same database makes them interfere.

Two checks in `test/db-hygiene.test.ts` need the test role to be allowed to create databases (they are skipped otherwise). They create a throwaway database named `receptionist_guardcheck` on the same server, point other test files at it to prove nothing is deleted there, and drop it again (also dropping any leftover of that name first). Do not give a real database that name. The same file also uses two fixed fixtures outside the test namespaces, `+447700900123` and `owner@clinic.invalid`, which the tests remove themselves.

Run both forms before calling a change tested: each one skips the suite that needs the opposite setup. The authentication, business information and services suites only run with `TEST_DATABASE_URL` set.

## Changing the schema

Add a numbered file such as `database/migrations/002_add_x.sql`, run `npm run migrate`, and update `database/schema.sql` to match. Never edit a migration that has already been applied. `schema.sql` is a reference snapshot; the migrations are what get applied.

## Audit trail and deleting data

Staff actions (replies, takeovers, hand-backs, closing, reactivating a customer) are recorded in `conversation_events`, which cannot be updated, deleted or truncated. Because of that:

- A customer, conversation or message that has audit history **cannot be deleted**: the delete fails instead of silently erasing who did what.
- A staff member with history cannot be deleted. Deactivate them instead: `UPDATE staff_users SET is_active = false WHERE email = '...'`.
- To erase a customer for a deliberate, recorded data-protection request, a database administrator runs the procedure in `database/migrations/005_audit_integrity.sql` (one transaction that sets `receptionist.audit_maintenance = 'on'`). The app has no API for this.

## Production database migrations

The app never migrates by itself: starting the server does not apply migrations, and no start or build command should. Each production migration is a separate step that a person approves and runs.

### Order: migrate first, then deploy

New code can need tables or columns the old schema lacks, and its requests fail until the migrations are applied. So migrations run against production **before** the new code goes live, while the old code is still serving. That only works if every migration leaves the running code working: add tables and columns, widen constraints, never remove or rename in the same release. `004` and `005` follow this rule. Removing something takes two releases: first deploy code that no longer uses it, then migrate.

Render and Vercel deploy automatically when `main` is pushed, so migrate **before pushing**, or pause auto-deploy for that release.

### Procedure

1. **Approve.** Write down the release commit and which files will be applied: the files in `database/migrations` that are not yet in production's `schema_migrations` table (see Verify below).
2. **Back up.** Take a database backup (on Render: a manual backup or export from the database's dashboard page) and confirm it completed. There are no down migrations, so the backup is the only way back.
3. **Run it once**, from a trusted machine with Node 24, on a checkout of the release commit after `npm ci`:

   ```bash
   read -rs DATABASE_URL && export DATABASE_URL   # paste production's External Database URL; not shown, not saved in history
   npm run migrate -w backend
   unset DATABASE_URL
   ```

   A variable set in the shell takes precedence over `backend/.env`, so a local `.env` is not used for the database. A hostname that contains dots (such as Render's External URL) automatically gets TLS with certificate verification.

4. **Read the result.**
   - `Applied: 004_….sql, 005_….sql` lists what ran. `No pending migrations.` means nothing was needed.
   - `Migration X failed: …` (exit code 1): that file's transaction was rolled back, so it left no trace. Files before it remain applied, files after it did not run. Fix the cause and run the command again.
   - `Could not start migrations: another migration run has held the migration lock…`: another run is in progress (it waits at most 10 seconds for one). Nothing was changed. Wait and retry, or follow the query in the message to find a stuck session.
5. **Deploy** the code (push, or resume auto-deploy).

### Verify

- In the database: `SELECT name, applied_at FROM schema_migrations ORDER BY name;` lists every file in `database/migrations` (six as of `006_anthropic_usage.sql`).
- Running the migrate command a second time prints `No pending migrations.`
- After the deploy, signed in to the dashboard: `GET /api/health/database` reports `migrationsApplied` equal to the number of files in `database/migrations`.

### Rollback and recovery

- **Code:** redeploying the previous commit is safe and is the normal rollback. Because migrations are additive, the old code works on the migrated schema, which stays as it is.
- **A failed migration** rolled itself back; see step 4.
- **Undoing an applied migration** has no command. It needs hand-written SQL by a database administrator, after a fresh backup, plus deleting its row from `schema_migrations`. For `004` and `005` this would discard the staff audit trail, so avoid it.
- **Restoring the backup** returns the database to the moment it was taken and loses everything written since (messages, conversations, staff actions). Keep it for real data damage, not for schema mistakes.
- Never edit an applied migration file. Correct it with a new numbered migration.

## Hosting: Vercel dashboard, Render API

### Request path

```
Browser ──/api/...──> Vercel: dashboard + api/proxy.ts ──X-Client-IP, X-Proxy-Auth──> Render: Express API
Meta ────────────────────────────────────────────────────────────────────────────────> Render: /api/webhooks/whatsapp
```

- The dashboard calls `/api` on its own domain. `vercel.json` sends every `/api` request to the Vercel Function `api/proxy.ts`. Being same-origin is what lets the `SameSite=Strict` session cookie work.
- The function takes the client's IP from Vercel itself (`ipAddress()` from `@vercel/functions`, a header the platform sets). It drops every client-supplied forwarding or proxy header (`X-Forwarded-*`, `X-Real-IP`, `X-Client-IP`, `X-Proxy-Auth`, `X-Vercel-*`, `Forwarded` and similar), then adds `X-Client-IP` and the shared secret in `X-Proxy-Auth`. Method, path, query string and body bytes are forwarded unchanged. Status, body, headers and every `Set-Cookie` come back unchanged. It logs no bodies, cookies, IPs, URLs or secrets.
- Without a valid `BACKEND_URL` and `BACKEND_PROXY_SECRET` it answers `503 PROXY_NOT_CONFIGURED` and contacts nothing. It never falls back to a default backend.
- The backend (`requireProxy` in `backend/src/middleware/auth.ts`) accepts a request only when `X-Proxy-Auth` matches `VERCEL_PROXY_SECRET` (compared in constant time) and `X-Client-IP` is a valid IP. Otherwise it answers `403 PROXY_AUTH_REQUIRED`. Login rate limits count failures per that IP. Express `trust proxy` stays `loopback`: `X-Forwarded-For`, `X-Real-IP` and `X-Vercel-*` are never trusted.

### Direct access to Render

The `onrender.com` address stays reachable from the internet. Without the proxy secret only these answer:

| Route | Protected by |
| --- | --- |
| `GET`/`HEAD /api/health` | Nothing to protect: status and uptime only. Use it as Render's health check path |
| `GET /api/webhooks/whatsapp` | `WHATSAPP_VERIFY_TOKEN` |
| `POST /api/webhooks/whatsapp` | Meta's signature (`WHATSAPP_APP_SECRET`) |

Everything else needs the proxy, including login, logout and the Google OAuth callback. So `GOOGLE_REDIRECT_URI` (and the URI in Google Cloud Console) must be on the dashboard's domain: `https://<dashboard domain>/api/integrations/google/callback`. The matching is exact: `/api/health/` or `/API/health` from outside is refused.

### Render (API)

- The server listens on `0.0.0.0` and Render's `PORT` (`backend/src/server.ts`). `HOST` has no effect.
- Health check path: `/api/health`.
- Variables: `NODE_ENV=production`, `DATABASE_URL` (the Internal Database URL), `FRONTEND_URL` (the dashboard's exact origin), `VERCEL_PROXY_SECRET`, and the integration variables. In production the server refuses to start without `DATABASE_URL`, `FRONTEND_URL` and `VERCEL_PROXY_SECRET`.
- AI provider: `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL=claude-sonnet-5-5` (also the default when blank) makes Claude answer customers. A retired model ID such as `claude-3-5-sonnet-20241022` fails with `AI_MODEL_UNAVAILABLE` and every reply goes to staff; check Anthropic's [model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) page before changing it. `claude-sonnet-5-5` is a current model (retirement not sooner than September 28, 2027); on a refusal the API retries on a fallback model, and if that also refuses the conversation goes to staff. Blank `AI_PROVIDER` means `openai` (`OPENAI_API_KEY`, `OPENAI_MODEL`). Only the selected provider's key is used; setting `ANTHROPIC_*` alone changes nothing. Before the first Claude reply, apply `006_anthropic_usage.sql` (see "Production database migrations"): without it, recording Claude usage fails and every reply goes to staff. Check the key and model for free with `npm run ai:check` (`-- --paid` sends one tiny request). `AI_AUTO_REPLY_ENABLED` still decides whether any AI answers; keep it `false` until staging is verified.
- `VERCEL_PROXY_SECRET`: at least 32 printable characters, no spaces. Generate one on a trusted machine with `openssl rand -base64 48`. Never commit it, and never paste it into chat, tickets or logs.

### Vercel (dashboard and proxy)

`BACKEND_URL` is the backend's origin only (`https://…`, no path). `BACKEND_PROXY_SECRET` is the same value as that backend's `VERCEL_PROXY_SECRET`. Both are server-side variables for the function. Never give them a `VITE_` prefix: `VITE_*` values ship in the browser bundle. Leave `VITE_API_BASE_URL` unset.

| Vercel project and environment | `BACKEND_URL` | `BACKEND_PROXY_SECRET` |
| --- | --- | --- |
| Production project, **Production** | Production Render origin | Production Render's `VERCEL_PROXY_SECRET` |
| Production project, **Preview** and **Development** | Not set | Not set |
| Staging project, **Production** | Staging Render origin | Staging Render's `VERCEL_PROXY_SECRET` |

- **Previews must not get the production values.** A Preview deployment builds any branch, including code nobody has reviewed. With production's secret it would be a trusted proxy into production, able to sign staff in and act on real data. Without the variables, a Preview's `/api` answers 503 and reaches nothing. When adding the variables in Vercel, tick only the Production environment.
- **Staging is fully separate**: its own Vercel project, Render service, database and secret. Staging's `FRONTEND_URL` lists only the staging dashboard origin. A secret is never shared between production and staging.

### First rollout of the proxy

Render and Vercel both deploy when `main` is pushed, and the new backend refuses to start without `VERCEL_PROXY_SECRET`. So:

1. Generate the production secret.
2. Set `VERCEL_PROXY_SECRET` on the production Render service. The running code ignores it.
3. Set `BACKEND_URL` and `BACKEND_PROXY_SECRET` on the production Vercel project, Production environment only.
4. Push. Until both deploys finish, dashboard requests can fail for a moment: an old rewrite sends no secret to the new backend.
5. Check:
   - Sign in on the dashboard.
   - `GET https://<render origin>/api/health` returns 200.
   - `GET https://<render origin>/api/auth/me` returns 403 `PROXY_AUTH_REQUIRED`.
   - A Preview deployment's `/api` returns 503 `PROXY_NOT_CONFIGURED`.

If the Render deploy log shows `VERCEL_PROXY_SECRET: is required in production`, step 2 was missed.

### Rotating the proxy secret

The backend accepts one secret at a time, so dashboard requests fail with 403 between the two updates. Do it in a quiet period.

1. Generate a new secret.
2. Update `VERCEL_PROXY_SECRET` on Render and let it restart.
3. Update `BACKEND_PROXY_SECRET` on Vercel (Production) and redeploy: Vercel applies changed variables only to new deployments.
4. Run the checks in step 5 above.

Rotate when it may have leaked, and when someone with access to either dashboard leaves.

## Deploying to a VPS

An alternative to Vercel and Render, not in use. Here nginx takes the place of the Vercel proxy.

### Build

```bash
nvm use
npm ci
npm run build
npm prune --omit=dev
```

Outputs: `backend/dist` (API) and `frontend/dist` (static files). The migration runner reads from `database/migrations`, so keep the repository layout intact.

### Environment

Create `backend/.env` on the server only:

```bash
NODE_ENV=production
PORT=4000
FRONTEND_URL=https://admin.example.com
DATABASE_URL=postgresql://receptionist:STRONG_PASSWORD@localhost:5432/whatsapp_receptionist
VERCEL_PROXY_SECRET=GENERATED_SECRET   # the same value nginx sends, see Reverse proxy
```

- Restrict access: `chmod 600 backend/.env`. Never commit it; `.gitignore` already excludes it.
- The app refuses to start in production without `DATABASE_URL`, `FRONTEND_URL` and `VERCEL_PROXY_SECRET`.
- Session cookies are `Secure` in production, so **login only works over HTTPS** (or on localhost).
- `VITE_*` values are public, as they ship to every browser. Never put secrets in the frontend.
- Use a dedicated database user, not a superuser. Add `?sslmode=require` if the database is on another host.

### Start

```bash
npm run migrate:prod -w backend        # a separate, approved step: see "Production database migrations"
npm run staff:create:prod -w backend   # first deployment only; needs a terminal
npm start
```

Run the migration step by hand for each release, before starting the new code. Never add it to the systemd service or another start command.

Example systemd service, `/etc/systemd/system/receptionist.service`:

```ini
[Unit]
Description=WhatsApp AI Receptionist API
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/whatsapp-ai-receptionist/backend
# Use the full path from `nvm which 24` if Node 24 is not the system Node.
ExecStart=/usr/bin/node --env-file=.env dist/server.js
Restart=on-failure
User=receptionist
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

The server handles `SIGTERM` by finishing in-flight requests and closing database connections.

### Reverse proxy

The server listens on all interfaces, so the firewall must keep port 4000 closed. nginx then plays the Vercel proxy's role: it sends the client address in `X-Client-IP` with the shared secret in `X-Proxy-Auth`, replacing anything the client sent. Keep the nginx file readable by root only, as it holds the secret. Staff login now protects the dashboard. The `auth_basic` lines below are an optional second layer, and remain sensible until the app has had a security review.

Example nginx configuration:

```nginx
server {
    listen 443 ssl;
    server_name admin.example.com;
    # ssl_certificate lines added by certbot

    auth_basic "Restricted";
    auth_basic_user_file /etc/nginx/.receptionist_htpasswd;

    root /opt/whatsapp-ai-receptionist/frontend/dist;

    location / {
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Client-IP $remote_addr;
        proxy_set_header X-Proxy-Auth "SAME_VALUE_AS_VERCEL_PROXY_SECRET";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
    }
}
```

When WhatsApp webhooks are added, give `/api/webhooks/` its own `location` with `auth_basic off`, since Meta cannot send the password. Its security then comes from signature verification. See [whatsapp-setup.md](whatsapp-setup.md).

### Health checks

| Check | Endpoint | Healthy | Use |
| --- | --- | --- | --- |
| Process | `GET /api/health` | 200 | Restart the service if this fails |
| Database | `GET /api/health/database` (needs a staff session) | 200 and `migrationsApplied` above 0 | Manual check for now, and alert only: restarting will not fix a database outage |

From the server itself: `curl -f http://127.0.0.1:4000/api/health`

### Before going live

- [ ] First admin created with a strong password
- [ ] HTTPS working
- [ ] Firewall allows only SSH, 80 and 443; PostgreSQL not public
- [ ] Automated database backups, with a restore tested
- [ ] Spend limit set for the selected AI provider (OpenAI or Anthropic)
- [ ] Retention policy decided

## Credentials needed later

All optional until the matching integration is built. Leave them blank for now.

| Variables | Where to get them | Used for |
| --- | --- | --- |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Anthropic Console (API keys); model `claude-sonnet-5-5` | AI replies with Claude (`AI_PROVIDER=anthropic`) |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI platform account | AI replies with OpenAI (`AI_PROVIDER` blank or `openai`) |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID` | Meta developer app and WhatsApp Business Account. See [whatsapp-setup.md](whatsapp-setup.md) | Sending messages |
| `WHATSAPP_VERIFY_TOKEN` | A random string you create | Webhook handshake |
| `WHATSAPP_APP_SECRET` (added with the webhook on Day 3) | Meta app settings | Verifying webhook signatures |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google Cloud project | Calendar access |

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `SyntaxError` or `ERR_UNKNOWN_FILE_EXTENSION` on start | Wrong Node version. Run `nvm use` |
| `Invalid environment configuration` on start | Fix the variables named in the message |
| `EADDRINUSE` | Port 4000 or 5173 is in use. Stop the other process. The dashboard's proxy expects the API on 4000 |
| Dashboard shows "Cannot reach the API" | Backend not running |
| `DATABASE_UNAVAILABLE` | PostgreSQL is stopped, or `DATABASE_URL` is wrong. Details are in the backend log |
| `DATABASE_NOT_MIGRATED` | Run `npm run migrate` (in production, follow "Production database migrations") |
| `Could not start migrations: another migration run has held the migration lock` | Another migrate run is in progress. Wait and retry, or end the stuck session the message shows how to find |
| CORS error in the browser, or `FORBIDDEN_ORIGIN` | Add the dashboard's exact origin to `FRONTEND_URL` |
| Login does nothing in production | The session cookie needs HTTPS. Check the certificate and that you are not using `http://` |
| `TOO_MANY_ATTEMPTS` | Wait 15 minutes, or restart the backend to clear the counters |
| `PROXY_NOT_CONFIGURED` (503 from the dashboard's `/api`) | `BACKEND_URL` or `BACKEND_PROXY_SECRET` is missing or invalid in this Vercel environment. Expected on Previews |
| `PROXY_AUTH_REQUIRED` (403) | The request did not come through the proxy, or the two secrets differ. Compare `BACKEND_PROXY_SECRET` (Vercel) with `VERCEL_PROXY_SECRET` (Render) |
| `PROXY_CLIENT_IP_UNAVAILABLE` (503) | Vercel supplied no client address. Not expected on Vercel; check that the request reached the function |
| Forgot a password | `npm run staff:reset-password` |
