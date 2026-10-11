# Media summaries

Milestone **M2b**: after the websocket relay (M2), before M3. **Built.** Setting up the worker on the PC: [worker/README.md](../worker/README.md). Drop an audio or video file on the canvas, pick the part you want, and get a **summary card** in the current space plus a linked **transcript space**. Transcription and summarizing run on a worker on your own PC; the server only passes the file through and never keeps it.

## 1. Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the work runs | A **worker on the home PC** (AMD GPU): whisper.cpp with Vulkan for speech-to-text, a headless Claude Code session for the summary | Railway has no GPU. The PC is always on, already runs whisper.cpp on its GPU, and is logged in to Claude Code. |
| How the worker connects | **Outbound only**: the worker opens a websocket to the server and pulls files over HTTPS | No port forwarding, which keeps SPEC §2's "no home-server networking". The server always knows whether the worker is online. |
| Transcript | A **linked transcript space**: one card per section, with timestamps | Cards cap at 4,000 characters (`consts.cardCharacterLimit`); an hour of speech is ~50,000. A space keeps it native: editable, and searchable once M3 search lands. |
| Trimming | **On the worker** with ffmpeg; the browser uploads the whole file plus the chosen range | Files are up to ~300 MB. No ffmpeg.wasm in the client. |
| Upload path | **Straight to the bucket** with a signed PUT link that works for 60 minutes; the worker downloads it the same way | Railway's proxy cuts request bodies off after 5 minutes, which a long video on a home connection doesn't beat. Without a bucket (local dev) the file goes through the server as a form. |
| Summary format | **Abstract + key points** on the card | Both were wanted. |
| Media storage | **Never kept**: in the bucket under `.media/` until the worker has it, worker temp folder until the job ends | See §6. |
| Worker offline | The client **checks first and blocks**; no queueing for later | Queueing would leave the media sitting on the server. Open question 1. |

## 2. User flow

1. Drop (or paste) one audio or video file on a space you can edit. Instead of uploading it, the client opens the **Media summary** dialog.
2. The dialog shows the worker's status. When it's offline it says "Transcriber offline (last seen 14:02)", and only **Upload as file** and **Cancel** work.
3. The file plays from your disk (an object URL; nothing is uploaded yet). Scrub, then **Set at playhead** for the start or the end, or type `m:ss` / `h:mm:ss`. **Play from start** plays the selection, **Whole file** resets it, and the dialog shows the selected length. If the browser can't play the file, the whole file is processed (up to `MEDIA_MAX_MINUTES`).
4. Pick the **language** (remembered per device) and optionally a **topic hint** (e.g. "rhizosphere microbiome, viticulture").
5. **Summarize**: a placeholder card appears at the drop point with the usual upload progress bar, and the dialog closes.
6. The card text follows the stages ("⏳ lecture.mp4 · transcribing 40%"), live on every open device.
7. When it's done, the same card becomes the summary card, with a link to the new transcript space.

Deleting the placeholder card cancels the job.

## 3. Pieces

| Piece | Runs on | Does |
|---|---|---|
| Client Patch 4 | Browser | Catches audio/video drops; the dialog; the placeholder card; the upload (§11) |
| `src/media/` module | Railway service | Client endpoints, job table, temp files, worker socket, building the card and transcript space, live updates |
| `worker/` | Home PC | Connects to the server, downloads the file, cuts it, transcribes it, runs the Claude session, sends back the result |

The worker lives in this repo (`worker/`, TypeScript) and shares the result schema with the server (`src/media/contract.ts`). It isn't part of the Docker image.

## 4. Job lifecycle

```
uploading → queued → downloading → transcribing → summarizing → building → done
    any state ─────────────────────────────────────────────────→ failed | canceled
```

| State | Where the media is | Card text |
|---|---|---|
| `uploading` | Streaming into the server's temp dir | (upload progress bar) |
| `queued` | Server temp dir | ⏳ name · waiting for transcriber |
| `downloading` | Server → worker | ⏳ name · sending to transcriber |
| `transcribing` | Worker only (server copy deleted) | ⏳ name · transcribing 40% |
| `summarizing` | Deleted; only the transcript text exists | ⏳ name · summarizing |
| `building` | — | ⏳ name · creating transcript |
| `done` | — | The summary card (§8) |
| `failed` | Deleted | ⚠️ name · reason · drop the file again to retry |

One job runs at a time (one GPU). A second drop while a job is running waits in `queued` with its file on the server's temp disk; the age cap in §6 still applies.

## 5. Worker connection and availability

- The worker connects to `wss://<origin>/api/worker/ws` with `Authorization: Bearer <WORKER_TOKEN>` (server env, compared in constant time). One worker at a time: a new connection replaces the old one.
- The server pings every 15 s and drops a worker that misses a ping, so a dead connection shows as offline within 30 s. The worker counts as **online** while its socket is open.
- Worker presence is kept in memory (one service instance, no table).

Socket messages:

| Direction | `type` | Fields |
|---|---|---|
| worker → server | `hello` | `version`, `model`, `gpu`, `activeJobId?` |
| server → worker | `job` | `jobId`, `fileName`, `mimeType`, `bytes`, `startMs`, `endMs`, `language`, `topic` |
| worker → server | `downloaded` | `jobId` (the server deletes its copy) |
| worker → server | `progress` | `jobId`, `stage` (`transcribing` \| `summarizing`), `percent?` |
| worker → server | `failed` | `jobId`, `reason` |
| server → worker | `cancel` | `jobId` |

The file and the result go over HTTP, not the socket (the file can be 250 MB):

- `GET /api/worker/jobs/:id/media` streams the temp file. Worker token required; `404` once deleted.
- `POST /api/worker/jobs/:id/result` takes the result JSON (§7.3).

**Worker drops mid-job:** if it reconnects within 2 minutes and sends `hello` with `activeJobId`, the job carries on. Otherwise it fails with "transcriber went offline".

**Client side:** `GET /api/media-summaries/status` returns `{ online, lastSeenAt, busy, queued, model }`. The dialog calls it when it opens and every 10 s while it's open.

## 6. The media file is never kept

- With a bucket, the browser uploads it to `.media/<jobId>` in the bucket with a signed PUT link (60 minutes), then calls `POST /api/media-summaries/:id/uploaded`. The worker's `GET /api/worker/jobs/:id/media` redirects to a signed GET link (30 minutes). The leading dot keeps these keys out of `GET /files/*`. Without a bucket, the server writes the file to `MEDIA_TMP_DIR/<jobId>` (the container's ephemeral disk). Never the database.
- The browser's PUT needs a CORS rule on the bucket allowing `PUT` from the app's origin: `tools/bucket-cors.mjs` sets it (DEPLOY.md §6).
- The server deletes its copy when the worker sends `downloaded`, and when the job fails or is canceled. A sweep catches anything left over: on boot it deletes everything and marks unfinished jobs failed; every 10 minutes it fails jobs still uploading or waiting after `MEDIA_TMP_MAX_AGE` (default 2 h) and deletes any media no live job owns, on disk and under `.media/`.
- The worker keeps everything in `JOB_DIR/<jobId>/` and deletes the folder in a `finally` when the job ends, success or not.
- Logs carry file names and sizes, never contents.
- What *is* kept: the transcript text and the summary. They're the result.

## 7. Worker pipeline

### 7.1 Cut and convert

```bash
ffprobe media                     # reject files with no audio stream
ffmpeg -ss <start> -i media -t <length> -vn -ar 16000 -ac 1 -c:a pcm_s16le audio.wav
```

`-ss` before `-i` seeks fast. `-t` (a length) instead of `-to` avoids the input/output timestamp ambiguity when seeking on the input.

### 7.2 Transcribe

whisper.cpp built with Vulkan, the same setup as the manual run that worked on the PC's card:

```bash
whisper-cli -m ggml-large-v3.bin -f audio.wav -l <language|auto> \
  --vad -vm ggml-silero-v5.1.2.bin -mc 0 -et 2.8 -oj -pp
```

- `--vad -vm …` is added only when `VAD_MODEL` is set; the fallback rerun below only when `WHISPER_FALLBACK_MODEL` is set.
- `-mc 0 -et 2.8` stop the repetition loops large-v3 fell into on the test lecture. `-mc 0` also makes whisper ignore `--prompt`, so the topic hint goes to the Claude step instead.
- `-oj` writes segments with timestamps (used for section times). `-pp` prints progress, which the worker turns into `progress` messages, throttled to every 5% or 10 s.
- **Loop check:** if the same segment text repeats more than 5 times in a row, rerun once with the fallback model (`ggml-large-v2.bin`).

### 7.3 Summarize: a headless Claude Code session

The worker writes the inputs, runs one headless (print-mode) Claude Code session in the job folder, and reads back a fixed file structure:

```
JOB_DIR/<jobId>/
  input/
    meta.json            fileName, startMs, endMs, durationMs, language, topic
    transcript.json      [{ startMs, endMs, text }] from whisper
  output/                the session writes only here
    card.md
    transcript/001.md, 002.md, …
    corrections.md       optional
```

The prompt lives in `worker/prompt.md`. It asks Claude to fix misheard terms using context and the topic hint while keeping the speaker's wording, to mark guesses with `[?]`, to split the transcript into sections at topic changes, and to write these files:

| File | Format | Limits |
|---|---|---|
| `card.md` | `# Title`, then `## Summary` (an abstract of 80–150 words), then `## Key points` (5–10 lines starting with `- `) | Title ≤ 80 chars. Whole file ≤ 3,200 chars, so the server's source line and link keep the card under 4,000. |
| `transcript/NNN.md` | Front matter `heading`, `start`, `end` (`m:ss` or `h:mm:ss`), then the cleaned text | Body ≤ 3,600 chars. A longer section continues in the next file with the same heading plus " (cont.)". Numbered in order from `001`. |
| `corrections.md` | Lines of `- heard → corrected`, uncertain ones marked `[?]` | ≤ 3,600 chars |

Kinopio card text renders `#` to `####` headings, bold, emphasis, strikethrough, code and links (`utils.markdown()` in the client). `- ` lines show as plain text, which reads fine.

Session constraints:

- It runs on the PC's Claude Code login (the subscription, like Taskflow), not an API key.
- Tools are limited to reading and writing inside the job folder: no shell, no web. The transcript is untrusted text; this is what keeps instructions spoken in the audio from doing anything.
- A turn cap (`CLAUDE_MAX_TURNS`, default 40) and a 15-minute timeout (`CLAUDE_TIMEOUT_MS`).
- Flags (`worker/src/summarize.ts`, checked against the Claude Code CLI reference): `-p <prompt> --output-format json --tools Read,Write,Edit,Glob --disallowedTools "mcp__*" --strict-mcp-config --permission-mode acceptEdits --max-turns 40 --no-session-persistence --restricted`, plus `--model` when `CLAUDE_MODEL` is set. `--restricted` needs Claude Code 2.1.248 or later; `CLAUDE_RESTRICTED=false` drops it on an older CLI.

The worker parses the files and checks every limit above. If anything fails, it reruns the session once with the errors appended. Then it posts:

```json
{
  "title": "The rhizosphere microbiome",
  "card": "# The rhizosphere microbiome\n## Summary\n…\n## Key points\n- …",
  "sections": [{ "heading": "What the rhizosphere is", "startMs": 312000, "endMs": 498000, "text": "…" }],
  "corrections": "- rhesus fur → rhizosphere\n…",
  "transcriber": { "model": "large-v3", "language": "en" }
}
```

The server validates the same limits again (`src/media/contract.ts`) before using any of it.

**If the session fails twice,** the worker still posts the transcript: `sections` built mechanically from the whisper segments (about 3,000 chars each, headed by their time range) and `card` set to `# <file name>` plus "Summary failed; the transcript is attached." A finished transcription is never lost.

## 8. What the server builds

Everything goes through `OperationsService.apply(userId, ops)` with the same ops the client sends: one `createSpace` with the transcript cards nested in it, then `updateCard` for the summary card. Ownership, merge rules and the spaces list behave exactly as if you had made the items by hand.

**Transcript space:** named `Transcript: <title>`, private, owned by you.

- First card: `# <title>`, the source line, and `Summary card: <link>` back to the space holding the summary card.
- One card per section: `**5:12–8:18 · <heading>**`, then the text. Cards are 520 px wide, stacked in one column; the server estimates each card's height from its text so they don't overlap (Kinopio lists weren't needed).
- Last card: the corrections, if there are any.

**Summary card:** the placeholder card is updated in place (same id and position), so the result lands exactly where you dropped the file, widened to 360 px:

```
<card.md>

🎧 lecture.mp4 · 5:00–55:00 (50 min) · English
<transcript space URL>
```

The client hides a space URL at the end of a card and shows it as a space link chip under the text. That needs **Patch 3** (CLIENT.md), and the chip's name comes from `POST /api/item/multiple`, so both moved from M3 into this milestone.

If the placeholder card hasn't reached the database yet when the result is ready (the client saves on its own schedule), the final update retries every 3 s for 30 s, then creates the card at the drop point (`card_x`, `card_y`).

## 9. Live updates

Stage text and the final summary reach open tabs through the relay. The server sends a server-originated action message to the space's room:

```json
{ "message": { "action": "updateCardsState", "store": "cardStore", "updates": [{ "id": "<cardId>", "name": "…" }] }, "spaceId": "<spaceId>" }
```

There's no `clientId`, so no client filters it out as its own (WEBSOCKET.md). The final update also carries `resizeWidth: 360`; the client re-measures the card, so it grows to fit the longer text. The same change is saved through `updateCard` with a fresh `nameUpdatedAt`, so a reload, or a device that was offline, gets it too.

## 10. Client endpoints

These are our own endpoints, not part of the client's API list (ENDPOINTS.md).

| Endpoint | Body | Response |
|---|---|---|
| `GET /api/media-summaries/status` | — | `{ online, lastSeenAt, busy, queued, model }` |
| `POST /api/media-summaries/direct` | JSON: the form fields below plus `mimeType` and `size` | `200 { jobId, url, method: 'PUT', headers }`: PUT the file to `url` with those headers. `404 { "error": "direct_unsupported" }` without a bucket |
| `POST /api/media-summaries/:id/uploaded` | — | `202 { jobId }` once the file is in the bucket; `400` if it isn't, `413` if it's too big, `409` if the job isn't uploading |
| `POST /api/media-summaries` | Multipart (no bucket): `spaceId`, `cardId`, `fileName`, `startMs`, `endMs`, `language`, `topic`, `x`, `y`, then `file` | `202 { jobId }` |
| `GET /api/media-summaries/:id` | — | `{ status, percent, error }` |
| `DELETE /api/media-summaries/:id` | — | `200 {}`; sends the worker `cancel` |

Both upload paths check, before any file is sent:

- Signed in, and allowed to edit `spaceId`.
- Worker online, else `503 { "error": "transcriber_offline" }`.
- Size under `MEDIA_MAX_BYTES` (default 300 MB), else `413`: the declared `size` and the file in the bucket for direct uploads, `Content-Length` and the stream for the form; selected range under `MEDIA_MAX_MINUTES` (default 180), else `400`.
- MIME type `audio/*` or `video/*`, else `415`. The worker's `ffprobe` is the real check.

A `removeCard` or `deleteCard` in `POST /operations` for a card with a running job cancels that job.

## 11. Client Patch 4: the media summary dialog

Two small hooks plus new files, so bumping the client rarely conflicts:

- **Hook 1:** `uploadStore.addCardsAndUploadFiles`. Drops on the canvas and on connections, keyboard paste and the image picker all go through it. If it gets exactly one file whose type starts with `audio/` or `video/`, it opens the dialog with `{ file, position }` and returns. An `asFile` flag skips the check for **Upload as file**. Dropping a file onto an existing card (`Card.vue`, `uploadStore.uploadFile`) attaches it to that card and stays a normal upload.
- **Hook 2:** mount the dialog in `Space.vue`, next to the other space dialogs.
- **New files:** `stores/useMediaSummaryStore.js` (open/close with `{ file, position }`) and `components/dialogs/MediaSummary.vue` (status, `<video>`/`<audio>` on an object URL, start/end, language, topic hint). The dialog calls the §10 endpoints itself; there's no separate API helper.
- **Upload:** create the placeholder card with `consts.uploadPlaceholder`, then ask for a direct upload, PUT the file to the bucket by XHR and confirm it; on `direct_unsupported`, send the form by XHR instead. If the PUT fails the dialog cancels the job. Progress goes through `addPendingUpload` (keyed by card id, **without** `spaceId`) and `updatePendingUpload`, so the card shows the usual progress bar. On load or error it's set to 100%, which is what clears the bar: the client's `removePendingUpload` keeps entries that carry the current `spaceId`, so a pending upload with one would stay at 99% forever.
- Upload or job errors turn the card into `⚠️ name · reason` and show a notification.
- Revoke the object URL when the dialog closes.

## 12. When things go wrong

| What happens | Result |
|---|---|
| Worker offline when you drop | The dialog says so; Summarize is disabled; nothing is uploaded |
| Upload interrupted | Job `failed`, temp file deleted, the card shows the error |
| Worker disconnects and is back within 2 min | The job continues |
| Worker gone longer | Job `failed`; files deleted on the server now and on the worker when it's back |
| whisper repetition loop | One rerun with the fallback model |
| Claude output invalid twice | Transcript-only result (§7.3) |
| You delete the placeholder card | Job `canceled`, worker told, files deleted |
| Server restarts | Unfinished jobs `failed`, temp dir wiped, their cards updated |

## 13. Data model

```sql
create table media_jobs (
  id                  text primary key,
  user_id             text not null references users(id) on delete cascade,
  space_id            text not null,
  card_id             text not null,
  card_x              double precision,     -- drop point, if the card has to be recreated
  card_y              double precision,
  origin              text not null,        -- public origin, for links in the result
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
```

There's no file path column: the temp file is always `MEDIA_TMP_DIR/<id>`.

## 14. Configuration

| Where | Variable | Default | Notes |
|---|---|---|---|
| Server | `WORKER_TOKEN` | — | Enables the feature. Without it, status always reports `online: false`. |
| Server | `MEDIA_TMP_DIR` | `<os tmpdir>/media-jobs` | Ephemeral disk |
| Server | `MEDIA_MAX_BYTES` | `314572800` (300 MB) | |
| Server | `MEDIA_MAX_MINUTES` | `180` | Length of the selected range |
| Server | `MEDIA_TMP_MAX_AGE` | `7200000` (2 h) | Sweep cutoff; longer than the 60-minute upload link |
| Worker | `SERVER_URL`, `WORKER_TOKEN` | — | Required |
| Worker | `WHISPER_BIN`, `WHISPER_MODEL` | `whisper-cli`, — | Paths from the whisper.cpp Vulkan build; the model is required |
| Worker | `WHISPER_FALLBACK_MODEL`, `VAD_MODEL`, `WHISPER_THREADS` | — | Optional |
| Worker | `FFMPEG_BIN`, `FFPROBE_BIN` | `ffmpeg`, `ffprobe` | |
| Worker | `CLAUDE_BIN`, `CLAUDE_MODEL` | `claude`, the CLI's default | |
| Worker | `CLAUDE_RESTRICTED`, `CLAUDE_MAX_TURNS`, `CLAUDE_TIMEOUT_MS`, `CLAUDE_EXTRA_ARGS` | `true`, `40`, 15 min, — | |
| Worker | `JOB_DIR` | `~/.cache/kinopio-worker` | Wiped on start |
| Worker | `WORKER_GPU_NAME` | `unknown GPU` | Shown in the worker's `hello` |

`worker/env.example` has all of them. The worker runs as a systemd user service (`worker/kinopio-worker.service`), so it starts with the PC and restarts if it crashes.

## 15. Done when

- Drop a 10-minute video and trim it to 3 minutes: the card shows each stage live on two devices, then becomes the summary card, and the transcript space opens from its link.
- With the worker stopped, the dialog says it's offline and nothing is uploaded.
- Deleting the placeholder mid-job cancels it.
- After every job, `MEDIA_TMP_DIR` and the worker's `JOB_DIR` are empty.
- Integration tests cover the endpoints, the result-contract validation, the sweep and cancel, using a fake worker (`test/media.spec.ts`), and the worker pipeline against stand-in `ffmpeg`, `whisper-cli` and `claude` scripts (`test/worker.spec.ts`).

All of these were checked with the real patched client in two browsers, the real worker and real ffmpeg (whisper and Claude stood in by the test scripts): the dialog, the live stages on both devices, the summary card with its transcript link, the transcript space, empty temp folders afterwards, and the offline dialog with **Upload as file**.

## 16. Open questions

1. **Queue while the PC is off?** Not planned, since the file would wait on the server. Revisit if blocking gets annoying.
2. ~~Section layout~~: the server computes a column layout (§8).
3. ~~Server-originated relay messages~~: confirmed; the card grows to fit after the update (§9).
4. ~~Claude Code flags~~: set (§7.3). The model is the CLI's default unless `CLAUDE_MODEL` is set.
5. **Subscription limits:** the summary session and Taskflow share the same Claude subscription. A long lecture is one large session, so watch for contention.
