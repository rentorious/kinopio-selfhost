#!/usr/bin/env python3
"""Regenerate docs/ENDPOINTS.md from a kinopio-client checkout.

Usage: python3 tools/endpoint_inventory.py /path/to/kinopio-client > docs/ENDPOINTS.md

Parses src/stores/useApiStore.js for every fetch() against the API host,
and fails loudly if the client calls an endpoint this file doesn't classify
(that's the signal the client changed and the spec needs a look).
"""
import re
import subprocess
import sys

TIERS = {
    'M1': 'Milestone 1 — real implementation',
    'M2': 'Milestone 2 — real implementation',
    'M3': 'Milestone 3 — real implementation',
    'M4': 'Milestone 4 (sharing, optional)',
    'STUB': 'Return the fixed body shown; never errors',
    'SKIP': 'Not supported: return 404 with JSON body',
    'DEAD': 'Never called by the client; ignore',
}

# "METHOD /path" -> (tier, response, note)
C = {
    # meta
    'GET /': ('M1', '`{"status":"ok"}`', 'Any truthy JSON = online. A network error or 40 s timeout marks the client offline; an HTTP error stops its status retry loop.'),
    'GET /meta/date': ('M1', '`{"date":"<ISO now>"}`', 'Read without a guard; an error throws.'),
    'GET /meta/changelog': ('STUB', '`[]`', 'Empty = no "updates available" banner.'),
    'GET /meta/emojis': ('STUB', '`{"emojis":[],"version":1}`', 'Empty emoji picker. Could serve a real list later.'),
    'GET /space/date-image': ('STUB', '`{"url":"<site>/static/date-card.png"}`', 'A placeholder we ship. `null` would fall back to `${cdnHost}/date/…`, which is our empty bucket (CLIENT.md).'),
    'POST /kinopio-blog/new-post/subscribe': ('SKIP', '', ''),
    'POST /services/analytics-event': ('STUB', '`{}`', 'Production builds send page views here. Drop them.'),
    'POST /moderator/restart-server': ('SKIP', '', 'Goes to helper host, not the API.'),
    # auth
    'POST /session-token/create': ('M1', '`{}`', 'Fire-and-forget; response never read.'),
    'POST /user/sign-up': ('M1', 'user object', 'Gate behind `ALLOW_SIGNUP` (default: only when no users exist). Body is the whole local user state + email/password/sessionToken.'),
    'POST /user/sign-in': ('M1', 'user object', 'Errors: JSON body `{"status":401}` / `{"status":429}`.'),
    'POST /user/send-reset-password-email': ('SKIP', '', 'No mail server. 404 shows "email not found".'),
    'PATCH /user/update-password': ('M3', '`{}`', 'Body `{password, apiKey}`.'),
    'PATCH /user/reset-password': ('SKIP', '', 'Needs the reset email flow.'),
    'PATCH /user/update-email': ('M3', '`{}`', 'Body `{email}`. Conflict → JSON `{"type":"unique violation"}`.'),
    # user
    'GET /user': ('M1', 'user object', 'Must include `apiKey` and every stored pref, or they reset on reload.'),
    'GET /user/todos': ('M3', '`[{...space, cards:[], boxes:[]}]`', 'Stub `[]` until M3.'),
    'GET /user/at-user-mentions': ('STUB', '`[]`', 'Array grouped by space. Only matters with other users.'),
    'GET /user/at-date-mentions': ('M3', '`[{...space, cards:[]}]`', 'Due dates. Stub `[]` until M3.'),
    'GET /user/favorite-spaces': ('STUB', '`[]`', 'One of six fetched together; any error blocks all six.'),
    'GET /user/favorite-users': ('STUB', '`[]`', ''),
    'GET /user/favorite-colors': ('STUB', '`[]`', 'Array of color strings when implemented.'),
    'GET /user/hidden-spaces': ('M3', '`[{id}]`', 'Stub `[]` until M3.'),
    'GET /user/favorite-users-spaces': ('STUB', '`[]`', ''),
    'GET /user/spaces': ('M1', 'array of space summaries', 'Must be an array. Must include every space the user owns or collaborates on: cached spaces missing from it get moved to "removed".'),
    'GET /user/template-spaces': ('STUB', '`[]`', ''),
    'GET /user/group-spaces': ('STUB', '`[]`', ''),
    'GET /user/removed-spaces': ('M1', 'array of spaces', ''),
    'GET /user/inbox-space': ('M1', 'full Inbox space', 'Latest-updated owned space named "Inbox"; create it if missing. Never 404: called 15 s after every page load with no error handling.'),
    'GET /user/spaces-notification-unsubscribed': ('STUB', '`[]`', ''),
    'GET /user/groups-notification-unsubscribed': ('STUB', '`[]`', ''),
    'GET /space/:param/notification-resubscribe?…': ('SKIP', '', ''),
    'GET /group/:param/notification-resubscribe?…': ('SKIP', '', ''),
    'DELETE /user/permanent': ('M4', '`{}`', ''),
    'GET /user/public/:param': ('M3', '`{id,name,color,description,website, spaces:[]}`', 'User popover reads `.spaces`.'),
    'GET /user/public/multiple?…': ('M3', 'array of public users', 'Stub `[]` until M3.'),
    'GET /user/public/explore-spaces/:param': ('STUB', '`[]`', ''),
    'PATCH /user/favorites': ('STUB', '`{}`', ''),
    'GET /user/tags:param': ('M3', 'array of tags', 'Path is `/user/tags` with optional `?removeUnusedTags=true`. Stub `[]` until M3.'),
    'GET /user/groups': ('STUB', '`[]`', 'Must be an array (client calls `.forEach`).'),
    'PATCH /user/update-arena-access-token': ('SKIP', '', 'Needs an are.na client secret.'),
    'PATCH /user/apply-student-discount': ('SKIP', '', ''),
    # spaces
    'GET /space/explore-spaces': ('STUB', '`[]`', ''),
    'GET /space/everyone-spaces': ('STUB', '`[]`', ''),
    'GET /space/live-spaces': ('STUB', '`[]`', ''),
    'GET /space/:param': ('M1', 'full space', 'See SPEC.md §6.2. 404 = not found, 401 = not allowed.'),
    'GET /space/updated-at/:param': ('M1', '`{id, editedAt, updatedAt}`', 'Client refetches the space if remote `editedAt` is ≥15 min newer. Unknown id → nulls with 200, not an error (sticky banner).'),
    'GET /space/:param/favorites': ('STUB', '`[]`', ''),
    'GET /space/:param/history': ('STUB', '`[]`', 'Operation history sidebar.'),
    'GET /space/inbox': ('M1', '`{id}`', 'Create the Inbox if missing. `null` would make the client build a local Inbox it never saves.'),
    'POST /space/search-explore-spaces': ('STUB', '`[]`', ''),
    'GET /space/public/multiple?…': ('STUB', '`[]`', 'Templates dialog forces the production host for this; patched in CLIENT.md.'),
    'POST /space/multiple': ('M1', '`{}`', 'Array of full spaces posted after sign-in/up. Upsert by id; honor `isRemoved` on the locally removed spaces it includes.'),
    'POST /space/drawing-image': ('STUB', '`{}`', ''),
    'POST /space': ('M1', 'created space', 'Full space incl. nested items. Upsert by id.'),
    'POST /space/preview-image': ('STUB', '`{}`', 'Sent on every space load (throttled).'),
    'PATCH /space': ('M1', '`{}`', 'Partial `{id, ...}`, for a non-current space.'),
    'GET /space/:param/removed-cards': ('M1', 'array of full cards', ''),
    'GET /space/:param/collaborator-key': ('DEAD', '', ''),
    'PATCH /space/collaborator': ('M4', '`{}`', 'Join via invite. 401 = bad key.'),
    'DELETE /space/collaborator': ('M4', '`{collaboratorKey}`', 'Leave/remove; returns the rotated key.'),
    'PATCH /space/restore/:param': ('M1', 'restored space **with `cards` array**', 'Client calls `space.cards.filter` on the response.'),
    'POST /space/email-invites/:param': ('SKIP', '', ''),
    'GET /space/download-all': ('M3', 'zip blob', 'Saved as kinopio-spaces.zip. Contents are ours to choose (one JSON per space).'),
    # items
    'POST /operations': ('M1', '`{}`', 'The write path. See OPERATIONS.md.'),
    'POST /item/multiple': ('M2', '`{"cards":[],"spaces":[]}`', 'A read: the cards and spaces that cards link to, limited to what the viewer can read. Pulled into M2b so a summary card\'s transcript link shows the space name.'),
    'GET /card/by-link-to-space/:param': ('STUB', '`{"spaces":[],"cards":[]}`', 'Backlinks sidebar.'),
    'GET /card/:param/history': ('STUB', '`[]`', ''),
    'PATCH /card/multiple': ('M3', '`{}`', '`[{id, name, spaceId}]`: checkbox toggles on cards in other spaces.'),
    'POST /card/multiple': ('DEAD', '', ''),
    'POST /card': ('DEAD', '', ''),
    'POST /card/to-inbox': ('M2', '`{}`', 'Place at `x: 70`. 404 if no Inbox.'),
    'POST /card/search': ('M3', 'array of cards', 'Must be an array. Include `space: {name}` per card.'),
    'PATCH /card/update-counter': ('M3', '`{}`', '`{cardId, shouldIncrement, shouldDecrement}`.'),
    'PATCH /card/update-url-preview-image': ('DEAD', '', ''),
    'PATCH /connection/multiple': ('DEAD', '', ''),
    'POST /connection/multiple': ('DEAD', '', ''),
    'POST /box/multiple': ('DEAD', '', ''),
    'PATCH /box': ('M3', '`{}`', '`{id, name, nameUpdatedAt, spaceId}`: checkbox toggle on a box in another space.'),
    'GET /card/by-tag-name/:param': ('M3', 'array of cards + `spaceName`', ''),
    # billing / misc
    'POST /billing/stripe/checkout-url': ('SKIP', '', ''),
    'POST /billing/stripe/subscription-url': ('SKIP', '', ''),
    'POST /billing/stripe/customer-portal-url': ('SKIP', '', ''),
    'POST /billing/stripe/donation-url': ('SKIP', '', ''),
    'GET /affiliate': ('SKIP', '', ''),
    'GET /app-api-key': ('STUB', '`[]`', ''),
    'POST /app-api-key': ('SKIP', '', ''),
    'PATCH /app-api-key/rotate-key': ('SKIP', '', ''),
    'DELETE /app-api-key': ('SKIP', '', ''),
    # uploads
    'POST /upload/presigned-post': ('M2', '`{url, fields}`', 'S3 POST policy. File ends up at `cdnHost/<key>`.'),
    'POST /upload/presigned-post/multiple': ('M2', '`[{url, fields}]`', 'Same order as `files`.'),
    # notifications
    'GET /notification': ('STUB', '`[]`', ''),
    'DELETE /notification/all': ('STUB', '`{}`', ''),
    # services
    'POST /services/url-preview': ('M2', 'card patch', 'Status must be exactly 200. `urlPreviewUrl` must equal the requested url.'),
    'POST /services/image-search': ('STUB', '`{"photos":[]}`', 'Pexels-shaped. Real search needs an API key.'),
    'POST /services/gif-image-search': ('STUB', '`[]`', 'Giphy-shaped array.'),
    'GET /services/community-backgrounds': ('STUB', '`[]`', 'Must be an array.'),
    'POST /services/pdf': ('SKIP', '', ''),
    # groups
    'GET /group/:param': ('STUB', '404 JSON', 'Only called for spaces in groups, which we never return.'),
    'GET /group/:param/public-meta': ('SKIP', '', ''),
    'POST /group/': ('SKIP', '', ''),
    'POST /group/group-user': ('SKIP', '', ''),
    'DELETE /group/group-user': ('SKIP', '', ''),
    'DELETE /group/': ('SKIP', '', ''),
}

COMMENTED_OUT = {'PATCH /tags/color'}


def extract(client_dir):
    path = f'{client_dir}/src/stores/useApiStore.js'
    src = open(path, encoding='utf-8').read().split('\n')
    method, fn, out = None, None, []
    pending_method = None
    for i, line in enumerate(src, 1):
        if line.strip().startswith('//'):
            continue
        m = re.match(r'\s{4}(?:async\s+)?(\w+)\s*\(', line)
        if m:
            fn, method = m.group(1), None
        mm = re.search(r"method:\s*'(\w+)'", line)
        if mm:
            method = mm.group(1)
            # method set after the fetch( line (inline options object)
            if out and out[-1][3] == fn and out[-1][4] == 'pending':
                out[-1] = (method, out[-1][1], out[-1][2], fn, 'set')
        u = re.search(r"fetch(?:WithTimeout)?\(`\$\{consts\.(?:apiHost|helperServerHost)\([^)]*\)\}([^`]*)`(,?)", line)
        if u:
            raw = u.group(1)
            p = re.sub(r'\$\{[^}]*\}', ':param', raw)
            p = p.split('?')[0] + ('?…' if '?' in raw else '')
            state = 'set' if method else 'pending'
            out.append((method or 'GET', p, i, fn, state))
    return out


def main():
    client = sys.argv[1]
    commit = subprocess.run(['git', '-C', client, 'rev-parse', '--short', 'HEAD'],
                            capture_output=True, text=True).stdout.strip() or 'unknown'
    calls = extract(client)
    seen, rows, missing = set(), [], []
    for method, p, line, fn, _ in calls:
        key = f'{method} {p}'
        if key in seen:
            continue
        seen.add(key)
        if key not in C:
            missing.append(f'{key}  ({fn}, L{line})')
            continue
        rows.append((key, fn, line) + C[key])
    stale = sorted(set(C) - seen)
    if missing:
        sys.exit('Unclassified endpoints (client changed?):\n  ' + '\n  '.join(missing))
    if stale:
        sys.exit('Classified endpoints no longer in client:\n  ' + '\n  '.join(stale))

    order = list(TIERS)
    counts = {t: sum(1 for r in rows if r[3] == t) for t in order}
    print('# Endpoint inventory\n')
    print(f'Generated by `tools/endpoint_inventory.py` from kinopio-client `{commit}`. '
          'Do not edit by hand; edit the classification in the script and regenerate.\n')
    print(f'The client calls **{len(rows)}** distinct method + path combinations on the API host '
          '(one more, `PATCH /tags/color`, is commented out).\n')
    print('| Tier | Meaning | Count |\n|---|---|---|')
    for t in order:
        print(f'| {t} | {TIERS[t]} | {counts[t]} |')
    print('\nRules that apply to every row are in SPEC.md §4 (always JSON, never 204, CORS headers).\n')
    for t in order:
        tier_rows = [r for r in rows if r[3] == t]
        if not tier_rows:
            continue
        print(f'## {t}: {TIERS[t]}\n')
        print('| Method + path | Response | Notes | Client fn |\n|---|---|---|---|')
        for key, fn, line, _, resp, note in sorted(tier_rows):
            print(f'| `{key}` | {resp or "—"} | {note or ""} | `{fn}` L{line} |')
        print()


if __name__ == '__main__':
    main()
