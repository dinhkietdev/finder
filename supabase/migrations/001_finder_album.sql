create extension if not exists pgcrypto;

create table if not exists public.albums (
  id text primary key,
  public_slug text not null unique,
  gallery_type text not null default 'selection',
  drive_folder_id text,
  original_folder_id text,
  settings jsonb not null default '{}'::jsonb,
  state jsonb not null default '{}'::jsonb,
  history jsonb not null default '{}'::jsonb,
  is_finalized boolean not null default false,
  workflow_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists albums_gallery_type_idx on public.albums (gallery_type);
create index if not exists albums_updated_at_idx on public.albums (updated_at desc);

create table if not exists public.drive_tokens (
  album_id text primary key references public.albums(id) on delete cascade,
  token jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.album_events (
  id uuid primary key default gen_random_uuid(),
  album_id text not null references public.albums(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists album_events_album_idx on public.album_events (album_id, created_at desc);

alter table public.albums enable row level security;
alter table public.drive_tokens enable row level security;
alter table public.album_events enable row level security;

comment on table public.drive_tokens is 'Server-only OAuth tokens. Never expose this table to anon/authenticated clients.';
