import fs from 'node:fs'
import path from 'node:path'
import type { WorkerConfig } from './config'
import { run, tail } from './proc'

export interface Segment {
  startMs: number
  endMs: number
  text: string
}

export interface Transcript {
  segments: Segment[]
  /** What whisper detected (or was told), e.g. "en". */
  language: string
  model: string
}

/**
 * Run whisper.cpp on a 16 kHz WAV. Flags come from the manual runs on the
 * lecture recording (docs/MEDIA-SUMMARIES.md §7.2):
 * - `-mc 0 -et 2.8` stop large-v3's repetition loops (`-mc 0` also makes
 *   whisper ignore --prompt, which is why the topic hint goes to Claude);
 * - `--vad` skips silence, where most hallucinations come from;
 * - `-oj` writes segments with timestamps, `-pp` prints progress.
 */
export async function transcribe (
  config: WorkerConfig, wav: string, outDir: string, language: string, model: string,
  onProgress: (percent: number) => void, signal?: AbortSignal
): Promise<Transcript> {
  const base = path.join(outDir, `whisper-${path.basename(model).replace(/\W+/g, '-')}`)
  const args = ['-m', model, '-f', wav, '-l', language || 'auto', '-mc', '0', '-et', '2.8', '-oj', '-of', base, '-pp']
  if (config.vadModel) args.push('--vad', '-vm', config.vadModel)
  if (config.whisperThreads) args.push('-t', String(config.whisperThreads))
  const res = await run(config.whisperBin, args, {
    signal,
    timeoutMs: 6 * 60 * 60_000,
    onStderrLine: line => {
      const m = /progress\s*=\s*(\d+)%/.exec(line)
      if (m) onProgress(Math.min(100, Number(m[1])))
    }
  })
  if (res.code !== 0) throw new Error(`whisper failed: ${tail(res.stderr)}`)
  const raw = JSON.parse(await fs.promises.readFile(`${base}.json`, 'utf8')) as {
    result?: { language?: string }
    transcription?: Array<{ offsets?: { from?: number, to?: number }, text?: string }>
  }
  const segments = (raw.transcription ?? [])
    .map(s => ({ startMs: Number(s.offsets?.from ?? 0), endMs: Number(s.offsets?.to ?? 0), text: String(s.text ?? '').trim() }))
    .filter(s => s.text)
  return { segments, language: raw.result?.language || language || 'auto', model: path.basename(model).replace(/^ggml-|\.bin$/g, '') }
}

/** The same line more than `limit` times in a row: whisper's repetition loop. */
export function hasRepetitionLoop (segments: Segment[], limit = 5): boolean {
  let run = 1
  for (let i = 1; i < segments.length; i++) {
    const same = segments[i].text.toLowerCase() === segments[i - 1].text.toLowerCase()
    run = same ? run + 1 : 1
    if (run > limit) return true
  }
  return false
}
