import type { WorkerConfig } from './config'
import { run, tail } from './proc'

/** A failure the user should see on the card, worded for them. */
export class JobFailure extends Error {}

export interface Probe {
  hasAudio: boolean
  durationMs: number | undefined
}

export async function probe (config: WorkerConfig, file: string, signal?: AbortSignal): Promise<Probe> {
  const res = await run(config.ffprobeBin, ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file], { signal, timeoutMs: 60_000 })
  if (res.code !== 0) throw new JobFailure('the file could not be read as audio or video')
  let data: { streams?: Array<{ codec_type?: string }>, format?: { duration?: string } }
  try { data = JSON.parse(res.stdout) } catch { throw new JobFailure('the file could not be read as audio or video') }
  const seconds = Number(data.format?.duration)
  return {
    hasAudio: (data.streams ?? []).some(s => s.codec_type === 'audio'),
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined
  }
}

/**
 * Cut the chosen range and convert it to what whisper.cpp wants: 16 kHz mono
 * 16-bit WAV. `-ss` before `-i` seeks fast; `-t` (a length) avoids the
 * input/output timestamp ambiguity of `-to` when seeking on the input.
 */
export async function cutAudio (config: WorkerConfig, input: string, output: string, startMs: number, endMs: number, signal?: AbortSignal): Promise<void> {
  const res = await run(config.ffmpegBin, [
    '-nostdin', '-y', '-v', 'error',
    '-ss', (startMs / 1000).toFixed(3), '-i', input, '-t', ((endMs - startMs) / 1000).toFixed(3),
    '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output
  ], { signal, timeoutMs: 30 * 60_000 })
  if (res.code !== 0) throw new Error(`ffmpeg failed: ${tail(res.stderr)}`)
}
