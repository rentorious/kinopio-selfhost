import os from 'node:os'
import path from 'node:path'

export interface WorkerConfig {
  /** The Railway app, e.g. https://kinopio.example.com */
  serverUrl: string
  token: string
  whisperBin: string
  whisperModel: string
  /** Used once when the main model gets stuck repeating itself. */
  whisperFallbackModel?: string
  /** Silero VAD model for whisper.cpp; skips silence, where most hallucinations happen. */
  vadModel?: string
  whisperThreads?: number
  ffmpegBin: string
  ffprobeBin: string
  claudeBin: string
  claudeModel?: string
  /** Extra arguments for `claude`, space-separated (e.g. to drop --restricted on an older CLI). */
  claudeArgs: string[]
  claudeRestricted: boolean
  claudeTimeoutMs: number
  claudeMaxTurns: number
  jobDir: string
  gpuName: string
  /** Keep job folders after a job (debugging). Off by default: the media must not stay around. */
  keepJobDirs: boolean
}

function env (vars: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = vars[name]
  if (value !== undefined && value !== '') return value
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required setting ${name}`)
}

export function loadConfig (vars: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const threads = vars.WHISPER_THREADS ? Number(vars.WHISPER_THREADS) : undefined
  return {
    serverUrl: env(vars, 'SERVER_URL').replace(/\/+$/, ''),
    token: env(vars, 'WORKER_TOKEN'),
    whisperBin: env(vars, 'WHISPER_BIN', 'whisper-cli'),
    whisperModel: env(vars, 'WHISPER_MODEL'),
    whisperFallbackModel: vars.WHISPER_FALLBACK_MODEL || undefined,
    vadModel: vars.VAD_MODEL || undefined,
    whisperThreads: threads && threads > 0 ? threads : undefined,
    ffmpegBin: env(vars, 'FFMPEG_BIN', 'ffmpeg'),
    ffprobeBin: env(vars, 'FFPROBE_BIN', 'ffprobe'),
    claudeBin: env(vars, 'CLAUDE_BIN', 'claude'),
    claudeModel: vars.CLAUDE_MODEL || undefined,
    claudeArgs: (vars.CLAUDE_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean),
    claudeRestricted: env(vars, 'CLAUDE_RESTRICTED', 'true') !== 'false',
    claudeTimeoutMs: Number(env(vars, 'CLAUDE_TIMEOUT_MS', String(15 * 60 * 1000))),
    claudeMaxTurns: Number(env(vars, 'CLAUDE_MAX_TURNS', '40')),
    jobDir: path.resolve(env(vars, 'JOB_DIR', path.join(os.homedir(), '.cache', 'kinopio-worker'))),
    gpuName: env(vars, 'WORKER_GPU_NAME', 'unknown GPU'),
    keepJobDirs: env(vars, 'KEEP_JOB_DIRS', 'false') === 'true'
  }
}
