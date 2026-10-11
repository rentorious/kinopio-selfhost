-- Audio prep in the browser (docs/AUDIO-PREP.md §3): the uploaded file may be a
-- cut of the original. file_offset_ms is where its 0 sits in the original;
-- start_ms and end_ms stay positions in the original.
alter table media_jobs add column file_offset_ms bigint not null default 0;
