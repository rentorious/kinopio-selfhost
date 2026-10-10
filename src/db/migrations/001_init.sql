-- Initial schema. See docs/SPEC.md §5 for the reasoning.

create extension if not exists pg_trgm;

create table users (
  id                      text primary key,
  email                   text unique,
  password_hash           text,
  api_key                 text unique not null,
  prefs                   jsonb not null default '{}',
  cards_created_count     int not null default 0,
  cards_created_count_raw int not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table spaces (
  id                 text primary key,
  owner_id           text not null references users(id) on delete cascade,
  name               text not null default '',
  privacy            text not null default 'private' check (privacy in ('private', 'closed', 'open')),
  collaborator_key   text not null,
  read_only_key      text not null,
  is_removed         boolean not null default false,
  removed_by_user_id text,
  edited_at          timestamptz,
  edited_by_user_id  text,
  meta               jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index spaces_owner_idx on spaces (owner_id, is_removed, updated_at desc);

create table items (
  space_id   text not null references spaces(id) on delete cascade,
  type       text not null check (type in ('card', 'connection', 'box', 'list', 'line', 'tag', 'drawingStroke')),
  id         text not null,
  user_id    text,
  data       jsonb not null,
  seq        bigserial,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (space_id, type, id)
);
create index items_space_type_seq_idx on items (space_id, type, seq);

create table applied_operations (
  operation_id text primary key,
  applied_at   timestamptz not null default now()
);
create index applied_operations_applied_at_idx on applied_operations (applied_at);
