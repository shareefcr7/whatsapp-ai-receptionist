-- 006_anthropic_usage: record usage for Anthropic Claude replies (AI_PROVIDER=anthropic). Additive only: every existing
-- row still satisfies the wider check, and no row is changed or removed.
ALTER TABLE usage_logs DROP CONSTRAINT usage_logs_provider_check;
ALTER TABLE usage_logs ADD CONSTRAINT usage_logs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'whatsapp', 'google_calendar'));
