-- 002_staff_sessions: server-side dashboard sessions, so logout and deactivation take effect at once.
-- Only a SHA-256 of the token is stored: a leaked table cannot be replayed as a login.
CREATE TABLE staff_sessions (
  token_hash  text PRIMARY KEY,
  staff_id    uuid NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_sessions_staff_id_idx ON staff_sessions (staff_id);
