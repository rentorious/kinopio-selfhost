/**
 * What the PC worker and the server agree on (docs/MEDIA-SUMMARIES.md §5, §7.3).
 *
 * Shared by both builds, so it must not import anything: the worker compiles
 * this file directly.
 */

/** Kinopio's card limit (consts.cardCharacterLimit). */
export const CARD_CHARACTER_LIMIT = 4000
/** card.md may use this much; the server adds a source line and the transcript link. */
export const CARD_MD_LIMIT = 3200
export const SECTION_TEXT_LIMIT = 3600
export const CORRECTIONS_LIMIT = 3600
export const TITLE_LIMIT = 80
export const HEADING_LIMIT = 120
export const MAX_SECTIONS = 300

export type WorkerStage = 'transcribing' | 'summarizing'

/** worker → server */
export type WorkerMessage =
  | { type: 'hello', version: string, model: string, gpu: string, activeJobId?: string }
  | { type: 'downloaded', jobId: string }
  | { type: 'progress', jobId: string, stage: WorkerStage, percent?: number }
  | { type: 'failed', jobId: string, reason: string }

/** server → worker */
export type ServerMessage =
  | { type: 'job', job: JobOffer }
  | { type: 'cancel', jobId: string }

export interface JobOffer {
  jobId: string
  fileName: string
  mimeType: string
  bytes: number
  /** The part of the file to transcribe, in ms from its start. */
  startMs: number
  endMs: number
  /** ISO 639-1 code, or 'auto'. */
  language: string
  /** Optional hint for the summary step: names, jargon, the subject. */
  topic: string
  /** Path to GET the file from, relative to the server origin. */
  mediaPath: string
  /** Path to POST the result to. */
  resultPath: string
}

export interface ResultSection {
  heading: string
  /** Times in the original file (ms), not in the cut. */
  startMs: number
  endMs: number
  text: string
}

export interface MediaResult {
  title: string
  /** card.md: `# Title`, `## Summary`, `## Key points`. */
  card: string
  sections: ResultSection[]
  corrections?: string
  transcriber: { model: string, language: string }
  /** True when the summary step failed and the card only points at the transcript. */
  summaryFailed?: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * Check a result against every limit in the contract. Both the worker (before
 * posting) and the server (before using it) run this.
 */
export function validateResult (value: unknown, range?: { startMs: number, endMs: number }): { ok: true, result: MediaResult } | { ok: false, errors: string[] } {
  const errors: string[] = []
  if (!isObj(value)) return { ok: false, errors: ['result must be an object'] }
  const { title, card, sections, corrections, transcriber, summaryFailed } = value

  if (!isStr(title) || !title.trim()) errors.push('title is required')
  else if (title.length > TITLE_LIMIT) errors.push(`title is longer than ${TITLE_LIMIT} characters`)

  if (!isStr(card) || !card.trim()) errors.push('card is required')
  else if (card.length > CARD_MD_LIMIT) errors.push(`card is ${card.length} characters; the limit is ${CARD_MD_LIMIT}`)

  if (!Array.isArray(sections) || sections.length === 0) errors.push('sections must be a non-empty array')
  else if (sections.length > MAX_SECTIONS) errors.push(`more than ${MAX_SECTIONS} sections`)
  else {
    // a little slack for rounding at the edges of the cut
    const lo = range ? range.startMs - 2000 : 0
    const hi = range ? range.endMs + 2000 : Infinity
    sections.forEach((s: unknown, i: number) => {
      const n = i + 1
      if (!isObj(s)) { errors.push(`section ${n} must be an object`); return }
      if (!isStr(s.heading) || !s.heading.trim()) errors.push(`section ${n} needs a heading`)
      else if (s.heading.length > HEADING_LIMIT) errors.push(`section ${n} heading is longer than ${HEADING_LIMIT} characters`)
      if (!isStr(s.text) || !s.text.trim()) errors.push(`section ${n} has no text`)
      else if (s.text.length > SECTION_TEXT_LIMIT) errors.push(`section ${n} is ${s.text.length} characters; the limit is ${SECTION_TEXT_LIMIT}`)
      if (!isMs(s.startMs) || !isMs(s.endMs) || s.endMs < s.startMs) errors.push(`section ${n} needs startMs <= endMs`)
      else if (s.startMs < lo || s.endMs > hi) errors.push(`section ${n} times are outside the transcribed range`)
    })
  }

  if (corrections !== undefined && !isStr(corrections)) errors.push('corrections must be a string')
  else if (isStr(corrections) && corrections.length > CORRECTIONS_LIMIT) errors.push(`corrections are longer than ${CORRECTIONS_LIMIT} characters`)

  if (!isObj(transcriber) || !isStr(transcriber.model) || !isStr(transcriber.language)) errors.push('transcriber needs model and language')
  if (summaryFailed !== undefined && typeof summaryFailed !== 'boolean') errors.push('summaryFailed must be a boolean')

  if (errors.length) return { ok: false, errors }
  return { ok: true, result: value as unknown as MediaResult }
}

/** 0:05, 12:34, 1:02:03 */
export function formatTimestamp (ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Parse `m:ss` or `h:mm:ss` (also plain seconds) to ms; undefined if it isn't a time. */
export function parseTimestamp (text: string): number | undefined {
  const t = text.trim()
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000)
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?$/.exec(t)
  if (!m) return undefined
  const [, h, min, sec, frac] = m
  if (Number(sec) > 59 || (h !== undefined && Number(min) > 59)) return undefined
  return ((Number(h ?? 0) * 60 + Number(min)) * 60 + Number(sec)) * 1000 + (frac ? Math.round(Number(`0.${frac}`) * 1000) : 0)
}
