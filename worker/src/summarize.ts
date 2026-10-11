import fs from 'node:fs'
import path from 'node:path'
import {
  formatTimestamp, MediaResult, parseTimestamp, ResultSection, SECTION_TEXT_LIMIT, TITLE_LIMIT, validateResult
} from '../../src/media/contract'
import type { WorkerConfig } from './config'
import { run, tail } from './proc'
import type { Segment } from './whisper'

export interface SummarizeInput {
  fileName: string
  startMs: number
  endMs: number
  durationMs?: number
  language: string
  topic: string
  segments: Segment[]
  transcriber: { model: string, language: string }
}

function promptText (): string {
  // built: worker/dist/worker/src → worker/prompt.md; from source: worker/src → worker/prompt.md
  for (const candidate of [path.join(__dirname, '..', '..', '..', 'prompt.md'), path.join(__dirname, '..', 'prompt.md')]) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
  }
  throw new Error('worker/prompt.md not found')
}

/** Arguments for the headless session: print mode, file tools only, no MCP, no saved session. */
export function claudeArgs (config: WorkerConfig, prompt: string): string[] {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--tools', 'Read,Write,Edit,Glob',
    '--disallowedTools', 'mcp__*',
    '--strict-mcp-config',
    '--permission-mode', 'acceptEdits',
    '--max-turns', String(config.claudeMaxTurns),
    '--no-session-persistence'
  ]
  if (config.claudeRestricted) args.push('--restricted')
  if (config.claudeModel) args.push('--model', config.claudeModel)
  return [...args, ...config.claudeArgs]
}

/**
 * Read the session's output folder back into a result: `card.md`,
 * `transcript/NNN.md` with front matter, optional `corrections.md`.
 */
export async function readOutput (dir: string, input: SummarizeInput): Promise<MediaResult> {
  const out = path.join(dir, 'output')
  const read = async (p: string) => (await fs.promises.readFile(p, 'utf8')).replace(/\r\n/g, '\n')
  let card = ''
  try { card = (await read(path.join(out, 'card.md'))).trim() } catch { /* reported by validation */ }
  const title = /^#\s+(.+)$/m.exec(card)?.[1]?.trim() ?? ''

  const sections: ResultSection[] = []
  let files: string[] = []
  try { files = (await fs.promises.readdir(path.join(out, 'transcript'))).filter(f => /^\d+\.md$/.test(f)).sort() } catch { /* none */ }
  for (const file of files) {
    const text = await read(path.join(out, 'transcript', file))
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
    if (!m) { sections.push({ heading: '', startMs: -1, endMs: -1, text: '' }); continue }
    const meta: Record<string, string> = {}
    for (const line of m[1].split('\n')) {
      const kv = /^(\w+):\s*(.*)$/.exec(line.trim())
      if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim()
    }
    sections.push({
      heading: meta.heading ?? '',
      startMs: parseTimestamp(meta.start ?? '') ?? -1,
      endMs: parseTimestamp(meta.end ?? '') ?? -1,
      text: m[2].trim()
    })
  }

  let corrections: string | undefined
  try { corrections = (await read(path.join(out, 'corrections.md'))).trim() || undefined } catch { /* optional */ }
  return { title, card, sections, ...(corrections ? { corrections } : {}), transcriber: input.transcriber }
}

/**
 * When the summary step fails twice, still hand back the transcript:
 * sections cut mechanically from the whisper segments.
 */
export function fallbackResult (input: SummarizeInput): MediaResult {
  const sections: ResultSection[] = []
  let current: ResultSection | undefined
  for (const seg of input.segments) {
    const piece = seg.text.trim()
    if (!piece) continue
    if (current && current.text.length + piece.length + 1 > 3000) current = undefined
    if (!current) {
      current = { heading: '', startMs: seg.startMs, endMs: seg.endMs, text: piece }
      sections.push(current)
    } else {
      current.text += ' ' + piece
      current.endMs = seg.endMs
    }
  }
  sections.forEach((s, i) => { s.heading = `Part ${i + 1} (${formatTimestamp(s.startMs)}–${formatTimestamp(s.endMs)})`; s.text = s.text.slice(0, SECTION_TEXT_LIMIT) })
  const title = input.fileName.slice(0, TITLE_LIMIT)
  return {
    title,
    card: `# ${title}\n\nSummary failed; the transcript is attached.`,
    sections,
    transcriber: input.transcriber,
    summaryFailed: true
  }
}

export interface SummarizeOptions {
  signal?: AbortSignal
  log?: (msg: string) => void
}

/**
 * Run the headless Claude Code session in `dir` and return a validated
 * result. One retry with the problems listed; after that, the
 * transcript-only fallback.
 */
export async function summarize (config: WorkerConfig, dir: string, input: SummarizeInput, opts: SummarizeOptions = {}): Promise<MediaResult> {
  const log = opts.log ?? (() => undefined)
  await fs.promises.mkdir(path.join(dir, 'input'), { recursive: true })
  await fs.promises.writeFile(path.join(dir, 'input', 'meta.json'), JSON.stringify({
    fileName: input.fileName, startMs: input.startMs, endMs: input.endMs, durationMs: input.durationMs ?? null,
    language: input.transcriber.language || input.language, topic: input.topic
  }, null, 2))
  await fs.promises.writeFile(path.join(dir, 'input', 'transcript.json'), JSON.stringify(input.segments, null, 1))

  const base = promptText()
  let problems: string[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    await fs.promises.rm(path.join(dir, 'output'), { recursive: true, force: true })
    await fs.promises.mkdir(path.join(dir, 'output', 'transcript'), { recursive: true })
    const prompt = problems.length
      ? `${base}\n\n## Your previous attempt had these problems\n\n${problems.map(p => `- ${p}`).join('\n')}\n\nWrite all the files again, fixing them.`
      : base
    try {
      const res = await run(config.claudeBin, claudeArgs(config, prompt), { cwd: dir, signal: opts.signal, timeoutMs: config.claudeTimeoutMs })
      if (res.code !== 0) {
        problems = ['the session ended with an error']
        log(`claude exited with ${res.code}: ${tail(res.stderr || res.stdout)}`)
        continue
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err
      problems = ['the session did not finish in time']
      log(`claude failed: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const result = await readOutput(dir, input)
    const checked = validateResult(result, { startMs: input.startMs, endMs: input.endMs })
    if (checked.ok) return checked.result
    problems = checked.errors
    log(`attempt ${attempt}: output didn't pass the contract: ${problems.join('; ')}`)
  }
  log('summary failed twice; sending the transcript on its own')
  return fallbackResult(input)
}
