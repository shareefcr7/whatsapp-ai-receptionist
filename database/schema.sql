-- 001_initial_schema: core tables for the WhatsApp AI Receptionist.
-- gen_random_uuid() is built in from PostgreSQL 13.
-- btree_gist is what lets the appointments overlap constraint compare staff_id with =.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  text NOT NULL UNIQUE CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$'), -- E.164
  name          text,
  email         text,
  language      text,
  opted_out_at  timestamptz, -- set when the customer asks not to be messaged
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  full_name      text NOT NULL,
  password_hash  text, -- nullable until dashboard login is built
  role           text NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_users_email_key ON staff_users (lower(email));

CREATE TABLE services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL UNIQUE,
  description       text,
  duration_minutes  integer NOT NULL CHECK (duration_minutes > 0),
  price_amount      numeric(12, 2) CHECK (price_amount >= 0),
  currency          char(3),
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (price_amount IS NULL OR currency IS NOT NULL)
);

-- Knowledge the AI may answer from: hours, address, policies, FAQs.
CREATE TABLE business_info (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE,
  category      text NOT NULL DEFAULT 'general',
  title         text NOT NULL,
  content       text NOT NULL,
  is_published  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  assigned_staff_id  uuid REFERENCES staff_users (id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'handover_requested', 'human_active', 'closed')),
  last_message_at    timestamptz,
  closed_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- A customer has at most one live thread, even if two webhooks race.
CREATE UNIQUE INDEX conversations_one_active_per_customer
  ON conversations (customer_id) WHERE status <> 'closed';
CREATE INDEX conversations_customer_id_idx ON conversations (customer_id);
CREATE INDEX conversations_assigned_staff_id_idx ON conversations (assigned_staff_id);
CREATE INDEX conversations_status_last_message_idx ON conversations (status, last_message_at DESC);

CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  direction            text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_type          text NOT NULL CHECK (sender_type IN ('customer', 'ai', 'staff', 'system')),
  message_type         text NOT NULL DEFAULT 'text',
  content              text,
  whatsapp_message_id  text UNIQUE, -- NULL until WhatsApp assigns one; NULLs do not conflict
  -- 'unknown' (004): WhatsApp did not confirm the send; it may have reached the customer.
  status               text NOT NULL DEFAULT 'received'
                       CONSTRAINT messages_status_check
                       CHECK (status IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'unknown')),
  error_message        text,
  staff_id             uuid REFERENCES staff_users (id), -- 004: the signed-in sender of a staff message
  client_message_id    uuid UNIQUE, -- 004: dashboard per-draft key, so a repeated submission does not send twice
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_created_at_idx ON messages (created_at);
CREATE INDEX messages_staff_id_idx ON messages (staff_id);

CREATE TABLE leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  conversation_id    uuid REFERENCES conversations (id) ON DELETE SET NULL,
  service_id         uuid REFERENCES services (id) ON DELETE SET NULL,
  assigned_staff_id  uuid REFERENCES staff_users (id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'lost')),
  source             text NOT NULL DEFAULT 'whatsapp',
  interest           text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_customer_id_idx ON leads (customer_id);
CREATE INDEX leads_conversation_id_idx ON leads (conversation_id);
CREATE INDEX leads_service_id_idx ON leads (service_id);
CREATE INDEX leads_assigned_staff_id_idx ON leads (assigned_staff_id);
CREATE INDEX leads_status_created_idx ON leads (status, created_at DESC);

CREATE TABLE appointments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id               uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  service_id                uuid REFERENCES services (id) ON DELETE SET NULL,
  staff_id                  uuid REFERENCES staff_users (id) ON DELETE SET NULL,
  conversation_id           uuid REFERENCES conversations (id) ON DELETE SET NULL,
  starts_at                 timestamptz NOT NULL,
  ends_at                   timestamptz NOT NULL,
  status                    text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  google_calendar_event_id  text UNIQUE,
  notes                     text,
  reminder_sent_at          timestamptz,
  cancelled_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_valid_time CHECK (ends_at > starts_at),
  -- Same staff member cannot hold two live bookings at once. Appointments with
  -- no staff_id are not checked: staff_id = NULL never matches.
  CONSTRAINT appointments_no_staff_overlap EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('pending', 'confirmed'))
);
CREATE INDEX appointments_customer_id_idx ON appointments (customer_id);
CREATE INDEX appointments_service_id_idx ON appointments (service_id);
CREATE INDEX appointments_conversation_id_idx ON appointments (conversation_id);
CREATE INDEX appointments_status_starts_idx ON appointments (status, starts_at);
CREATE INDEX appointments_starts_at_idx ON appointments (starts_at);

CREATE TABLE handover_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  staff_id         uuid REFERENCES staff_users (id) ON DELETE SET NULL,
  reason           text,
  status           text NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested', 'accepted', 'resolved', 'cancelled')),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  accepted_at      timestamptz,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handover_logs_conversation_id_idx ON handover_logs (conversation_id);
CREATE INDEX handover_logs_staff_id_idx ON handover_logs (staff_id);
CREATE INDEX handover_logs_status_idx ON handover_logs (status);

CREATE TABLE usage_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL CHECK (provider IN ('openai', 'whatsapp', 'google_calendar')),
  operation        text NOT NULL,
  model            text,
  input_tokens     integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens    integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  units            integer NOT NULL DEFAULT 1 CHECK (units >= 0),
  estimated_cost   numeric(12, 6) CHECK (estimated_cost >= 0),
  currency         char(3) NOT NULL DEFAULT 'USD',
  conversation_id  uuid REFERENCES conversations (id) ON DELETE SET NULL,
  message_id       uuid REFERENCES messages (id) ON DELETE SET NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_logs_occurred_provider_idx ON usage_logs (occurred_at, provider);
CREATE INDEX usage_logs_conversation_id_idx ON usage_logs (conversation_id);
CREATE INDEX usage_logs_message_id_idx ON usage_logs (message_id);

-- Webhook inbox: the unique key makes retried deliveries harmless.
CREATE TABLE webhook_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source             text NOT NULL CHECK (source IN ('whatsapp', 'google_calendar')),
  external_event_id  text,
  event_type         text,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  error_message      text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_event_id)
);
CREATE INDEX webhook_events_status_received_idx ON webhook_events (status, received_at);

CREATE TRIGGER customers_set_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER staff_users_set_updated_at BEFORE UPDATE ON staff_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER services_set_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER business_info_set_updated_at BEFORE UPDATE ON business_info FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER conversations_set_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER messages_set_updated_at BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER leads_set_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER appointments_set_updated_at BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER handover_logs_set_updated_at BEFORE UPDATE ON handover_logs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER usage_logs_set_updated_at BEFORE UPDATE ON usage_logs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER webhook_events_set_updated_at BEFORE UPDATE ON webhook_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 002_staff_sessions: server-side dashboard sessions, so logout and deactivation take effect at once.
-- Only a SHA-256 of the token is stored: a leaked table cannot be replayed as a login.
CREATE TABLE staff_sessions (
  token_hash  text PRIMARY KEY,
  staff_id    uuid NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_sessions_staff_id_idx ON staff_sessions (staff_id);

-- 003_google_calendar: OAuth state for the consent round trip, and the one Google Calendar connection.
-- Only a SHA-256 of each state is stored, and a state is deleted when used, so it cannot be replayed.
CREATE TABLE google_oauth_states (
  state_hash     text PRIMARY KEY,
  staff_id       uuid NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
  code_verifier  text NOT NULL, -- PKCE: useless without the authorization code Google sends back
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- One row at most: the business has one calendar. Tokens are AES-256-GCM ciphertext, never plaintext.
CREATE TABLE google_calendar_connection (
  id                       boolean PRIMARY KEY DEFAULT true CHECK (id),
  status                   text NOT NULL CHECK (status IN ('connected', 'reconnect_required')),
  refresh_token_enc        text,
  access_token_enc         text,
  access_token_expires_at  timestamptz,
  scopes                   text NOT NULL,
  connected_by             uuid REFERENCES staff_users (id) ON DELETE SET NULL,
  connected_at             timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'connected' OR refresh_token_enc IS NOT NULL)
);
CREATE TRIGGER google_calendar_connection_set_updated_at BEFORE UPDATE ON google_calendar_connection
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 004_delivery_unknown_and_audit: append-only audit trail of staff actions.
CREATE TABLE conversation_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- also the order events happened in
  -- 005: RESTRICT, so deleting a conversation or message with audit history fails instead of erasing it.
  conversation_id  uuid NOT NULL CONSTRAINT conversation_events_conversation_id_fkey REFERENCES conversations (id) ON DELETE RESTRICT,
  staff_id         uuid NOT NULL REFERENCES staff_users (id),
  action           text NOT NULL CHECK (action IN ('staff_reply', 'takeover', 'reopen', 'close', 'reactivate')),
  message_id       uuid CONSTRAINT conversation_events_message_id_fkey REFERENCES messages (id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_events_conversation_idx ON conversation_events (conversation_id, id);
CREATE INDEX conversation_events_staff_id_idx ON conversation_events (staff_id);
-- 005: no UPDATE, DELETE or TRUNCATE, except in a transaction that sets receptionist.audit_maintenance = 'on'
-- (the documented customer-erasure procedure in 005_audit_integrity.sql; the app never sets it).
CREATE FUNCTION conversation_events_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('receptionist.audit_maintenance', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD); -- maintenance only; NULL for the statement-level TRUNCATE trigger
  END IF;
  RAISE EXCEPTION 'conversation_events is append-only (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER conversation_events_no_update BEFORE UPDATE ON conversation_events
  FOR EACH ROW EXECUTE FUNCTION conversation_events_append_only();
CREATE TRIGGER conversation_events_no_delete BEFORE DELETE ON conversation_events
  FOR EACH ROW EXECUTE FUNCTION conversation_events_append_only();
CREATE TRIGGER conversation_events_no_truncate BEFORE TRUNCATE ON conversation_events
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_events_append_only();
