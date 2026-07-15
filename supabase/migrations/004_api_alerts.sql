-- Central API alert sink. Only the server's service role can write/read this
-- table; browser clients must never receive operational error history.
create table if not exists public.api_alerts (
  id uuid primary key default gen_random_uuid(),
  request_id text,
  event text not null default 'api.error',
  method text,
  path text,
  status integer not null default 500,
  duration_ms integer not null default 0,
  ip text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists api_alerts_created_at_idx on public.api_alerts (created_at desc);
create index if not exists api_alerts_status_idx on public.api_alerts (status, created_at desc);

alter table public.api_alerts enable row level security;
revoke all on table public.api_alerts from anon, authenticated;
grant all on table public.api_alerts to service_role;
