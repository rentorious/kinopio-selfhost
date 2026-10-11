# Deploying on Railway

One Railway project with three pieces: this repo as a service (built from the `Dockerfile`), a Postgres database, and a Storage Bucket for uploads.

## 1. Service from the repo

1. In Railway: **New Project → Deploy from GitHub repo → `rentorious/kinopio-selfhost`**. Railway finds the `Dockerfile` and builds with it. The first build takes a few minutes because it also builds the Kinopio client.
2. Service **Settings → Networking → Generate Domain** (or add a custom domain).
3. Service **Settings → Deploy → Healthcheck Path**: `/api/`

## 2. Postgres

1. In the project: **+ New → Database → PostgreSQL**.
2. In the app service's **Variables**, add a reference: `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (the private-network URL; no SSL needed).

Migrations run automatically on every boot.

## 3. Variables

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Required. Reference to the Postgres service. |
| `ALLOW_SIGNUP` | `first-user` | `first-user` allows sign-up only while there are no users, so the first account you create in the UI is the only one. `false` closes it entirely; `true` opens it. |
| `PORT` | set by Railway | |
| `JSON_LIMIT` | `50mb` | Sign-in uploads every locally cached space in one request. |
| `SIGN_IN_RATE_MAX` / `SIGN_IN_RATE_WINDOW_MS` | `10` / `900000` | Sign-in and sign-up attempts per IP and per email. |
| `DATABASE_SSL` | `false` | Set `true` only if you point `DATABASE_URL` at Railway's public proxy URL. |
| `UPLOAD_SIGNING_SECRET` | random at boot | Signs upload tokens (SPEC.md §7). Set it to a long random string (`openssl rand -base64 32`); otherwise an upload that starts just before a redeploy fails. |
| `UPLOAD_MAX_BYTES` | `268435456` (256 MB) | Largest single upload. |
| `FILES_DRIVER` | `s3` when `BUCKET` is set, else `local` | `local` keeps files in `FILES_DIR` (default `data/files`), which on Railway is wiped by every deploy. Use the bucket (§5). |
| `BUCKET_FORCE_PATH_STYLE` | `false` | Set `true` if the bucket's Credentials tab says to use path-style URLs (older buckets). |
| `URL_PREVIEW_TIMEOUT_MS` | `5000` | Link preview fetch timeout. |
| `URL_PREVIEW_ALLOW_HOSTS` | — | Comma-separated hosts that link previews may fetch even though they resolve to private addresses. Leave empty. |
| `WORKER_TOKEN` | — | Turns on media summaries (§6). The same value goes in the worker's settings on your PC. |
| `MEDIA_TMP_DIR` | `<os tmpdir>/media-jobs` | Where a dropped media file waits until the worker has downloaded it. The container's disk is right: nothing here should survive a deploy. |
| `MEDIA_MAX_BYTES` | `314572800` (300 MB) | Largest media file for a summary. |
| `MEDIA_MAX_MINUTES` | `180` | Longest selected range. |
| `MEDIA_TMP_MAX_AGE` | `7200000` (2 h) | Media jobs still uploading or waiting after this fail, and their files are deleted. |

## 4. Your account

Two options:

- **In the app:** open your Railway URL, use Kinopio a little if you like, then **Sign Up**. Your local spaces are uploaded to the server. With `ALLOW_SIGNUP=first-user`, sign-up closes once your account exists.
- **From the CLI** (creates the account and its Inbox without the UI): in the Railway dashboard open the app service's shell, or use `railway ssh`, then run
  `node dist/cli/create-user.js --email you@example.com --password '…' --name You`

## 5. Bucket

Uploads (images, PDFs, audio and video dropped on a space) live in a Railway Storage Bucket. Without one they go to the container's disk and disappear on the next deploy.

1. In the project: **+ New → Bucket**.
2. In the app service's **Variables**, add references to the bucket's `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION` and `ENDPOINT` (e.g. `BUCKET` = `${{Bucket.BUCKET}}`, using your bucket service's name). With `BUCKET` set, the server uses the bucket automatically.
3. Check the bucket's **Credentials** tab: if it says to use path-style URLs, also set `BUCKET_FORCE_PATH_STYLE=true`.

The bucket stays private. Files are streamed to the browser through `GET /files/*`, which counts as service egress (bucket egress itself is free). Railway buckets don't support lifecycle rules, which nothing here needs.

## 6. Media summaries

Dropping audio or video on a space can turn it into a summary card plus a transcript space (MEDIA-SUMMARIES.md). The work runs on your own PC, which connects out to this service, so there's nothing to open on your network.

1. Generate a token (`openssl rand -base64 32`) and set it on the app service as `WORKER_TOKEN`.
2. Install the worker on the PC: [worker/README.md](../worker/README.md). It uses the same token and your Railway URL.
3. Let the browser upload media straight to the bucket (Railway's proxy cuts uploads off after 5 minutes). Once per bucket:
   ```bash
   railway run --service <app> -- node tools/bucket-cors.mjs https://<your-app>.up.railway.app
   ```
4. Check: `GET /api/media-summaries/status` (signed in) reports `"online": true`, and the dialog that opens when you drop a clip says **Transcriber online**.

Without `WORKER_TOKEN` the feature is off: the dialog says the transcriber is offline and **Upload as file** works as before. Media files sit in the bucket under `.media/` only until the worker has downloaded them, and never go to the database.

## Backups

Railway Postgres has its own backups (check your plan). `GET /api/space/download-all` (M3) will give a zip of every space as JSON.
