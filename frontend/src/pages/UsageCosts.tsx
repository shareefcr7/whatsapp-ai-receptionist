import { Card, DataStateNotice, DataTable, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui';
import { useApi } from '../lib/api';
import type { UsageRow } from '../lib/api';
import { formatStatus, formatUsd } from '../lib/format';

// Planning assumptions and prices match docs/cost-estimation.md. Prices checked 2026-11-09.
const CONVERSATIONS = 1_000;
const RESPONSES = 10;
const INPUT_MILLIONS = (CONVERSATIONS * RESPONSES * 1_500) / 1_000_000;
const OUTPUT_MILLIONS = (CONVERSATIONS * RESPONSES * 300) / 1_000_000;

const MODELS = [
  { id: 'gpt-5-nano', input: 0.05, output: 0.4 },
  { id: 'gpt-6-luna', input: 0.1, output: 0.5 },
  { id: 'gpt-4o-mini', input: 0.15, output: 0.6 },
  { id: 'gpt-5.4-nano', input: 0.2, output: 1.25 },
].map((m) => ({ ...m, monthly: INPUT_MILLIONS * m.input + OUTPUT_MILLIONS * m.output }));

export function UsageCosts() {
  const { result, error, loading, refetch } = useApi<(UsageRow & { id?: string })[]>('/usage');
  const rows = result?.data.map((row) => ({ ...row, id: `${row.provider}/${row.model}/${row.currency}` }));

  return (
    <>
      <PageHeader title="Usage & Costs" description="Recorded usage is kept separate from the planning estimate. Neither is a provider invoice." />
      <DataStateNotice state={result?.meta.dataState} />

      <Card title="Recorded usage, this month" className="mb-6">
        {loading ? (
          <Skeleton />
        ) : error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : rows?.length ? (
          <DataTable
            rows={rows}
            columns={[
              { header: 'Provider', cell: (r) => formatStatus(r.provider) },
              { header: 'Model', cell: (r) => r.model ?? '—' },
              { header: 'Events', cell: (r) => r.events },
              { header: 'Input tokens', cell: (r) => r.inputTokens },
              { header: 'Output tokens', cell: (r) => r.outputTokens },
              { header: 'Estimated cost', cell: (r) => (r.estimatedCost ? `${r.estimatedCost} ${r.currency}` : '—') },
            ]}
          />
        ) : result?.meta.dataState === 'database_not_configured' ? (
          <EmptyState title="Cannot load usage">Connect a database to see real records.</EmptyState>
        ) : (
          <EmptyState title="No usage recorded">Usage is logged once the AI and WhatsApp integrations are live.</EmptyState>
        )}
      </Card>

      <Card
        title="OpenAI planning estimate"
        action={<span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-800">Not real usage</span>}
      >
        <p className="px-5 pt-4 text-sm text-stone-600">
          {CONVERSATIONS.toLocaleString()} conversations × {RESPONSES} AI responses = {INPUT_MILLIONS}M input and {OUTPUT_MILLIONS}M output tokens a month.
        </p>
        <DataTable
          rows={MODELS}
          columns={[
            { header: 'Model', cell: (m) => <span className="font-medium">{m.id}</span> },
            { header: 'Input / 1M', cell: (m) => formatUsd(m.input) },
            { header: 'Output / 1M', cell: (m) => formatUsd(m.output) },
            { header: 'Monthly AI cost', cell: (m) => <span className="font-medium tabular-nums">{formatUsd(m.monthly)}</span> },
          ]}
        />
        <p className="border-t border-stone-100 px-5 py-3 text-xs text-stone-500">
          AI tokens only, using list prices checked on 9 Nov 2026. WhatsApp messaging, hosting and database costs are separate; see docs/cost-estimation.md.
        </p>
      </Card>
    </>
  );
}
