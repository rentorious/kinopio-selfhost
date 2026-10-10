# `POST /operations`

Almost every edit the client makes is persisted through this one endpoint. This doc covers the wire format, the processing rules, and what each of the 50 operation names must do.

`tools/operation_inventory.py` checks this table against a client checkout and fails if the client sends an operation name that isn't listed here.

## Wire format

The request body is a JSON array, in the order the client queued it:

```json
[
  { "name": "createCard", "body": { "id": "…", "x": 120, "y": 80, "name": "hello", "operationId": "…", "spaceId": "…", "userId": "…", "clientCreatedAt": "2026-10-10T12:00:00.000Z" } },
  { "name": "updateCard", "body": { "id": "…", "x": 140, "operationId": "…", "spaceId": "…", "userId": "…", "clientCreatedAt": "…" } }
]
```

Headers: `Authorization` (apiKey), `Space-Authorization` (current space's collaboratorKey, if any), `Request-Id`, `User-Id`.

The client adds four fields to every object body:

| Field | Meaning | How the server should treat it |
|---|---|---|
| `operationId` | nanoid, unique per op | Dedupe key (see rule 2) |
| `spaceId` | The space the op targets: the current space, unless the call site overrides it | Target space for item ops. Check permission against it. |
| `userId` | The **acting** user | Never store as an item's owner on update/restore. Use the authenticated user, not this field. |
| `clientCreatedAt` | ISO timestamp | Optional; useful for logging |

Three ops send an **array** body instead (`updateNotificationsIsRead`, `updateUserVisitSpaces`, `addCollaboratorToSpaces`). JSON serialization drops the four fields from arrays, so those bodies carry no `operationId` or `spaceId`.

## Processing rules

1. **Apply in array order, one at a time.** Commit each op that succeeds even if a later one fails. The client clears its queue before sending and never retries a failed batch, so all-or-nothing would lose good edits.
2. **Dedupe on `operationId`.** If the tab dies after the server got the batch, the client re-sends it from its IndexedDB backup with the same ids. Keep a table of applied ids for about a week.
3. **Updates are partial patches.** Merge the body's fields into the stored item (`data || patch` in Postgres). An explicit `null` clears a field. Strip the four envelope fields first.
4. **Names are last-writer-wins, but only when the patch says so.** If the patch has `nameUpdatedAt` and the stored item's `nameUpdatedAt` is newer, keep the stored `name` and `nameUpdatedAt` and apply the rest. If the patch has a `name` but no `nameUpdatedAt`, apply it: box renames and edits to cards in other spaces don't send one.
5. **Creates are upserts.** Undo/redo re-sends `create*` with the same id after a remove, and MoveOrCopy can send items that already exist.
6. **No foreign-key checks on create.** Connections can arrive before the boxes they point at in the same batch (MoveOrCopy queues boxes after connections). `startItemId`/`endItemId` can point at a card, box or list.
7. **Tolerate merged array bodies.** If two array-body ops merge in the client queue, the body becomes an object with numeric keys (`{"0": …, "1": …, "operationId": …}`). Take the values of the numeric keys.
8. **Unknown op names succeed as no-ops** (log them). Returning an error for something we don't care about would show the "could not save" banner.
9. **Permission, for space and item ops only:** the authenticated user must be able to edit `body.spaceId` (owner, or collaborator in M4), otherwise that op fails with status 401. User-level ops (`updateUser`, `updateUserCardsCreatedCount*`, favorites, `deleteAllRemovedSpaces`, `removeTagsByName`, `updateTagColorByName`, and the array-body ops) also get the current space stamped as `spaceId`, or none at all. Ignore it for them; they act on the authenticated user.

## Response

- **All applied:** `200 {}`. The client only checks `response.ok`; it never reads the body.
- **Any op failed:** a non-2xx status (use 400 for the batch) with a JSON body:

  ```json
  { "operations": [ … ], "errors": [ { "status": 404, "operationId": "…", "name": "updateCard", "message": "space not found" } ] }
  ```

  `errors` must be an array, and each entry needs a numeric `status`. The client treats 400, 401 and 404 as non-critical (console warning). Any other status shows the "server could not save" banner. Don't use 207: it counts as `ok`, so the client would ignore the errors.

## Operations

Tier meanings are in ENDPOINTS.md: M1–M4 are milestones, **ACCEPT** means return success and do nothing, **DEAD** means the client never actually sends it.

| Operation | Tier | Body (besides envelope) | Semantics |
|---|---|---|---|
| `createSpace` | M1 | Full space incl. nested `cards`, `connections`, `boxes`, `lists`, `lines`, `tags`, `drawingStrokes`, `removedCards`, plus `users`, `cacheDate` | Upsert the space and all nested items. `removedCards` become cards with `isRemoved: true`. **Ignore `users`, `collaborators`, `clients`, `spectators`, `cacheDate`**: `users` can hold the full local user state including `apiKey` and email. Owner is the authenticated user; if the space already exists and belongs to someone else, fail with 401. Generate `collaboratorKey`/`readOnlyKey` if missing or `""`. |
| `updateSpace` | M1 | `{id, ...changed}` | Partial merge. Seen keys: `name`, `isTemplate`, `privacy`, `showInExplore`, `background`, `backgroundTint`, `backgroundGradient`, `backgroundIsGradient`, `editedAt`, `editedByUserId`, `note`, `userNewCardColor`, `updatedAt`, `collaboratorKey`. |
| `removeSpace` | M1 | `{id}` | Soft delete: `isRemoved: true`, `removedByUserId`. |
| `deleteSpace` | M1 | Full space | Hard delete the space and all its items. Only `id` matters. |
| `deleteAllRemovedSpaces` | M1 | `{userId}` | Hard delete every removed space the user owns. |
| `createCard` | M1 | Full card | Upsert into `body.spaceId`. Drop client-only `position`, `isParentCard`, `user`. |
| `updateCard` | M1 | `{id, ...changed}` | Partial merge with rule 4. `{id, isRemoved: true}` is the normal soft remove; `{id, isRemoved: false}` restores. May target another space via the `spaceId` override. |
| `removeCard` | M1 | Full card | Soft remove (`isRemoved: true`). Only sent when a card leaves the Inbox. |
| `deleteCard` | M1 | Full card | Hard delete. The card may have been created earlier in the same batch. |
| `restoreRemovedCard` | M1 | Full card with `isRemoved: false` | Upsert with `isRemoved: false`. |
| `deleteAllRemovedCards` | M1 | `{userId, spaceId}` | Hard delete all `isRemoved` cards in the space. |
| `createCardInInbox` | M2 | `{id, name, z, userId, nameUpdatedAt?, urlPreviewUrl?, shouldUpdateUrlPreview?}` | Same as `POST /card/to-inbox`: create in the user's Inbox at `x: 70`. `body.spaceId` is the current space, **not** the Inbox. |
| `createConnection` | M1 | `id`, `startItemId`, `endItemId`, `path`, `controlPoint`, `color`, `name`, `labelIsVisible`, `directionIsVisible`, `labelRelativePositionX/Y` | Upsert. |
| `updateConnection` | M1 | `{id, ...changed}` | Partial merge. |
| `removeConnection` | M1 | `{id}` | Hard delete. |
| `createBox` | M1 | Full box | Upsert. |
| `updateBox` | M1 | `{id, ...changed}` | Partial merge. |
| `removeBox` | M1 | `{id}` | Hard delete. The client sends separate `removeConnection` ops. |
| `createList` | M1 | Full list | Upsert. |
| `updateList` | M1 | `{id, ...changed}` | Partial merge. |
| `removeList` | M1 | Full list | Hard delete, and set `listId`/`listPositionIndex` to null on its cards (the client's own card updates can arrive out of order). |
| `createLine` | M1 | `{id, color, y, name}` | Upsert. |
| `updateLine` | M1 | `{id, ...changed}` | Partial merge. |
| `removeLine` | M1 | Full line | Hard delete. |
| `createDrawingStroke` | M1 | `{stroke: [{id, x, y, color, diameter}, …]}` | Append one stroke. Its id is `stroke[0].id`. Keep insertion order (`seq`); reads return newest first, see SPEC.md §5. |
| `removeDrawingStroke` | M1 | `{stroke: [...]}` | Delete the stroke whose id is `stroke[0].id`. Moving a stroke is sent as remove then create with the same id. |
| `clearDrawing` | M1 | `{}` | Delete every stroke in `body.spaceId`. |
| `updateTags` | M1 | `{tags: [{id, name, color, cardId, spaceId}, …]}` | Upsert each tag by id. This is the only way tags get created. |
| `removeTag` | M1 | Tag object | Hard delete by `id`. |
| `removeTagsByName` | M1 | Tag object | Delete all of the user's tags with this `name`, across their spaces. |
| `updateTagColorByName` | M1 | `{tag: {name, color, …}}` | Set `color` on all of the user's tags with this `name`. |
| `updateUser` | M1 | Partial user | Merge into the user's stored prefs. **Never** accept the protected keys listed in SPEC.md §6.1 (`id`, `apiKey`, `email`, `password*`, `stripe*`, `appleSubscriptionIsActive`, `downgradeAt`, `isModerator`, `isDonor`, `isUpgraded`). Note `lastSpace` (sic) is sent instead of `lastSpaceId` when clearing. |
| `updateUserCardsCreatedCount` | M1 | `{delta}` | `cardsCreatedCount += delta`. Harmless since our user is "upgraded", but keep it accurate. |
| `updateUserCardsCreatedCountRaw` | M1 | `{delta}` | `cardsCreatedCountRaw += delta`. |
| `updateSpaceIsHidden` | M3 | `{spaceId, isHidden}` | Add/remove from hidden spaces. ACCEPT until M3. |
| `updateFavoriteSpace` | ACCEPT | `{spaceId, value}` | Favorites (M4 if ever). |
| `updateFavoriteUser` | ACCEPT | `{favoriteUserId, value}` | |
| `updateFavoriteColor` | ACCEPT | `{color, value}` | |
| `updateUserVisitSpaces` | ACCEPT | Array of favorite spaces | Marks favorites as seen. |
| `updateNotificationsIsRead` | ACCEPT | Array of notification ids | |
| `createUserNotification` | ACCEPT | `{type, recipientUserIds, cardId?, …}` | Notifications for other users. |
| `removeUserNotification` | ACCEPT | `{type, recipientUserIds, …}` | |
| `updateUrlPreviewImage` | M2 | Card-shaped url-preview data with `id` | The preview fields are already saved by the matching `updateCard`. M2 can optionally re-host `urlPreviewImage` in our bucket; otherwise ACCEPT. |
| `addCollaboratorToSpaces` | M4 | Array of `{id, collaboratorKey, userId, …}` | For each entry, if `collaboratorKey` matches the space, add the user as collaborator. ACCEPT until M4. |
| `updateGroup` | ACCEPT | | Groups are out of scope. |
| `updateGroupUser` | ACCEPT | | |
| `addSpaceToGroup` | ACCEPT | | |
| `removeSpaceFromGroup` | ACCEPT | | |
| `createItem` | DEAD | | Template store nobody imports. |
| `removeItem` | DEAD | | |
