# The client: pin, patch, build, serve

We don't vendor the Kinopio client. The build clones it at a pinned commit, applies our small patch set, and builds static files.

- Upstream: https://github.com/kinopio-club/kinopio-client
- Pinned commit: `0394e07b343d076347aaa214edb584e0856c4347` (2026-10-09). Every finding in these docs was checked against it.
- License: **PolyForm Noncommercial 1.0.0**. Our patches are changes to that code, so they inherit it. Personal, noncommercial use only, and anyone who receives the patched client must also get the license terms and this notice:

  > Required Notice: Copyright Pirijan Ketheswaran (http://kinopio.club)

## Patch 1: hosts from env (M0, required)

All hosts are hardcoded in `src/consts.js`. Make each read a Vite env var and fall back to the original value:

| Line(s) | Const | Env var | Example (single origin) |
|---|---|---|---|
| 44 | `cdnHost` | `VITE_CDN_HOST` | `https://kino.home.arpa/files` |
| 68–74 | `kinopioDomain()` | `VITE_SITE_URL` | `https://kino.home.arpa` |
| 75–81 | `apiHost(shouldUseProduction)` | `VITE_API_HOST` | `https://kino.home.arpa/api` |
| 82–88 | `websocketHost()` | `VITE_WS_HOST` | `wss://kino.home.arpa/api/ws` |
| 89–95 | `helperServerHost()` | `VITE_HELPER_HOST` | same as API (endpoint is SKIP anyway) |

When the env var is set it must win even when `apiHost(true)` is called: the Templates dialog forces the production host that way (`components/dialogs/Templates.vue:26`).

Leave `imgproxyHost` alone. The client only routes `*.kinopio.club` URLs through it, so our own CDN URLs load directly.

## Patch 2: recognise our own space links (M3, nice to have)

Two places hardcode `https://kinopio.club/`, so links to spaces on our domain get URL-previewed instead of rendered as space links:

- `src/utils.js` ~L2517: `spaceUrlPattern` regex
- `src/components/Card.vue` ~L1176: `isNotKinopioUrl`

Build both from `consts.kinopioDomain()`.

Also `src/components/dialogs/CardDetails.vue` ~L1004 decides "is this an upload?" by checking for `cdn.kinopio.club` or `linodeobjects.com` in the URL. Add `consts.cdnHost`, or non-image uploads (PDFs etc.) get sent for link previews.

## Build

```bash
git clone https://github.com/kinopio-club/kinopio-client.git && cd kinopio-client
git checkout 0394e07b343d076347aaa214edb584e0856c4347
git apply ../client/patches/*.patch
npm ci                       # Node 22 (.nvmrc says 22.14.0)
VITE_API_HOST=… VITE_WS_HOST=… VITE_CDN_HOST=… VITE_SITE_URL=… npm run build
```

Verified on the pinned commit: `npm ci && npm run build` succeeds and produces a 17 MB static `dist/` (pre-rendered pages plus a PWA service worker). Build it in a multi-stage Dockerfile and copy `dist/` into the Caddy image.

## Serve

`dist/_redirects` is Netlify's routing; its last rule sends every unknown path to the SPA. The Caddy equivalent:

```
handle {
  root * /srv/kinopio
  try_files {path} {path}.html /app.html
  file_server
}
```

Serve over HTTPS. The service worker, clipboard and some upload paths need a secure context.

## Things that still reach Kinopio's servers

None of these break anything; they just mean the browser still fetches some static assets from Kinopio.

| What | Host | Notes |
|---|---|---|
| Built-in backgrounds (82) and the default new-space background | `bk.kinopio.club` via `img.kinopio.club` | Could mirror into our bucket later and patch `data/backgroundImages.json` |
| Font previews and toolbar tooltip GIFs | `files.kinopio.club` | Preloaded on every space page |
| Date card image | — | Not Kinopio's: with Patch 1 the fallback becomes `${cdnHost}/date/MM-DD-YYYY.jpg` in **our** bucket, which doesn't exist, so the date card on new spaces shows a broken image. `GET /space/date-image` returns a URL to a placeholder image we ship (M1); generating a real per-date image is optional. |
| Images in the "Hello Kinopio" welcome space | `cdn.kinopio.club`, linodeobjects | Only that one space |
| Marketing, help and blog pages | `updates.kinopio.club` | Not used by the app itself |
| are.na import | `api.are.na` | Needs a server-side are.na secret; endpoint is SKIP |

The patched client sends **no** analytics anywhere but our own API (`POST /services/analytics-event`, which we drop). There is no Sentry, Google Analytics or third-party script in the client.

## When bumping the pinned commit

```bash
python3 tools/endpoint_inventory.py ../kinopio-client > docs/ENDPOINTS.md   # fails on new/removed endpoints
python3 tools/operation_inventory.py ../kinopio-client                      # fails on new/removed op names
grep -rn "broadcastStore.update(" ../kinopio-client/src | wc -l             # was 89 call sites; re-check the WEBSOCKET.md allowlist if it changes
```
