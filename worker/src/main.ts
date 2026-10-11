import fs from 'node:fs'
import { loadConfig } from './config'
import { Worker } from './connection'

/**
 * The kinopio-selfhost transcription worker. Runs on the home PC as a
 * systemd user service; settings come from the environment
 * (worker/README.md).
 */
async function main (): Promise<void> {
  const config = loadConfig()
  for (const [name, file] of [['WHISPER_MODEL', config.whisperModel], ['WHISPER_FALLBACK_MODEL', config.whisperFallbackModel], ['VAD_MODEL', config.vadModel]] as const) {
    if (file && !fs.existsSync(file)) throw new Error(`${name} points at a file that doesn't exist: ${file}`)
  }
  // a crash mid-job can leave a job folder behind; the media must not stay
  await fs.promises.rm(config.jobDir, { recursive: true, force: true })
  await fs.promises.mkdir(config.jobDir, { recursive: true })

  const worker = new Worker(config)
  worker.start()
  const shutdown = async () => {
    console.log('[worker] stopping')
    await worker.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
}

main().catch(err => {
  console.error(`[worker] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
