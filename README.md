# kinopio-selfhost

A self-hosted backend for the [Kinopio](https://kinopio.club) web client, so the spatial canvas runs on your own Railway service with your data in your own Postgres and bucket.

Kinopio's client is public; its server isn't. This repo is a from-scratch server that speaks the API the client expects, plus a small patch that points the client at it.

**Status:** M1 (single-user core) done: sign-up/sign-in, spaces, and every save operation, tested with 131 integration tests plus a headless run of the real client on two devices. Next: M2 (uploads, link previews, live sync), then M2b (media summaries: drop audio or video, get a summary card and a transcript, processed on your own PC). Deploy steps: [docs/DEPLOY.md](docs/DEPLOY.md). Spec: [docs/SPEC.md](docs/SPEC.md).

## Development

```bash
docker compose up -d          # Postgres on :5432
npm install
npm run client:build          # patched Kinopio client into ./client-dist
npm run dev                   # http://localhost:3000
npm test                      # needs a kinopio_test database (TEST_DATABASE_URL) and a kinopio-client checkout (KINOPIO_CLIENT_DIR) for fixtures
```

## Docs

| File | What's in it |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Scope, decisions, data model, core endpoint shapes, milestones, open questions |
| [docs/ENDPOINTS.md](docs/ENDPOINTS.md) | Every endpoint the client calls, each assigned a milestone, stub or skip (generated) |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | The `POST /operations` write path and all 50 operation types |
| [docs/WEBSOCKET.md](docs/WEBSOCKET.md) | Realtime relay protocol and the action allowlist |
| [docs/CLIENT.md](docs/CLIENT.md) | Pinned client commit, the host patch, build and serving |
| [docs/MEDIA-SUMMARIES.md](docs/MEDIA-SUMMARIES.md) | M2b: audio/video to summary card plus transcript space, the home-PC worker, and the no-storage rules |

## Keeping up with the client

The docs are pinned to kinopio-client `0394e07`. When bumping it, run the checkers in `tools/`; they fail if the client added or removed endpoints or operation types:

```bash
python3 tools/endpoint_inventory.py ../kinopio-client > docs/ENDPOINTS.md
python3 tools/operation_inventory.py ../kinopio-client
```

## License note

- The server code in this repo is original work.
- The Kinopio client is licensed under [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). Any patches to it in this repo (under `client/`) are changes to that software and carry the same license and its required notice: *Copyright Pirijan Ketheswaran (http://kinopio.club)*.
- Because the server only exists to run that client, treat the whole setup as **personal and noncommercial**: no hosting it for others and no using it for paid work.
- Kinopio is a small, community-funded project. If you end up relying on it, consider supporting it at kinopio.club.
