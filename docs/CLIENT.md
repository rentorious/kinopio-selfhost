# The client: pin, patch, build, serve

We don't vendor the Kinopio client. The build clones it at a pinned commit, applies our small patch set, and builds static files.

- Upstream: https://github.com/kinopio-club/kinopio-client
- Pinned commit: `0394e07b343d076347aaa214edb584e0856c4347` (2026-10-09). Every finding in these docs was checked against it.
- License: **PolyForm Noncommercial 1.0.0**. Our patches are changes to that code, so they inherit it. Personal, noncommercial use only, and anyone who receives the patched client must also get the license terms and this notice:

  > Required Notice: Copyright Pirijan Ketheswaran (http://kinopio.club)

## Patch 1: same-origin hosts (M0, required)

`client/patches/0001-selfhost-same-origin-hosts.patch`. All hosts are hardcoded in `src/consts.js`. When the client is built with `VITE_SELFHOST=true`, the patch derives every host from `window.location.origin` at runtime, so one build works on any domain (the Railway URL, a custom domain, localhost):

| Const | Self-hosted value |
|---|---|
| `cdnHost` | `<origin>/files` |
| `kinopioDomain()` | `<origin>` |
| `apiHost(shouldUseProduction)` | `<origin>/api`, even when `shouldUseProduction` is true (the Templates dialog passes it) |
| `websocketHost()` | `ws(s)://<host>/api/ws` |
| `helperServerHost()` | `<origin>/api` (its one endpoint is SKIP) |

During pre-rendering (vite-ssg runs in Node, no `window`) the original Kinopio hosts are kept; they only end up in static marketing pages.

The patch also adds `/files` to the service worker's `navigateFallbackDenylist`, so opening an uploaded file in a new tab isn't answered with the app shell.

Leave `imgproxyHost` alone. The client only routes `*.kinopio.club` URLs through it, so our own file URLs load directly.

## Patch 2: installable PWA (done)

`client/patches/0002-selfhost-installable-pwa.patch`. The client already registers a Workbox service worker (offline app shell, auto-update on deploy), but its manifest only sets `start_url`, so browsers never offer to install it: installability needs a name and 192 px / 512 px icons. The patch fills in the manifest in `vite.config.js`: name "Kinopio (self-hosted)", short name "Kinopio", standalone display, the icons already in `public/`, and an "Add to Inbox" shortcut that opens `/add` (long-press or right-click the app icon).

Server side, `src/common/client-static.ts` sends `Cache-Control: no-cache` for `sw.js`, `registerSW.js`, the manifest and every HTML page, and `immutable` for the hashed bundles in `/assets`, so a new deploy reaches installed apps on their next launch.

Verified in Chromium: no installability errors, service worker active, and the app shell loads with the network off.

## Patch 3: recognise our own space links (done, M2b)

`client/patches/0003-selfhost-own-space-links.patch`. Moved up from M3: the media summary card links to its transcript space (MEDIA-SUMMARIES.md §8), and without this patch that link shows as a URL preview.

Two places hardcode `https://kinopio.club/`, so links to spaces on our domain got URL-previewed instead of rendered as space links:

- `src/utils.js` `urlIsSpace`: when the client isn't on kinopio.club, it also matches `<our origin>/<slug-id>`, skipping `/invite?`, `/api/` and `/files/`.
- `src/components/Card.vue` `isNotKinopioUrl`: also treats `consts.kinopioDomain()` as Kinopio.

`src/components/dialogs/CardDetails.vue` decides "is this an upload?" by checking for `cdn.kinopio.club` or `linodeobjects.com` in the URL; the patch adds `consts.cdnHost`, so non-image uploads (PDFs etc.) aren't sent for link previews.

The link chip's name comes from `POST /api/item/multiple`, implemented in M2b for the same reason.

## Patch 4: media summary dialog (done, M2b; audio prep M2c)

`client/patches/0004-selfhost-media-summary-dialog.patch`. Dropping or pasting a single audio or video file opens our own dialog (preview, trim, language, topic hint) instead of uploading it. Two small hooks, in `uploadStore.addCardsAndUploadFiles` (an `asFile` flag for **Upload as file**) and `Space.vue` (mounts the dialog), plus two new files: `stores/useMediaSummaryStore.js` and `components/dialogs/MediaSummary.vue`. Since M2c a third, `media/prepareAudio.worker.js`, cuts the selection and keeps only its audio before upload (AUDIO-PREP.md). Details in MEDIA-SUMMARIES.md §11.

Verified in Chromium against the real worker: the dialog, trimming, the upload progress bar, live stage text on two devices, the summary card and its transcript space link, and the offline state.

## Build

```bash
npm run client:build        # = bash client/build.sh → ./client-dist
```

`client/build.sh` fetches the pinned commit, applies every patch in `client/patches/`, runs `npm ci`, installs `mediabunny` (pinned in `MEDIABUNNY`, `--no-save` so the client's lockfile stays untouched), runs `VITE_SELFHOST=true npm run build`, and copies the result plus the license and notice into `client-dist/`. The Dockerfile runs the same script in its first stage. Verified: about 40 s with a warm npm cache, 17 MB of static output.

## Serve

The NestJS app serves `client-dist/` itself (`src/common/client-static.ts`), mirroring the Netlify rules in the client's `_redirects`: real files first, then pre-rendered `<path>.html`, then the SPA shell `app.html`. `/api/*` and `/files/*` are never handled by the static layer.

Railway terminates HTTPS, which the service worker, clipboard and some upload paths need.

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
