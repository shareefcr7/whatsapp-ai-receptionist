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
