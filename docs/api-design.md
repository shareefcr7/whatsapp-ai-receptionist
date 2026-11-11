# API design

Base path: `/api`. All endpoints return JSON.

## Authentication

Staff sign in with `POST /api/auth/login`, which sets the session cookie `receptionist_session` (`HttpOnly`, `SameSite=Strict`, and `Secure` in production). Sessions are stored in `staff_sessions` as a SHA-256 of the token, last 12 hours, and survive a backend restart. Logout, deactivating a user and resetting a password end them at once.

- **Public:** `GET /api/health`, `POST /api/auth/login`, `POST /api/auth/logout`. Everything else needs a session, including routes added later, unless they are registered above `requireAuth` in `routes/index.ts`.
- **Roles:** `admin` can read and write. `agent` can read only.
- **Failed logins:** 5 per account and IP, or 30 per IP, within 15 minutes returns 429. Counters are held in memory and reset on restart.
- **Other sites:** a browser write whose `Origin` is not in `FRONTEND_URL` gets 403.
- **No database (local development only):** there is nothing to protect, so read routes answer with `database_not_configured` and login and writes answer 503. Production refuses to start without `DATABASE_URL`.

## Response format

Success:

```json
{ "success": true, "data": [], "meta": { "dataState": "empty", "page": 1, "limit": 20, "total": 0 } }
```

Error:

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed.", "details": { "status": ["..."] } } }
```

`details` appears on validation errors only. Internal error detail is written to the server log and never returned.

## `meta.dataState`

| Value | Meaning | Dashboard shows |
| --- | --- | --- |
| `has_data` | Records were found | The records |
| `empty` | The database was checked and has none | "No leads yet" |
| `database_not_configured` | `DATABASE_URL` is not set, so the answer is unknown | Warning banner, "—" for KPIs |

A database that is configured but failing returns an error (503), not an empty result.

## Endpoints

| Method and path | Purpose | Status codes |
| --- | --- | --- |
| `GET /api/health` | Public. Is the process up? Does not touch the database | 200 |
| `POST /api/auth/login` | Public. Body: `email`, `password`. Sets the session cookie, returns the staff user | 200, 400, 401, 429, 503 |
| `POST /api/auth/logout` | Public. Ends the session if there is one, clears the cookie | 200, 503 |
| `GET /api/auth/me` | The signed-in staff user | 200, 401, 503 |
| `GET /api` | Service info, endpoint list, integration status | 200, 401 |
| `GET /api/health/database` | Connection test, server version, migrations applied, latency | 200, 401, 503 |
| `GET /api/dashboard/summary` | KPIs (`null` if unknown) and the latest 5 of each list | 200, 401, 503 |
| `GET /api/conversations` | Paginated conversations with last message | 200, 400, 401, 503 |
| `GET /api/leads` | Paginated leads | 200, 400, 401, 503 |
| `GET /api/appointments` | Paginated appointments, latest first | 200, 400, 401, 503 |
| `GET /api/usage` | Month-to-date totals from `usage_logs`. Added for the Usage & Costs page | 200, 401, 503 |
| `GET /api/business-info` | `profile`, `entries` (policies, FAQs) and `services` | 200, 401, 503 |
| `PUT /api/business-info/profile` | Admin. Replaces the whole profile at once. A blank optional field removes that detail | 200, 400, 401, 403, 503 |
| `POST /api/business-info/entries` | Admin. Adds a policy, FAQ or general entry | 201, 400, 401, 403, 503 |
| `PUT /api/business-info/entries/:id` | Admin. Replaces an entry | 200, 400, 401, 403, 404, 503 |
| `DELETE /api/business-info/entries/:id` | Admin. Deletes an entry | 200, 400, 401, 403, 404, 503 |
| `GET /api/services` | Paginated services, by name | 200, 400, 401, 503 |
| `POST /api/services` | Admin. Adds a service | 201, 400, 401, 403, 409, 503 |
| `PUT /api/services/:id` | Admin. Replaces a service | 200, 400, 401, 403, 404, 409, 503 |
| `DELETE /api/services/:id` | Admin. Deletes a service. Its leads and appointments stay, with `service_id` set to NULL | 200, 400, 401, 403, 404, 503 |

### Request bodies

Unknown fields are rejected. Text is trimmed.

| Body | Fields |
| --- | --- |
| Profile | `name` (required, up to 200), `description` (up to 2000), `address` (up to 500), `phone`, `email`, `website` (http or https), `workingHours` (free text, up to 1000), `isPublished` |
| Entry | `category` (`policy`, `faq`, `general`), `title` (up to 200), `content` (up to 5000), `isPublished` (default `false`) |
| Service | `name` (required, unique, up to 120), `description`, `durationMinutes` (integer, 1 to 1440), `priceAmount` (string such as `"25.50"`, or null), `currency` (3 letters, required with a price), `isActive` (default `true`) |

`isPublished` marks what the AI may use once it exists. The profile and entries are stored as `business_info` rows; profile rows use the category `profile`.

### List parameters

Unknown parameters are rejected.

| Parameter | Default | Rules |
| --- | --- | --- |
| `page` | 1 | Integer from 1 |
| `limit` | 20 | Integer from 1 to 100 |
| `status` | none | Conversations: `open`, `handover_requested`, `human_active`, `closed`. Leads: `new`, `contacted`, `qualified`, `converted`, `lost`. Appointments: `pending`, `confirmed`, `cancelled`, `completed`, `no_show`. Services: `active`, `inactive` |

## Error codes

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid query parameters or body. `details` lists messages by field |
| 400 | `BAD_REQUEST` | Malformed request, such as invalid JSON |
| 401 | `UNAUTHENTICATED` | No valid session. Anonymous requests to unknown routes get this too, so route names stay private |
| 401 | `INVALID_CREDENTIALS` | Wrong email or password, with the same answer for both |
| 403 | `FORBIDDEN` | Signed in, but only an admin can do this |
| 403 | `FORBIDDEN_ORIGIN` | Browser write from a site not in `FRONTEND_URL` |
| 404 | `NOT_FOUND` | No such route or record |
| 409 | `CONFLICT` | A unique value already exists, such as a service name |
| 429 | `TOO_MANY_ATTEMPTS` | Too many failed sign-ins |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 1 MB |
| 500 | `INTERNAL_ERROR` | Unexpected error, details in the server log |
| 501 | `INTEGRATION_PENDING` | Feature not built. No route reaches this yet; placeholders raise it |
| 503 | `DATABASE_NOT_CONFIGURED` | `DATABASE_URL` is not set (health endpoint) |
| 503 | `DATABASE_UNAVAILABLE` | Database unreachable or rejected the login |
| 503 | `DATABASE_NOT_MIGRATED` | Tables are missing: run the migrations |

## Integration status (`GET /api`)

```json
{ "implementation": "placeholder", "credentials": "missing", "connected": false }
```

`credentials` is `missing` or `present_untested`. It never exposes values. `connected` stays `false` until a real integration exists and has been tested against the provider.

## Planned endpoints (not implemented)

| Method and path | Purpose |
| --- | --- |
| `GET /api/webhooks/whatsapp` | Meta verification handshake using `WHATSAPP_VERIFY_TOKEN` |
| `POST /api/webhooks/whatsapp` | Receive messages and delivery statuses. Verifies `X-Hub-Signature-256`, and must be reachable without dashboard auth. See [whatsapp-setup.md](whatsapp-setup.md) |
| `GET /api/conversations/:id/messages` | Conversation thread |
| `POST /api/conversations/:id/handover` | Take over from or return to the AI |
| `POST /api/leads`, `PATCH /api/leads/:id` | Lead management |
| `GET /api/appointments/availability` | Open slots |
| `POST /api/appointments`, `PATCH /api/appointments/:id` | Book, reschedule, cancel |
