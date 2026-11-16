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

## Deploying to a VPS

Nothing has been deployed. This is the plan for when hosting is chosen.

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
HOST=127.0.0.1
FRONTEND_URL=https://admin.example.com
DATABASE_URL=postgresql://receptionist:STRONG_PASSWORD@localhost:5432/whatsapp_receptionist
```

- Restrict access: `chmod 600 backend/.env`. Never commit it; `.gitignore` already excludes it.
- The app refuses to start in production without `DATABASE_URL` and `FRONTEND_URL`.
- Session cookies are `Secure` in production, so **login only works over HTTPS** (or on localhost).
- `VITE_*` values are public, as they ship to every browser. Never put secrets in the frontend.
- Use a dedicated database user, not a superuser. Add `?sslmode=require` if the database is on another host.

### Start

```bash
npm run migrate:prod -w backend
npm run staff:create:prod -w backend   # first deployment only; needs a terminal
npm start
```

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

Keep the backend bound to `127.0.0.1` so it is only reachable through the proxy; the login rate limits rely on the proxy's `X-Forwarded-For`. Staff login now protects the dashboard. The `auth_basic` lines below are an optional second layer, and remain sensible until the app has had a security review.

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
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
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
- [ ] OpenAI spend limit set
- [ ] Retention policy decided

## Credentials needed later

All optional until the matching integration is built. Leave them blank for now.

| Variables | Where to get them | Used for |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI platform account | AI replies |
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
| `DATABASE_NOT_MIGRATED` | Run `npm run migrate` |
| CORS error in the browser, or `FORBIDDEN_ORIGIN` | Add the dashboard's exact origin to `FRONTEND_URL` |
| Login does nothing in production | The session cookie needs HTTPS. Check the certificate and that you are not using `http://` |
| `TOO_MANY_ATTEMPTS` | Wait 15 minutes, or restart the backend to clear the counters |
| Forgot a password | `npm run staff:reset-password` |
