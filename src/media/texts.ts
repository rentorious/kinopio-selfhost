import { nanoid } from '../common/ids'
import type { MediaJobStatus } from '../db/database'
import { CARD_CHARACTER_LIMIT, formatTimestamp, MediaResult } from './contract'

/** Card text while a job runs (docs/MEDIA-SUMMARIES.md §4). */
export function stageText (fileName: string, status: MediaJobStatus, percent?: number | null, error?: string | null): string {
  switch (status) {
    case 'queued': return `⏳ ${fileName} · waiting for transcriber`
    case 'downloading': return `⏳ ${fileName} · sending to transcriber`
    case 'transcribing': return `⏳ ${fileName} · transcribing${typeof percent === 'number' ? ` ${percent}%` : ''}`
    case 'summarizing': return `⏳ ${fileName} · summarizing`
    case 'building': return `⏳ ${fileName} · creating transcript`
    case 'failed': return `⚠️ ${fileName} · ${error || 'failed'} · drop the file again to retry`
    case 'canceled': return `✖ ${fileName} · canceled`
    default: return `⏳ ${fileName}`
  }
}

export function languageName (code: string): string {
  if (!code || code === 'auto') return 'auto-detected language'
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

function duration (ms: number): string {
  const totalMin = Math.round(ms / 60000)
  if (ms < 60000) return `${Math.round(ms / 1000)} s`
  if (totalMin < 60) return `${totalMin} min`
  return `${Math.floor(totalMin / 60)} h ${totalMin % 60} min`
}

export interface JobInfo {
  fileName: string
  startMs: number
  endMs: number
  language: string
}

/** 🎧 lecture.mp4 · 5:00–55:00 (50 min) · English */
export function sourceLine (job: JobInfo): string {
  return `🎧 ${job.fileName} · ${formatTimestamp(job.startMs)}–${formatTimestamp(job.endMs)} (${duration(job.endMs - job.startMs)}) · ${languageName(job.language)}`
}

/** The finished summary card: card.md, then the source line and the transcript link, within the card limit. */
export function summaryCardText (result: MediaResult, job: JobInfo, transcriptUrl: string): string {
  const footer = `\n\n${sourceLine(job)}\n${transcriptUrl}`
  let body = result.card.trim()
  const room = CARD_CHARACTER_LIMIT - footer.length
  if (body.length > room) body = body.slice(0, room - 1).trimEnd() + '…'
  return body + footer
}

export interface NewCard {
  id: string
  x: number
  y: number
  z: number
  name: string
  resizeWidth: number
  isRemoved: false
}

const CARD_WIDTH = 520
const COLUMN_GAP = 80
const ROW_GAP = 24
const COLUMN_MAX_HEIGHT = 6000
const ORIGIN = 100

/**
 * Kinopio measures card heights in the browser, so the server estimates them
 * generously (about 60 characters per line at this width) to avoid overlaps.
 */
export function estimateHeight (text: string): number {
  const lines = text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 60)), 0)
  return 28 + lines * 20
}

/**
 * Cards for the transcript space: a header, one card per section, then the
 * corrections. Laid out top to bottom in columns that read left to right.
 */
export function transcriptCards (result: MediaResult, job: JobInfo, backLink: string): NewCard[] {
  const texts = [
    `# ${result.title}\n\n${sourceLine(job)}\n\nSummary card: ${backLink}`,
    ...result.sections.map(s => `**${formatTimestamp(s.startMs)}–${formatTimestamp(s.endMs)} · ${s.heading.trim()}**\n\n${s.text.trim()}`),
    ...(result.corrections?.trim() ? [`**Corrections**\n\n${result.corrections.trim()}`] : [])
  ]
  const cards: NewCard[] = []
  let x = ORIGIN
  let y = ORIGIN
  texts.forEach((name, i) => {
    const height = estimateHeight(name)
    if (y > ORIGIN && y + height > COLUMN_MAX_HEIGHT) {
      x += CARD_WIDTH + COLUMN_GAP
      y = ORIGIN
    }
    cards.push({ id: nanoid(), x, y, z: i + 1, name: name.slice(0, CARD_CHARACTER_LIMIT), resizeWidth: CARD_WIDTH, isRemoved: false })
    y += height + ROW_GAP
  })
  return cards
}
