-- Central rate-limit buckets shared by all Vercel instances.
create table if not exists public.api_rate_limits (
  bucket text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.api_rate_limits enable row level security;
revoke all on table public.api_rate_limits from anon, authenticated;

create or replace function public.consume_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.api_rate_limits%rowtype;
  next_count integer;
begin
  if p_bucket is null or length(p_bucket) = 0 then
    return jsonb_build_object('allowed', true, 'count', 0);
  end if;
  insert into public.api_rate_limits(bucket, window_started_at, request_count, updated_at)
    values (p_bucket, now(), 0, now())
    on conflict (bucket) do nothing;
  select * into current_row from public.api_rate_limits where bucket = p_bucket for update;
  if now() - current_row.window_started_at >= make_interval(secs => greatest(1, p_window_seconds)) then
    update public.api_rate_limits
       set window_started_at = now(), request_count = 1, updated_at = now()
     where bucket = p_bucket;
    return jsonb_build_object('allowed', true, 'count', 1);
  end if;
  next_count := current_row.request_count + 1;
  update public.api_rate_limits set request_count = next_count, updated_at = now() where bucket = p_bucket;
  return jsonb_build_object('allowed', next_count <= greatest(1, p_limit), 'count', next_count);
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
