-- Media summaries (docs/MEDIA-SUMMARIES.md §13). The media file itself is never
-- stored: it lives in MEDIA_TMP_DIR/<id> until the PC worker has downloaded it.

create table media_jobs (
  id                  text primary key,
  user_id             text not null references users(id) on delete cascade,
  space_id            text not null,
  card_id             text not null,
  -- where the placeholder card was dropped, in case it never reached the server
  card_x              double precision,
  card_y              double precision,
  -- public origin the upload came in on, for links in the result
  origin              text not null,
  file_name           text not null,
  mime_type           text not null default 'application/octet-stream',
  bytes               bigint,
  start_ms            bigint not null,
  end_ms              bigint not null,
  language            text not null default 'auto',
  topic               text not null default '',
  status              text not null check (status in
                        ('uploading', 'queued', 'downloading', 'transcribing', 'summarizing',
                         'building', 'done', 'failed', 'canceled')),
  percent             int,
  error               text,
  transcript_space_id text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index media_jobs_active_idx on media_jobs (created_at) where status not in ('done', 'failed', 'canceled');
create index media_jobs_card_idx on media_jobs (card_id);
