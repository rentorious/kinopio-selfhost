# Deploying on Railway

One Railway project with three pieces: this repo as a service (built from the `Dockerfile`), a Postgres database, and (from M2) a Storage Bucket.

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

## 4. Your account

Two options:

- **In the app:** open your Railway URL, use Kinopio a little if you like, then **Sign Up**. Your local spaces are uploaded to the server. With `ALLOW_SIGNUP=first-user`, sign-up closes once your account exists.
- **From the CLI** (creates the account and its Inbox without the UI): in the Railway dashboard open the app service's shell, or use `railway ssh`, then run
  `node dist/cli/create-user.js --email you@example.com --password '…' --name You`

## 5. Bucket (M2)

Not needed yet. When uploads land: **+ New → Bucket**, then reference its `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION` and `ENDPOINT` variables in the app service.

## Backups

Railway Postgres has its own backups (check your plan). `GET /api/space/download-all` (M3) will give a zip of every space as JSON.
