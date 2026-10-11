import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { JobOffer, MediaResult, WorkerMessage } from '../../src/media/contract'
import type { WorkerConfig } from './config'
import { cutAudio, JobFailure, probe } from './media'
import { summarize } from './summarize'
import { hasRepetitionLoop, transcribe } from './whisper'

export interface JobDeps {
  config: WorkerConfig
  send: (msg: WorkerMessage) => void
  log: (msg: string) => void
  signal: AbortSignal
}

function headers (config: WorkerConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.token}` }
}

async function download (config: WorkerConfig, mediaPath: string, file: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(`${config.serverUrl}${mediaPath}`, { headers: headers(config), signal })
  if (!res.ok || !res.body) throw new Error(`download failed with ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(file), { signal })
}

async function postResult (config: WorkerConfig, resultPath: string, result: MediaResult, signal: AbortSignal): Promise<void> {
  const res = await fetch(`${config.serverUrl}${resultPath}`, {
    method: 'POST',
    headers: { ...headers(config), 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
    signal
  })
  if (!res.ok) throw new Error(`the server refused the result (${res.status}): ${(await res.text()).slice(0, 500)}`)
}

/**
 * One job, start to finish (docs/MEDIA-SUMMARIES.md §7): download, cut,
 * transcribe, summarize, post. The job folder (and with it the media) is
 * always deleted at the end.
 */
export async function runJob (offer: JobOffer, deps: JobDeps): Promise<void> {
  const { config, send, log, signal } = deps
  const dir = path.join(config.jobDir, offer.jobId)
  await fs.promises.rm(dir, { recursive: true, force: true })
  await fs.promises.mkdir(dir, { recursive: true })
  try {
    const media = path.join(dir, 'media')
    await download(config, offer.mediaPath, media, signal)
    send({ type: 'downloaded', jobId: offer.jobId })
    log(`downloaded ${offer.fileName} (${offer.bytes} bytes)`)

    const info = await probe(config, media, signal)
    if (!info.hasAudio) throw new JobFailure('the file has no audio')
    // The file may be only the selected part (docs/AUDIO-PREP.md): its 0 sits
    // at fileOffsetMs in the original. startMs/endMs are in the original.
    const offset = offer.fileOffsetMs ?? 0
    const fileEndMs = info.durationMs ? offset + info.durationMs : undefined
    const endMs = fileEndMs ? Math.min(offer.endMs, fileEndMs) : offer.endMs
    if (endMs <= offer.startMs) throw new JobFailure('the selected start is past the end of the file')

    const wav = path.join(dir, 'audio.wav')
    await cutAudio(config, media, wav, offer.startMs - offset, endMs - offset, signal)
    await fs.promises.rm(media, { force: true })

    let lastPercent = -1
    let lastSent = 0
    const progress = (percent: number) => {
      const now = Date.now()
      if (percent === lastPercent || (percent - lastPercent < 5 && now - lastSent < 10_000)) return
      lastPercent = percent
      lastSent = now
      send({ type: 'progress', jobId: offer.jobId, stage: 'transcribing', percent })
    }
    progress(0)
    let transcript = await transcribe(config, wav, dir, offer.language, config.whisperModel, progress, signal)
    if (hasRepetitionLoop(transcript.segments) && config.whisperFallbackModel) {
      log('whisper got stuck repeating itself; trying the fallback model')
      lastPercent = -1
      transcript = await transcribe(config, wav, dir, offer.language, config.whisperFallbackModel, progress, signal)
    }
    await fs.promises.rm(wav, { force: true })
    const segments = transcript.segments.map(s => ({ ...s, startMs: s.startMs + offer.startMs, endMs: s.endMs + offer.startMs }))
    if (segments.length === 0) throw new JobFailure('no speech found in the selected part')
    log(`transcribed ${segments.length} segments with ${transcript.model} (${transcript.language})`)

    send({ type: 'progress', jobId: offer.jobId, stage: 'summarizing' })
    const result = await summarize(config, dir, {
      fileName: offer.fileName,
      startMs: offer.startMs,
      endMs,
      durationMs: fileEndMs,
      language: offer.language,
      topic: offer.topic,
      segments,
      transcriber: { model: transcript.model, language: transcript.language }
    }, { signal, log })
    await postResult(config, offer.resultPath, result, signal)
    log(`done: "${result.title}", ${result.sections.length} sections${result.summaryFailed ? ' (summary failed)' : ''}`)
  } catch (err) {
    if (signal.aborted) { log('canceled'); return }
    const reason = err instanceof JobFailure ? err.message : 'transcription failed on the PC'
    if (!(err instanceof JobFailure)) log(`failed: ${err instanceof Error ? err.stack : String(err)}`)
    send({ type: 'failed', jobId: offer.jobId, reason })
  } finally {
    if (!config.keepJobDirs) await fs.promises.rm(dir, { recursive: true, force: true })
  }
}
