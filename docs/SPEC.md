# kinopio-selfhost: build spec

A self-hosted backend for the open-source Kinopio web client, for personal, noncommercial use, deployed on Railway. Single user first; sharing is an optional last milestone.

Companion docs:

- [ENDPOINTS.md](ENDPOINTS.md): all 104 REST endpoints the client calls, each assigned a milestone, stub or skip (generated)
- [OPERATIONS.md](OPERATIONS.md): the `POST /operations` write path and all 50 operation names
- [WEBSOCKET.md](WEBSOCKET.md): realtime relay protocol and the action allowlist
- [CLIENT.md](CLIENT.md): pinned client commit, the patch, build and serving

Everything here was read out of kinopio-client `0394e07` (2026-10-09). The real kinopio-server isn't public, so "the server must…" below means "the client breaks or misbehaves otherwise", not "this is how Kinopio does it".

## 1. Scope

**In:** spaces, cards, connections, boxes, lists, lines, drawings, tags, uploads, link previews, live sync between your own devices, inbox, search, backups.

**Out:** billing, Explore/public discovery, groups, notifications, favorites, email (password reset, invites), are.na import, PDF export, image/GIF search, moderation, third-party app API keys.

**Licensing constraint:** the client is PolyForm Noncommercial. This server is our own code, but it only exists to run that client, so the whole thing stays personal and noncommercial. No hosting it for others, no using it as a work tool for paid projects.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Database | **Postgres**, one row per item with a JSONB `data` column | The client writes small per-item patches. A row per item makes each patch one `UPDATE … SET data = data \|\| $1`. Ownership and permission checks are relational. JSONB means no migrations for the ~50 card fields. See §5. |
| Hosting | **Railway**: one service built from this repo's Dockerfile, plus a Railway Postgres and a Railway Storage Bucket | Managed TLS, websockets, backups; no home-server networking. |
| Topology | **Single origin**: the NestJS service serves the client at `/`, the API at `/api`, the websocket at `/api/ws`, files at `/files` | No CORS, and the client is patched to derive its hosts from `window.location`, so one build works on any domain (CLIENT.md). |
| Server stack | **NestJS** (Express adapter) on Node 22, **Kysely** + `pg` for queries, plain SQL migrations run on boot | Kysely keeps the JSONB merges and upserts as readable SQL, which an ORM would fight. |
| Auth | Random 32-byte `apiKey` per user, passwords hashed with argon2id | The client sends the raw key in `Authorization` and treats "has apiKey" as signed in. |
| Upgrade status | Return `stripePlanIsPurchased: true` on every user | The client derives `isUpgraded` from four billing fields and ignores any `isUpgraded` we send. This lifts the 100-card limit and the 5 MB upload limit. |
| File storage | Railway Bucket (private, S3 API). Uploads go through **our own** signed form endpoint; files are streamed back through `/files/*` | Railway buckets have no public URLs and no documented POST-policy support, so the browser can't talk to the bucket directly. See §7. |

## 3. Architecture

```
 browser ── https://<app>.up.railway.app ──► NestJS service ─┬─ /            patched client (static, falls back to app.html)
                                                             ├─ /api/*       REST + POST /operations
                                                             ├─ /api/ws      websocket relay
                                                             └─ /files/*     streams objects from the bucket
 NestJS ──► Railway Postgres   (DATABASE_URL, private network)
 NestJS ──► Railway Bucket     (BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION, ENDPOINT)
```

Railway setup is in `docs/DEPLOY.md`. For local development, `docker-compose.yml` runs Postgres, and `FILES_DRIVER=local` stores uploads on disk instead of a bucket.

**This is now on the public internet**, not a LAN, so: sign-up is closed once a user exists, sign-in is rate limited, the link-preview fetcher blocks private and Railway-internal addresses (including IPv6 `fd00::/8`, which Railway's private network uses), and the websocket relay enforces its allowlist.

## 4. Rules for every endpoint

These come from how `useApiStore.js` handles responses. Breaking them causes silent failures or unhandled rejections.

1. **Always respond with a JSON body, and never 204.** The client calls `response.json()` on every 2xx, including 204. Stubs return `200 {}` or `200 []`.
2. **Errors are JSON too**, shaped `{"status": <code>, "message": "…"}` with the same HTTP status. The sign-in, sign-up, password and email flows read `status` (401, 429) and `type: "unique violation"` from the **body**, not the HTTP status.
3. **Request headers** (CORS must allow all of them if you ever split origins):
   - `Authorization: <apiKey>`: raw key, no `Bearer` prefix
   - `Space-Authorization: <collaboratorKey>`: sent on almost every request, because locally created spaces always have a key; ignore it unless the endpoint is about that space
   - `Read-Only-Authorization: <readOnlyKey>`: only on `GET /space/:id`
   - `Request-Id`, `User-Id` (the client's user id, a nanoid even when signed out), `Content-Type`, `Cache-Control`
4. **Resolving the user:** look up `Authorization` in `users.api_key`. Missing or unknown key means anonymous. Never trust `User-Id` or any `userId` in a body for identity.
5. **Unsupported endpoints** (SKIP in ENDPOINTS.md) return `404 {"status":404,"message":"not supported"}`. Unknown paths the same.
6. **Prefer an empty success over an error for anything the client calls routinely.** Most `useApiStore` wrappers `return normalizeResponse(response)` without `await`, so an HTTP error skips their `catch` and rejects into the caller, and many callers have no `try`. A 404 on a page-load endpoint becomes an unhandled rejection. Reserve non-2xx for genuine failures and for the cases ENDPOINTS.md calls out.
7. **Keep `GET /` and `GET /space/:id` fast.** Calls made through `fetchWithTimeout` give up after 40 s and flip the client into "offline / server unresponsive". Link previews and `download-all` use a plain `fetch` with no timeout.

## 5. Data model

```sql
create extension if not exists pg_trgm;   -- M3 search

create table users (
  id               text primary key,          -- keep the client's nanoid on sign-up
  email            text unique,
  password_hash    text,
  api_key          text unique not null,
  prefs            jsonb not null default '{}',  -- everything the client stores on the user
  cards_created_count     int not null default 0,
  cards_created_count_raw int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table spaces (
  id                 text primary key,
  owner_id           text not null references users(id) on delete cascade,
  name               text not null default '',
  privacy            text not null default 'private' check (privacy in ('private','closed','open')),
  collaborator_key   text not null,
  read_only_key      text not null,
  is_removed         boolean not null default false,
  removed_by_user_id text,
  edited_at          timestamptz,
  edited_by_user_id  text,
  meta               jsonb not null default '{}',  -- background*, isTemplate, showInExplore, note, previewImage*, …
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on spaces (owner_id, is_removed, updated_at desc);

create table items (
  space_id   text not null references spaces(id) on delete cascade,
  type       text not null check (type in ('card','connection','box','list','line','tag','drawingStroke')),
  id         text not null,
  user_id    text,
  data       jsonb not null,                  -- the item as the client sends it, minus envelope fields
  seq        bigserial,                       -- insertion order (drawing strokes are ordered)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (space_id, type, id)
);
create index on items (space_id, type, seq);
-- M3: create index items_card_name_trgm on items using gin ((data->>'name') gin_trgm_ops) where type = 'card';

create table applied_operations (           -- dedupe for POST /operations; prune after 7 days
  operation_id text primary key,
  applied_at   timestamptz not null default now()
);

-- M3: create table hidden_spaces (user_id text, space_id text, primary key (user_id, space_id));
-- M4: create table space_collaborators (space_id text, user_id text, primary key (space_id, user_id));
```

Notes:

- **Why `(space_id, type, id)` as the key:** ids are client nanoids. Scoping by space means a buggy or replayed op can't overwrite an item in someone else's space, and every op already carries `spaceId`.
- **Drawing strokes** are rows with `type = 'drawingStroke'`, `id = stroke[0].id`, and `data` = the array of points. Return `drawingStrokes` as an array of those **raw point arrays**, with no envelope, ordered **newest first** (`seq DESC`): the client reverses the array on load and then appends new strokes on top.
- **Removed cards** stay as card rows with `data.isRemoved = true`.
- **Reading an item** (every type except strokes): `{ ...data, id, spaceId: space_id, userId: user_id, createdAt, updatedAt }`, with columns winning over `data`.
- **Storing an item:** strip the envelope (`operationId`, `clientCreatedAt`), the client-only fields (`position`, `isParentCard`, `user`, `isFromBroadcast`), and `spaceId`/`userId` (those live in columns).

## 6. Core endpoints (M1)

ENDPOINTS.md lists all of them. These are the ones with real shape requirements.

### 6.1 The user object

Returned by `POST /user/sign-in`, `POST /user/sign-up` and `GET /user`. Build it as `{ ...prefs, <columns> }`, with columns winning:

```json
{
  "id": "…", "apiKey": "…", "email": "me@example.com",
  "name": "…", "color": "#…", "description": "", "website": "",
  "cardsCreatedCount": 0, "cardsCreatedCountRaw": 0,
  "stripePlanIsPurchased": true,
  "isModerator": false, "isDonor": false,
  "createdAt": "…", "updatedAt": "…"
}
```

- **Return every stored pref.** The client caches the raw response object and replays it over fresh defaults on reload, so a key we omit (theme, filters, `lastSpaceId`, …) is lost after a reload. That includes `apiKey`: omit it and the user is signed out on the next reload.
- **Sign-up body** is the client's entire local user state plus `email`, `password` and `sessionToken`. Store the preference keys in `prefs` and keep the client's `id` (its local spaces already reference it). Gate it behind `ALLOW_SIGNUP` (default: allowed only while the `users` table is empty). Duplicate email → `409 {"status":409,"type":"unique violation"}`.
- **Sign-in** body `{email, password}`. Wrong credentials → `401 {"status":401}`. Sign-in triggers `POST /space/multiple` with the local spaces, then `GET /user/spaces`, which must return an array or sign-in aborts.
- **Protected keys** that `updateUser` and sign-up must never write into `prefs`: `id`, `apiKey`, `email`, `password`, `passwordHash`, `stripe*`, `appleSubscriptionIsActive`, `downgradeAt`, `isModerator`, `isDonor`, `isUpgraded`.
- Also provide a CLI to create a user and print its apiKey (`server create-user --email …`), so the first account doesn't depend on the sign-up UI.
- **Every user always has an Inbox space.** Create one (name `Inbox`, private, empty) when a user is created by the CLI or sign-up, and set `prefs.lastSpaceId` to it if the user has no `lastSpaceId`. Why: on sign-in the client deletes its unedited local Inbox and Hello spaces, never pushes a replacement Inbox while signed in, and keeps the deleted Hello space's id as `lastSpaceId` (the user object is merged into local state, not replaced). Without a server Inbox and a valid `lastSpaceId`, the first sign-in lands on "space not found", and inbox cards are silently lost.

### 6.2 `GET /space/:id`

Who can read: the owner; anyone if `privacy` is `open` or `closed`; anyone with a matching `Space-Authorization` (collaborator key) or `Read-Only-Authorization`. Otherwise `401`. Unknown id `404`. Removed spaces are still returned, with `isRemoved: true`, so the client can show its restore banner.

```jsonc
{
  "id": "…",                       // must equal the requested id or the client ignores the response
  "name": "…", "url": "<slug>-<id>", "privacy": "private",
  "userId": "<owner id>", "isRemoved": false, "removedByUserId": null,
  "createdAt": "…", "updatedAt": "…", "editedAt": "…", "editedByUserId": "…",
  "collaboratorKey": "…", "readOnlyKey": "…",   // owner/members only
  "...": "every key in spaces.meta",
  "cards": [], "connections": [], "boxes": [], "lists": [], "lines": [], "tags": [], "drawingStrokes": [],
  "users": [ { "id": "…", "name": "…", "color": "…", "description": "", "website": "", "isUpgraded": true, "isModerator": false, "isDonor": false } ],
  "collaborators": [], "groups": [], "clients": [], "spectators": []
}
```

`cards`, `connections`, `boxes` and `lines` must be arrays or the client throws. Return every other key too: the client merges the response over its previous local state (`$state =` is an `Object.assign`), so an omitted key keeps a stale value. Send `null` to clear a field; don't omit it. `url` follows the client's `utils.url()`: the normalized name, a dash, then the id.

### 6.3 Spaces list and lifecycle

| Endpoint | Behaviour |
|---|---|
| `GET /user/spaces` | Non-removed spaces the user owns (plus collaborates on, M4). Summary fields only: `id, name, url, privacy, showInExplore, isTemplate, previewImage, previewThumbnailImage, createdAt, updatedAt, editedAt, editedByUserId, userId, users:[ownerMeta], collaborators:[], groups:[]`. **Any space the client has cached but that is missing here gets moved to its "removed" list**, so don't leave spaces out. |
| `POST /space`, `POST /space/multiple` | Upsert one / an array of **full** spaces including nested items (same rules as the `createSpace` operation in OPERATIONS.md: ignore `users`, generate missing keys, owner = caller, **refuse to touch a space someone else owns**). `/space/multiple` also carries the client's locally removed spaces with `isRemoved: true` and `removedByUserId`: store those as removed, or deleted spaces come back on every sign-in. Return `200` with the space / `{}`. |
| `PATCH /space` | Partial update `{id, ...}` of a space other than the current one. |
| `GET /space/updated-at/:id` | `{id, editedAt, updatedAt}`. The client refetches the whole space if our `editedAt` is ≥15 minutes newer than its own (it resets its own to "now" on load). For an unknown id return `200 {id, editedAt: null, updatedAt: null}`: any non-2xx shows a sticky "Refreshing data…" banner and stops further checks. |
| `GET /user/removed-spaces` | Removed spaces owned by the user (summary fields). |
| `PATCH /space/restore/:id` | Set `is_removed = false`; return the **full space including `cards`**. The client calls `space.cards.filter` on the response. |
| `GET /space/:id/removed-cards` | Full card objects with `isRemoved: true`. |
| `GET /user/inbox-space` | The user's most recently updated non-removed space named exactly `Inbox`, in full. If there is none, create it first (§6.1). Don't 404: the client calls this 15 s after every page load and hourly, with no error handling. |
| `GET /space/inbox` | Same lookup (creating if needed), returning just `{id}`. Don't return `null`: the client would build a local-only Inbox that it never saves to the server. |

Keys: the client usually generates `collaboratorKey` and `readOnlyKey`, but some paths send none or `""`. Generate a nanoid for any missing key on create.

### 6.4 `POST /operations`

Specified in full in OPERATIONS.md. Short version: apply in order, one by one, dedupe on `operationId`, partial merges where `null` clears, creates are upserts, unknown ops succeed as no-ops, and on any failure return non-2xx with `{"operations":[…],"errors":[{"status":…}]}`.

Also bump `spaces.updated_at` for every space an op touched.

## 7. Uploads (M2)

The client asks for a "presigned post" and then POSTs a multipart form (`fields` + `file`) to the returned `url`, with no auth headers, tracking progress via XHR. We control both halves, so the "presign" is our own signed token and the form goes to our own endpoint, which streams the file into the bucket. Same origin, no bucket CORS, and it works the same with the local-disk driver.

`POST /upload/presigned-post`, body `{key, type, requestSpaceId}`:

1. Require a signed-in user who can edit `requestSpaceId`.
2. Validate `key` is `<id>/<filename>`: the id is a nanoid (`[A-Za-z0-9_-]`) and the filename only has `[A-Za-z0-9.-]`. The client keeps case (`Screenshot-2026.PNG`).
3. Return `{ "url": "<origin>/api/upload/direct", "fields": { "key": "<key>", "token": "<signed token>" } }`. The token is an HMAC (key `UPLOAD_SIGNING_SECRET`) over `{key, type, userId, maxBytes, exp}`, expiring after 1 hour.

`POST /api/upload/direct` (ours, not in the client's API list): multipart form with `key`, `token`, then `file`. Verify the token and that `key` matches, stream the file to storage with `Content-Type: type`, abort past `UPLOAD_MAX_BYTES` (default 256 MB), return `200 {}`. The client marks an upload done at 100% progress without checking the status, so reject early (bad token → close before reading the body).

`POST /upload/presigned-post/multiple`, body `{files:[{key, type, size}], requestSpaceId}` → array of `{url, fields}` in the same order.

`GET /files/<key>`: stream the object from storage with its content type and `Cache-Control: public, max-age=31536000, immutable` (keys are never reused for different content). Support `Range` requests so videos can seek. The client builds file URLs itself as `${cdnHost}/${key}`, and our patched `cdnHost` is `<origin>/files`.

Anyone who knows a file URL can read it, which is the same model as Kinopio's own CDN. Keys include the card or space id, so they aren't guessable.

Bandwidth note: streaming through the service counts as Railway service egress (bucket-to-service traffic is free). For personal use that's negligible; if it ever matters, `/files/*` can 302 to a short-lived presigned GET instead.

## 8. Link previews (M2)

`POST /services/url-preview`, body `{url, card}`:

- Fetch `url` server-side with a 5 s timeout and a 2 MB cap. **Refuse private and loopback addresses** (SSRF guard), except on an explicit allowlist.
- Parse `og:title` / `<title>`, `og:description`, `og:image`, and the favicon. For YouTube/Vimeo, set an embed URL in `urlPreviewIframeUrl`.
- Respond with **exactly 200** and a card patch: `{ id: card.id, urlPreviewUrl: <the requested url, unchanged>, urlPreviewTitle, urlPreviewDescription, urlPreviewImage, urlPreviewFavicon, urlPreviewIframeUrl?, urlPreviewIsVisible: true }`. If `urlPreviewUrl` differs from the request, the client keeps re-requesting.
- On failure return `404` JSON. The client marks the URL as errored and won't retry.

The client merges our response straight into the card and queues an `updateCard`, so only return those fields.

## 9. Realtime (M2)

See WEBSOCKET.md. It's a room-based relay with auth at join time and a strict allowlist of store actions.

## 10. Milestones

Each milestone ends with a manual run of the patched client against the server.

**M0: skeleton**
- NestJS app, config via env, SQL migrations run on boot, `docker-compose.yml` with Postgres for local dev.
- Dockerfile: build the patched client (CLIENT.md), build the server, serve both from one image. `railway.json` with a health check.
- `GET /api/` returns `{"status":"ok"}`; every other `/api` path returns the JSON 404; everything else serves the client.
- *Done when:* the client loads at the Railway URL and works offline-style (local only).

**M1: single-user core**
- `create-user` CLI (creates the user's Inbox), sign-in, gated sign-up, `GET /user`.
- Spaces: §6.2–6.3.
- `POST /operations` with every M1 op, plus the dedupe table.
- All STUB rows answer with their fixed body; all SKIP rows return the JSON 404.
- *Done when:* sign in → create spaces → add cards, boxes, connections, lists, lines, drawings and tags → reload, and everything is there; a second browser signs in and sees the same spaces; remove/restore works for cards and spaces; more than 100 cards work; the console shows no errors from unanswered endpoints.

**M2: media and multi-device**
- Uploads (§7), link previews (§8), websocket relay (WEBSOCKET.md), `POST /card/to-inbox` + `createCardInInbox`.
- *Done when:* dragging an image onto the canvas persists across reloads; pasting a link shows a preview; two browsers show each other's cursors and edits live.

**M3: quality of life**
- `POST /card/search` (trigram index), `GET /user/tags`, `GET /card/by-tag-name/:name`, todos, date mentions, hidden spaces.
- `GET /space/download-all` (zip of one JSON per space). Railway Postgres backups cover the database; add a periodic copy of the bucket somewhere outside Railway.
- Other-space checkbox toggles (`PATCH /card/multiple`, `PATCH /box`), `PATCH /card/update-counter`, `POST /item/multiple`, public user endpoints, password and email change.
- Client Patch 2 (own-domain space links).

**M4: sharing (optional)**
- Collaborators via invite keys (`PATCH`/`DELETE /space/collaborator`, `addCollaboratorToSpaces`), read-only links, membership in `/user/spaces`, permission checks in the relay, `userLeftSpace`.

## 11. Testing

- **Unit:** merge semantics (null clears, `nameUpdatedAt` last-writer-wins, upserts, numeric-keyed array bodies), permission checks, user object assembly (protected keys never written).
- **Contract fixtures:** `src/data/hello.json` and `src/data/inbox.json` in the client are real space payloads; use them as `POST /space` bodies and check `GET /space/:id` round-trips every field.
- **Recorded batches:** in dev, log each `/operations` request body to a file while clicking through the client. Turn interesting ones into regression fixtures.
- **Smoke:** a script that signs in, creates a space, sends a batch covering every M1 op, and checks the result.

## 12. Open questions

1. **Sharing:** is M4 ever wanted? If not, permission checks can stay "owner only" and the relay only needs to handle your own devices.
2. **Custom domain** on Railway, or the default `*.up.railway.app`? Nothing in the build depends on it.

Settled: NestJS, Railway, Postgres.
