# Development plan

Day numbers show order, not a commitment. Items that depend on external access can't finish until that access exists.

## Day 1: foundation (complete)

Backend API, dashboard, database schema, migrations, service interfaces, documentation and cost estimate. Nothing external is connected.

## Day 2: data and access (complete)

PostgreSQL connected. Staff login with server-side sessions and admin and agent roles, with all dashboard routes protected. Business information and services managed from the dashboard. WhatsApp requirements documented in [whatsapp-setup.md](whatsapp-setup.md). Real business information and the first admin user are still to be entered by the business.

## Next steps

| Phase | Work | Needs from the business |
| --- | --- | --- |
| **Day 3: WhatsApp inbound** | Webhook verification and signature checks, `webhook_events` inbox, save customers and messages, dashboard message thread | Everything listed in [whatsapp-setup.md](whatsapp-setup.md), including the app secret and a public HTTPS URL (a tunnel works for testing) |
| **Day 4: AI replies** | OpenAI service, prompt built from published knowledge, send replies, record `usage_logs`, evaluate candidate models against real questions | OpenAI API key with a spend limit, sample customer questions |
| **Day 5: Leads and handover** | Capture leads from conversations, handover rules, staff replies from the dashboard, stop AI during human handling | Handover rules, staff list |
| **Day 6: Booking** | Availability, book, reschedule and cancel, Google Calendar sync | Google Cloud project, calendar to use, working hours and service durations |
| **Day 7: Reminders and launch** | Approved utility templates, confirmations and reminders, opt-out handling, retention policy, deployment, monitoring and backups | Hosting decision, approved templates, Meta business verification |

## Rules of the road

- An integration counts as working only after a real test against the provider.
- Set a hard spend limit on OpenAI before the first production call.
- Every new query needs a test against real PostgreSQL. Run with `TEST_DATABASE_URL` set.
- Schema changes get a new numbered migration, never an edit to an applied one. Update `database/schema.sql` in the same change.

## Decisions needed

| Decision | Why it matters |
| --- | --- |
| Main customer country or countries | Sets WhatsApp rates, language handling and timezone. This is now the largest unknown cost |
| Hosting: existing VPS or other | Sets hosting and database cost and the deployment steps |
| Does each booking need a specific staff member? | Decides how double-booking is prevented |
| How long to keep conversations | Privacy obligations and storage |
| AI behaviour when unsure | Answer, ask or hand over. Affects customer trust and staff load |
