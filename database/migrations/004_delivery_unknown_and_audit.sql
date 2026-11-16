-- 004_delivery_unknown_and_audit: an 'unknown' delivery status, staff attribution on messages, and an append-only
-- audit trail of staff actions. Additive only: no existing row is changed or removed.

-- 'unknown': WhatsApp did not confirm the send (timeout, dropped connection, 5xx); it may have reached the customer.
ALTER TABLE messages DROP CONSTRAINT messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'unknown'));

-- Who sent a staff message: always the signed-in staff member, never a value from the request.
-- No ON DELETE action: a staff member with history is deactivated (is_active = false), not deleted.
ALTER TABLE messages ADD COLUMN staff_id uuid REFERENCES staff_users (id);
CREATE INDEX messages_staff_id_idx ON messages (staff_id);
-- The dashboard's per-draft key: a repeated submission returns the first message instead of sending again.
ALTER TABLE messages ADD COLUMN client_message_id uuid UNIQUE;

CREATE TABLE conversation_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- also the order events happened in
  conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  staff_id         uuid NOT NULL REFERENCES staff_users (id),
  action           text NOT NULL CHECK (action IN ('staff_reply', 'takeover', 'reopen', 'close', 'reactivate')),
  message_id       uuid REFERENCES messages (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_events_conversation_idx ON conversation_events (conversation_id, id);
CREATE INDEX conversation_events_staff_id_idx ON conversation_events (staff_id);

-- Append-only: no code path updates an event, and the database refuses it too. (Deleting a customer still removes
-- their conversations and these events with them, by cascade.)
CREATE FUNCTION conversation_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'conversation_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER conversation_events_no_update BEFORE UPDATE ON conversation_events
  FOR EACH ROW EXECUTE FUNCTION conversation_events_append_only();
