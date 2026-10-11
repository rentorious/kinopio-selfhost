/**
 * Upload keys are `<id>/<filename>` (SPEC.md §7). The id is the card, space or
 * box id (a nanoid); the client normalizes filenames with
 * `name.replace(/[^a-z0-9-.]+/ig, '-')`, keeping case and dots.
 */
const KEY_PATTERN = /^([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9.-]{1,255})$/

export function isValidKey (key: unknown): key is string {
  if (typeof key !== 'string') return false
  const m = KEY_PATTERN.exec(key)
  // a filename of only dots would walk out of the id's folder on disk
  return !!m && !/^\.+$/.test(m[2])
}
