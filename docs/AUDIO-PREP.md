# Audio prep in the browser

Milestone **M2c**, on top of M2b (MEDIA-SUMMARIES.md). **Built** (PRs #5 and #6). The open question in §4 is answered: Mediabunny's trimmed output starts at timestamp 0, so `fileOffsetMs` is the selected start.

Before uploading, the browser cuts the selected range out of the dropped file and keeps only the audio, re-encoded as mono Opus. A one-hour lecture video goes from ~300 MB to ~20 MB, so the upload takes seconds instead of many minutes. Transcription and the summary stay on the PC worker.

## 1. Decisions

| Decision | Choice | Why |
|---|---|---|
| What runs in the browser | **Trim + drop video + re-encode audio.** Not transcription. | The upload is the slow part. Whisper large-v3 on the PC's GPU is faster and more accurate than anything in a browser, and the Claude summary has to run on the PC anyway. |
| Library | **Mediabunny** `1.61.3` (MPL-2.0), on top of **WebCodecs** | Reads mp4/mov/webm/mkv/ogg/mp3/wav/flac, has a `Conversion` API with `trim`, `video: { discard: true }`, `audio: { codec, numberOfChannels, sampleRate, bitrate }`, `onProgress`, `cancel()`, and `getEncodableAudioCodecs()`. Uses the browser's own encoders, so it's fast and adds no big download. Replaces the "no ffmpeg.wasm in the client" decision in MEDIA-SUMMARIES.md §1: ffmpeg.wasm is a ~30 MB download, much slower, and hits wasm memory limits on large files. |
| Where it runs | A **dedicated Web Worker**, loaded only when Summarize is clicked | Keeps the canvas responsive during a multi-minute decode/encode. WebCodecs is available in workers. Lazy loading keeps it out of the app's startup bundle. |
| Output | **Ogg Opus, mono, 48 kHz, 48 kbit/s** (`audio/ogg`). If Opus can't be encoded, **AAC in MP4** (`audio/mp4`) | ~21.6 MB per hour. Plenty for speech: whisper resamples to 16 kHz mono anyway. Opus encoding is in Chrome and Firefox; AAC covers browsers that only have that. |
| When to skip prep | The file is already audio, ≤ 25 MB, and the whole file is selected | Nothing to gain. |
| Fallback | **Upload the original file**, exactly as today | Prep is an optimization, never a requirement. Any of these fall back: no WebCodecs, no encodable codec, `conversion.isValid === false`, or any error during the conversion. |
| Timestamps | The uploaded file starts at the **selected start**. A new job field `fileOffsetMs` says where the uploaded file's 0 sits in the original | Transcript times must still say 20:00, not 0:00, for a selection starting at 20:00. |
| Rollout safety | The worker announces `features: ['fileOffset']` in `hello`. The status endpoint reports `prepared: true` only when the connected worker has it. The client preps only then | An old worker would ignore `fileOffsetMs` and cut the wrong part. |

## 2. User flow (changes only)

1. Drop and the dialog are unchanged.
2. **Summarize:** the placeholder card appears as now. While prep runs, its text is `⏳ <name> · preparing audio 40%` (set locally with `cardStore.updateCard`; the server doesn't know the job yet).
3. When prep finishes, the normal direct upload starts (`POST /api/media-summaries/direct`) with the **prepared** file: its own `mimeType` and `size`, plus `fileOffsetMs`. The card shows the usual progress bar.
4. If prep fails, the card shows the progress bar for the original file and nothing else changes. Log the reason with `console.warn('🚑 audio prep', …)`.
5. Deleting the placeholder card during prep cancels the conversion (`conversion.cancel()`) and nothing is uploaded.

## 3. Contract changes

### Server

- **Migration `003_media_file_offset.sql`:** `alter table media_jobs add column file_offset_ms bigint not null default 0`.
- **`parseJobFields`** (media.controller.ts) accepts an optional `fileOffsetMs`: a whole number, `0 ≤ fileOffsetMs ≤ startMs`, default `0`. Both upload paths (direct and multipart) go through it.
- **`Job` / `NewJob` / `createJob` / `job()`** carry `fileOffsetMs`.
- **`JobOffer`** (contract.ts) gets `fileOffsetMs: number`. `dispatch()` fills it in.
- **`WorkerMessage` hello** gets `features?: string[]`. `WorkerHub` keeps it in `workerInfo`.
- **`GET /api/media-summaries/status`** adds `prepared: boolean`: online and `workerInfo.features` includes `'fileOffset'`.
- `startMs` / `endMs` keep meaning **positions in the original file**. Result validation (`validateResult` range) is unchanged.

### Worker

- **`job.ts`:** cut at `offer.startMs - offer.fileOffsetMs` to `endMs - offer.fileOffsetMs` within the downloaded file. Clamp against the file's duration **plus** the offset: `endMs = min(offer.endMs, fileOffsetMs + info.durationMs)`. Segment times keep adding `offer.startMs`, as now, so they come out in original-file time. A missing `fileOffsetMs` means `0`.
- **`connection.ts`:** send `features: ['fileOffset']` in `hello`.
- Bump `worker/package.json` to `0.2.0`.

## 4. Client (Patch 0004)

- **Dependency:** `client/build.sh` runs `npm install --no-save --no-audit --no-fund mediabunny@1.61.3` right after `npm ci`, so the client's `package.json` and lockfile stay untouched and the patch doesn't conflict with client bumps. Keep the version in a variable next to `COMMIT`.
- **New file `src/media/prepareAudio.worker.js`.** Message in: `{ file, startMs, endMs }`. Messages out: `{ progress }` (0–1), then `{ done: true, blob, mimeType, fileOffsetMs }` or `{ error }`. Handles a `{ cancel: true }` message by calling `conversion.cancel()`.
  - `new Input({ source: new BlobSource(file), formats: ALL_FORMATS })`.
  - Pick the codec: `getEncodableAudioCodecs(['opus', 'aac'], { numberOfChannels: 1, sampleRate: 48000, bitrate: 48000 })`. Opus → `OggOutputFormat`, AAC → `Mp4OutputFormat`. No codec → `{ error: 'no encoder' }`.
  - `Output` with `target: new BufferTarget()` (the result is ~20 MB, fine in memory).
  - `Conversion.init({ input, output, video: { discard: true }, audio: { codec, numberOfChannels: 1, sampleRate: 48000, bitrate: 48000 }, trim: { start: startMs / 1000, end: endMs / 1000 }, showWarnings: false })`. If `!conversion.isValid` → `{ error }` with `discardedTracks` reasons (e.g. no audio track).
  - **Verify while building:** does Mediabunny's trimmed output start at timestamp 0, or keep the original timestamps? The `fileOffsetMs` sent must match what the output actually contains. Check by reading the output back with `Input` + `computeDuration()` and the first packet timestamp, and log both in development.
- **`MediaSummary.vue`, `summarize()`:**
  - Read `state.status.prepared`. If false, or the skip rule applies, upload the original as now.
  - Otherwise start the worker: `new Worker(new URL('../../media/prepareAudio.worker.js', import.meta.url), { type: 'module' })`. Show prep progress on the card. On `done`, upload the prepared blob as a `File` named `<original name without extension>.opus` (or `.m4a`) with `fileOffsetMs`. Keep `fileName` in the job fields as the **original** name, so cards say `urszula.mp4`.
  - On `error`, upload the original.
  - Watch for the placeholder card being removed (check `cardStore.getCard(cardId)` on each progress message). If it's gone, send `{ cancel: true }` and stop.
  - Terminate the worker when done.
- **Size limit:** with prep, an original over `MEDIA_MAX_BYTES` is fine as long as the prepared file is under it. Only the server checks size today, so nothing changes in the dialog.
- **PWA:** the worker chunk lands in `assets/`. Workbox skips precaching files over 2 MiB with a warning, which is acceptable; note the chunk size in the PR.

## 5. Tests

- **Server (`test/media.spec.ts`):**
  - `fileOffsetMs` is validated (negative, above `startMs`, not whole → 400) and reaches the offer; it defaults to 0.
  - `status.prepared` is false for a worker without `features` and true with `['fileOffset']`.
- **Worker (`test/worker.spec.ts`, fixture `test/fixtures/worker-bin/ffmpeg`):** with `startMs: 1_200_000`, `endMs: 1_500_000`, `fileOffsetMs: 1_200_000`, ffmpeg gets `-ss 0.000 … -t 300.000`, and segment times come back offset by 1 200 000. Without `fileOffsetMs`, behavior is unchanged.
- **Client:** there's no client test harness for patches. Build it (`client/build.sh`), then test by hand in Chrome and Firefox:
  - a long mp4 → card shows "preparing audio", then a fast upload, and the transcript's first timestamp matches the selected start;
  - a short mp3 with the whole file selected → no prep;
  - a video with no audio track → prep fails, the original uploads, the worker reports the missing audio as today;
  - deleting the card during prep → no upload, no job.

## 6. Rollout order

1. Server + worker contract, backward compatible (`fileOffsetMs` defaults to 0). Merge → Railway deploys.
2. Update the worker on the PC: `git pull`, `npm install && npm run build` in `worker/`, `systemctl --user restart kinopio-worker`. Check the server log says the worker connected, and that `status` reports `prepared: true`.
3. Client patch. Merge → deploy → reload the tab twice (the PWA cache) → manual tests from §5.
4. Update MEDIA-SUMMARIES.md: §1 decision row, §2 flow, §5 hello fields, §10 status and `fileOffsetMs`, §11 Patch 4. Update README status line and the docs table.
