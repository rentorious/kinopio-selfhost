# Websocket relay

Milestone 2. Without it everything still saves; you just don't see edits from another device until you reload, or until the client's staleness check fires (on focus, only if the space was edited elsewhere at least 15 min after this tab loaded it).

The relay never interprets edits. Persistence happens through `POST /operations`; the socket only carries live presence and "apply this to your local state" messages between clients viewing the same space.

## Connection

- URL: the API host with `wss://`, root path (`consts.websocketHost()`). Serve it on the same origin/port as the REST API.
- Our server routes upgrades by path (`src/realtime/upgrades.ts`): `/api/ws` is the relay; any other path gets a 404.
- The client gives up a connection attempt after 10 s and reconnects on any close code except 1000.
- The client sends no heartbeat. Send pings from the server (e.g. every 30 s) so proxies don't drop idle sockets.

## Envelope

Every client message:

```json
{ "message": { "action": "updateCardsState", "store": "cardStore", "updates": [ … ] }, "clientId": "…", "spaceId": "…", "user": { …public meta… } }
```

- `clientId`: a nanoid per page load. Two tabs of the same user have different ids.
- `user`: public meta `{ id, name, color, description, website, isUpgraded, isModerator, isDonor, isSignedIn, isSpectator, isCollaborator }`. Note `isCollaborator` is the collaborator object or absent, not a boolean.
- Action messages are batched once per animation frame; repeated actions in a frame are merged.

## Joining a room

```json
{ "message": { "name": "joinSpaceRoom" }, "spaceId": "…", "user": { … }, "clientId": "…",
  "credentials": { "apiKey": "…", "collaboratorKey": "…", "readOnlyKey": null, "userId": "…" } }
```

- `apiKey` is `''` for signed-out viewers. `collaboratorKey` may be a string **or** `{collaboratorKey}`; accept both.
- Allow the join if the space is `open`/`closed` (public), or the `apiKey` user is a member, or `collaboratorKey` or `readOnlyKey` matches the space. If the space exists and none of those hold, send `joinSpaceRoomError`.
- **If the space doesn't exist yet, leave the socket unjoined and send nothing.** On a brand-new space the client joins before its debounced `createSpace` op reaches the server, then re-sends the join once it has. `joinSpaceRoomError` would put up a sticky error banner that the later successful join doesn't clear.
- **Bind identity and room to the socket at join time.** Later messages carry no credentials. Drop any later message whose `spaceId` isn't the socket's room.
- Mark sockets that joined with only a `readOnlyKey` (or as non-members of a non-open space) as read-only and drop their state-changing actions: every store-qualified action, plus the `globalStore` drawing triggers (`triggerAddDrawingStroke`, `triggerRemoveDrawingStroke`, `triggerUpdateDrawingDataUrl`, `triggerUpdateRemoteDrawingStrokes`). Presence (cursors, selections, dragging) still goes through.
- A client changing spaces sends `userLeftRoom` and then a new `joinSpaceRoom` on the same socket. It may also re-send `joinSpaceRoom` for the same space right after creating it on the server.

On a successful join, send `userJoinedRoom` (with the joiner's `user`) to everyone else in the room. On socket close, send `userLeftRoom` with `user: {id}` to the room.

## Server → client messages

The server also sends its own action messages to a room (`Relay.broadcast` in `src/realtime/relay.ts`, used by M2b to update a card live). They follow the same envelope, without `clientId`.

Every message must have a `message` object (the client destructures it unguarded). Omit `clientId` on server-originated messages. If you include `spaceId`, it must equal the receiver's current space or the message is dropped.

| `message.name` | Required top-level fields | Client effect |
|---|---|---|
| `connected` | — | Logs only |
| `joinSpaceRoomError` | — | Shows a connection error |
| `userJoinedRoom` | `user` (`id`, `name`, `color`, `isCollaborator`) | Adds the user to clients/spectators (or collaborators if `isCollaborator`) |
| `userLeftRoom` | `user: {id}` | Removes presence and their remote selections |
| `userLeftSpace` | `user: {id, name}` | Removes a collaborator; if it's the receiver, they lose access. M4: send after `DELETE /space/collaborator`. |
| `updateSpaceClients` | — | Effectively a no-op in this client version |

## Relaying

Relay each client message unchanged (keep `message`, `user`, `clientId`, `spaceId`) to every other socket in the room. Echoing to the sender is harmless (it filters its own `clientId`), but skip it to save bandwidth.

### Allowlist (security)

The receiving client runs `store[action](updates)` for whatever `store` and `action` the message names. Without a filter, anyone in a room could make other clients call arbitrary store actions, including `userStore.updateUser`, which writes to the victim's account via the operation queue. **Only relay messages whose store + action is in this list.** Drop and log everything else.

Also strip `apiKey`, `email`, `arenaAccessToken` from `updates` before relaying (`broadcastUpdateUser` relays whatever partial user update was made).

`globalStore` (also the default when `message.store` is absent), 54 actions:

```
addToRemoteBoxesDragging addToRemoteCardsDragging addToRemoteConnectionDetailsVisible
addToRemoteLinesDragging addToRemoteListsDragging addToRemoteUploadDraggedOverCards
clearRemoteBoxDetailsVisible clearRemoteBoxesDragging clearRemoteCardDetailsVisible
clearRemoteCardsDragging clearRemoteConnectionDetailsVisible clearRemoteLineDetailsVisible
clearRemoteLinesDragging clearRemoteListDetailsVisible clearRemoteListsDragging
clearRemoteMultipleSelected clearRemoteUploadDraggedOverCards
removeFromRemoteBoxesSelected removeFromRemoteCardsSelected removeFromRemoteConnectionsSelected
removeRemoteCurrentConnection removeRemoteUserDraggingConnectionLabel removeRemoteUserResizingBoxes
removeRemoteUserResizingCards removeRemoteUserResizingLists removeRemoteUserTiltingCards
triggerAddDrawingStroke triggerAddRemotePaintingCircle triggerRemoveDrawingStroke triggerSonarPing
triggerUpdateDrawingDataUrl triggerUpdateRemoteDrawingStrokes triggerUpdateRemoteDropGuideLine
triggerUpdateRemoteUserCursor triggerUpdateStopRemoteUserDropGuideLine
updateRemoteBoxDetailsVisible updateRemoteBoxesSelected updateRemoteCardDetailsVisible
updateRemoteCardsSelected updateRemoteConnectionsSelected updateRemoteCurrentConnection
updateRemoteDrawingStrokesSelected updateRemoteLineDetailsVisible updateRemoteLinesSelected
updateRemoteListDetailsVisible updateRemoteListsSelected updateRemotePreviousBoxSelectStyles
updateRemoteUserBoxSelectStyles updateRemoteUserDraggingConnectionLabel updateRemoteUserResizingBoxes
updateRemoteUserResizingCards updateRemoteUserResizingLists updateRemoteUserTiltingCards
updateUserPresence
```

Store-qualified, 19 pairs:

```
cardStore:        addCardToState updateCardsState removeCardFromState
boxStore:         addBoxToState updateBoxesState removeBoxesRemote
connectionStore:  addConnectionToState updateConnectionsState removeConnectionsFromState
lineStore:        addLineToState updateLinesState removeLinesFromState
listStore:        addListToState updateListsState removeListsBroadcast
spaceStore:       updateSpace updateUser updateCollaborator updateSpectator
```

(`spaceStore.updateUser/updateCollaborator/updateSpectator` are built dynamically as `` `update${permission}` `` in `useUserStore.broadcastUpdateUser`.)

Name-only messages to relay: `userLeftRoom` (client-sent on space change) and `updateRemotePendingUploads` (sent without an `action` due to a client bug, so receivers ignore it; relaying is harmless).

Regenerate this list when the client is bumped. A quick check: grep `broadcastStore.update(` in the client and compare (CLIENT.md has the command).
