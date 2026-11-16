-- 005_audit_integrity: make conversation_events (004) append-only in practice, not just against UPDATE.
--
-- Policy
-- - Audit events cannot be updated, deleted or truncated by ordinary database operations, including cascades.
-- - A customer, conversation or message that has audit events cannot be deleted: the delete fails rather than
--   silently erasing who did what. (Before 005, deleting a customer cascaded through conversations and removed their
--   audit history; deleting one staff message failed confusingly, because ON DELETE SET NULL is an UPDATE that the
--   append-only trigger refused.)
-- - A staff member with audit history or sent messages cannot be deleted (unchanged from 004): deactivate them
--   (UPDATE staff_users SET is_active = false) instead.
--
-- Erasing a customer who has audit history (a deliberate, recorded data-protection request only; the app has no API
-- for it). Run by a database administrator, in one transaction, so the bypass ends with it:
--   BEGIN;
--   SET LOCAL receptionist.audit_maintenance = 'on';
--   DELETE FROM conversation_events WHERE conversation_id IN (SELECT id FROM conversations WHERE customer_id = '<id>');
--   DELETE FROM customers WHERE id = '<id>';   -- cascades to conversations and messages as before
--   COMMIT;
-- This protects against accidental and application-level deletion. It is not tamper-proof against the database
-- owner, who can also drop triggers; for that, run the app as a role that does not own these tables.

CREATE OR REPLACE FUNCTION conversation_events_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('receptionist.audit_maintenance', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD); -- maintenance only; NULL for the statement-level TRUNCATE trigger
  END IF;
  RAISE EXCEPTION 'conversation_events is append-only (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversation_events_no_delete BEFORE DELETE ON conversation_events
  FOR EACH ROW EXECUTE FUNCTION conversation_events_append_only();
CREATE TRIGGER conversation_events_no_truncate BEFORE TRUNCATE ON conversation_events
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_events_append_only();

-- Deleting what an event points at is refused, instead of cascading (conversation) or nulling (message) the event.
ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_conversation_id_fkey;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE RESTRICT;
ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_message_id_fkey;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT;
