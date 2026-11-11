# WhatsApp setup: what is needed

**Status: built, not connected.** The webhook (`GET`/`POST /api/webhooks/whatsapp`), signature check, message storage and `sendText`/`sendTemplate` exist and are tested against mocks. Nothing has been verified with Meta yet, so `GET /api` keeps reporting `connected: false` until the test at the end of this page passes.

## What to collect

| Item | Variable | Where to find it | Secret? |
| --- | --- | --- | --- |
| Meta app with the WhatsApp use case ("Connect with customers through WhatsApp"), in a business portfolio | none | Meta App Dashboard | No |
| Phone number ID | `WHATSAPP_PHONE_NUMBER_ID` | App Dashboard, WhatsApp > API Setup | No |
| WhatsApp Business Account ID (shown as "Messaging account ID" in API Setup at the time of writing) | `WHATSAPP_BUSINESS_ACCOUNT_ID` | App Dashboard, WhatsApp > API Setup | No |
| System user access token | `WHATSAPP_ACCESS_TOKEN` | Business Settings > System users | **Yes** |
| App secret | `WHATSAPP_APP_SECRET` | App Dashboard, App settings > Basic | **Yes** |
| Verify token: a random string you make up, such as `openssl rand -hex 32` | `WHATSAPP_VERIFY_TOKEN` | You create it | **Yes** |
| A WhatsApp device to send test messages | none | Yours | No |

### System user token

The temporary token in API Setup expires quickly, so it only suits a first manual test. For anything else:

1. In Business Settings > System users, create a system user.
2. Assign your app (Manage app, full control) and your WhatsApp account (Manage WhatsApp Business accounts, full control).
3. Generate a token with `business_management`, `whatsapp_business_messaging` and `whatsapp_business_management`.

Put it in `backend/.env` only, never in the dashboard, chat, a ticket or the repository.

## Webhook details to enter in Meta

In the App Dashboard, go to WhatsApp > Configuration.

| Field | Value |
| --- | --- |
| Callback URL | `https://YOUR-DOMAIN/api/webhooks/whatsapp` (a public HTTPS address; a tunnel works for testing) |
| Verify token | Same value as `WHATSAPP_VERIFY_TOKEN` |
| Webhook field to subscribe | `messages` |

Meta calls the URL when you click Verify and Save, so the backend must be running and reachable over public HTTPS first (for local testing, a tunnel to `http://localhost:4000`).

**Verification handshake.** Meta sends `GET` with `hub.mode`, `hub.verify_token` and `hub.challenge`. If the mode is `subscribe` and the token matches, answer 200 with the challenge as the body. Otherwise answer 403.

**Message delivery.** Meta sends `POST` with an `X-Hub-Signature-256: sha256=...` header, an HMAC-SHA256 of the raw body using the app secret.

**Subscribe the app to the WhatsApp account.** Each account must be subscribed individually:

```bash
curl -X POST "https://graph.facebook.com/VERSION/WABA_ID/subscribed_apps" -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN"
curl "https://graph.facebook.com/VERSION/WABA_ID/subscribed_apps" -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN"   # your app ID should be listed
```

Use the Graph API version your app dashboard shows (Meta's getting-started sample used `v23.0` when this was written).

## Test recipients (test number only)

While you use Meta's test phone number, it can only message numbers you add yourself:

1. App Dashboard > WhatsApp > API Setup > **To**: add your phone number (up to five) and confirm the code WhatsApp sends.
2. Send a message from that phone to the test number first. Free-form replies (`sendText`) are allowed only within 24 hours of the customer's last message; outside that window use an approved template (`sendTemplate`).
3. Sending to any other number fails with `WHATSAPP_RECIPIENT_NOT_ALLOWED` (Meta error 131030).

## How the code handles it

| Part | Behaviour |
| --- | --- |
| `GET /api/webhooks/whatsapp` | Answers `hub.challenge` as plain text only when `hub.mode=subscribe` and the verify token matches (constant-time); otherwise 403 |
| `POST /api/webhooks/whatsapp` | Public (Meta cannot sign in). Keeps the raw body (`express.raw` mounted before `express.json`) and rejects a missing or wrong `X-Hub-Signature-256` with 401; 503 if `WHATSAPP_APP_SECRET` is unset |
| Messages | One transaction per message: `webhook_events` row (`message:<wamid>`), customer (`+` added to the WhatsApp ID), the customer's one open conversation, inbound message. Text, button, interactive and media captions become `content`; other types are kept with no content |
| Duplicates | The unique `(source, external_event_id)` key: a redelivered message or status is counted as a duplicate and changes nothing |
| Statuses | Update outbound messages only, forward only (`sent` > `delivered` > `read`); `failed` keeps Meta's error code and title |
| Ignored | Other webhook fields, other phone number IDs, malformed items |
| Errors | A database error returns 5xx, so Meta retries; saved items then count as duplicates. Logs carry counts, never message content |
| Sending | Graph API `v23.0` (`GRAPH_VERSION` in `services/whatsapp/index.ts`), 15 s timeout, up to 3 attempts on 429/502/503/504 or a connection that never opened. A timeout is not retried, because the message may already be sent |

**Proxy note:** if nginx uses basic auth, give `/api/webhooks/` its own `location` with `auth_basic off`, or Meta is blocked.

**Not built yet:** replying automatically (AI), saving outbound messages from the reply flow, and honouring `customers.opted_out_at`.

## Before going live

These are outside the test number flow. Confirm each against Meta's current documentation when you reach it, because they have not been verified in this project:

- Registering a real business phone number, including its PIN step
- Business verification and display name approval
- Message template approval
- Current per-message pricing for your customers' country

## Definition of "connected"

Only after all of these succeed on real infrastructure, with the results recorded:

1. Meta accepts the callback URL (Verify and Save).
2. A message from a real phone appears in `webhook_events` and `messages`, with its signature verified.
3. A request with a bad signature is rejected.
4. A reply from `sendText` arrives on that phone, and its delivery status comes back through the webhook.

## Sources

- [Meta: get started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started) (app, API Setup, token types, system user permissions)
- [Meta: test webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/set-up-whatsapp-echo-bot) (handshake, `messages` field)
- [Meta: webhooks getting started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/) (signature header)
- [Meta: managing webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks/) (`subscribed_apps`)
