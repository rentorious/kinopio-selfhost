/**
 * Store actions the relay forwards (docs/WEBSOCKET.md, "Allowlist").
 *
 * The receiving client runs `store[action](updates)` for whatever the message
 * names, so anything not listed here is dropped. Regenerate when the client is
 * bumped: grep `broadcastStore.update(` in kinopio-client.
 */

const GLOBAL_STORE_ACTIONS = `
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
`.split(/\s+/).filter(Boolean)

const STORE_ACTIONS: Record<string, string[]> = {
  globalStore: GLOBAL_STORE_ACTIONS,
  cardStore: ['addCardToState', 'updateCardsState', 'removeCardFromState'],
  boxStore: ['addBoxToState', 'updateBoxesState', 'removeBoxesRemote'],
  connectionStore: ['addConnectionToState', 'updateConnectionsState', 'removeConnectionsFromState'],
  lineStore: ['addLineToState', 'updateLinesState', 'removeLinesFromState'],
  listStore: ['addListToState', 'updateListsState', 'removeListsBroadcast'],
  spaceStore: ['updateSpace', 'updateUser', 'updateCollaborator', 'updateSpectator']
}

const ALLOWED = new Map(Object.entries(STORE_ACTIONS).map(([store, actions]) => [store, new Set(actions)]))

/** globalStore actions that change what's drawn on the space, not just presence. */
const DRAWING_ACTIONS = new Set(['triggerAddDrawingStroke', 'triggerRemoveDrawingStroke', 'triggerUpdateDrawingDataUrl', 'triggerUpdateRemoteDrawingStrokes'])

/** Messages with a `name` and no `action` that are relayed as-is. */
export const RELAYED_NAMES = new Set(['updateRemotePendingUploads'])

export function isAllowedAction (store: string, action: string): boolean {
  return ALLOWED.get(store)?.has(action) ?? false
}

/** Actions a read-only viewer may not send: every item store, plus drawing. */
export function changesContent (store: string, action: string): boolean {
  return store !== 'globalStore' || DRAWING_ACTIONS.has(action)
}

export const ALLOWLIST_SIZE = [...ALLOWED.values()].reduce((n, set) => n + set.size, 0)
