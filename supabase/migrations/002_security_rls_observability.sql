-- Finder v1: ownership, Studio membership and explicit RLS policies.
-- The API continues to use service_role for server-only operations; these
-- policies protect the tables if a client key is ever used accidentally.

create table if not exists public.studios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.studio_members (
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (studio_id, user_id)
);

alter table public.albums add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table public.albums add column if not exists studio_id uuid references public.studios(id) on delete set null;
create index if not exists albums_owner_id_idx on public.albums (owner_id);
create index if not exists albums_studio_id_idx on public.albums (studio_id);

create or replace function public.is_album_member(album_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.albums a
    where a.id = album_id
      and (
        a.owner_id = auth.uid()
        or exists (
          select 1 from public.studio_members sm
          where sm.studio_id = a.studio_id and sm.user_id = auth.uid()
        )
      )
  );
$$;

alter table public.studios enable row level security;
alter table public.studio_members enable row level security;

drop policy if exists studios_owner_select on public.studios;
create policy studios_owner_select on public.studios
  for select to authenticated
  using (owner_id = auth.uid() or exists (
    select 1 from public.studio_members sm
    where sm.studio_id = studios.id and sm.user_id = auth.uid()
  ));

drop policy if exists studios_owner_write on public.studios;
create policy studios_owner_write on public.studios
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists studio_members_self_select on public.studio_members;
create policy studio_members_self_select on public.studio_members
  for select to authenticated
  using (user_id = auth.uid() or exists (
    select 1 from public.studios s
    where s.id = studio_members.studio_id and s.owner_id = auth.uid()
  ));

drop policy if exists studio_members_owner_write on public.studio_members;
create policy studio_members_owner_write on public.studio_members
  for all to authenticated
  using (exists (
    select 1 from public.studios s
    where s.id = studio_members.studio_id and s.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.studios s
    where s.id = studio_members.studio_id and s.owner_id = auth.uid()
  ));

drop policy if exists albums_member_select on public.albums;
create policy albums_member_select on public.albums
  for select to authenticated
  using (public.is_album_member(id));

drop policy if exists albums_owner_write on public.albums;
create policy albums_owner_write on public.albums
  for all to authenticated
  using (owner_id = auth.uid() or exists (
    select 1 from public.studio_members sm
    where sm.studio_id = albums.studio_id and sm.user_id = auth.uid() and sm.role in ('owner', 'admin')
  ))
  with check (owner_id = auth.uid() or exists (
    select 1 from public.studio_members sm
    where sm.studio_id = albums.studio_id and sm.user_id = auth.uid() and sm.role in ('owner', 'admin')
  ));

drop policy if exists album_events_member_select on public.album_events;
create policy album_events_member_select on public.album_events
  for select to authenticated
  using (public.is_album_member(album_id));

drop policy if exists album_events_member_insert on public.album_events;
create policy album_events_member_insert on public.album_events
  for insert to authenticated
  with check (public.is_album_member(album_id));

-- OAuth refresh tokens are server-only. No anon/authenticated policy is
-- intentionally created for drive_tokens; service_role bypasses RLS.
revoke all on table public.drive_tokens from anon, authenticated;
revoke all on table public.albums from anon;
revoke all on table public.album_events from anon;
revoke all on table public.studios from anon;
revoke all on table public.studio_members from anon;
