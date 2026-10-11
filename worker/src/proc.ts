import { spawn } from 'node:child_process'

export interface RunOptions {
  cwd?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Called for each complete line on stderr (whisper prints progress there). */
  onStderrLine?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export class ProcessError extends Error {
  constructor (message: string, readonly result?: RunResult) { super(message) }
}

const MAX_CAPTURE = 2 * 1024 * 1024

/**
 * Run a program without a shell. Rejects when it can't start, times out or is
 * aborted (the child is killed: SIGTERM, then SIGKILL after 5 s). A non-zero
 * exit code resolves; callers decide what it means.
 */
export function run (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new ProcessError('aborted'))
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let lineBuf = ''
    let failure: ProcessError | undefined
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_CAPTURE) stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      if (stderr.length < MAX_CAPTURE) stderr += text
      if (!opts.onStderrLine) return
      lineBuf += text
      const lines = lineBuf.split(/\r?\n|\r/)
      lineBuf = lines.pop() ?? ''
      for (const line of lines) opts.onStderrLine(line)
    })
    const kill = (reason: string) => {
      failure ??= new ProcessError(reason)
      child.kill('SIGTERM')
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5000).unref()
    }
    const timer = opts.timeoutMs ? setTimeout(() => kill(`${cmd} timed out`), opts.timeoutMs) : undefined
    const onAbort = () => kill('aborted')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', err => { failure ??= new ProcessError(`could not start ${cmd}: ${err.message}`) })
    child.on('close', code => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (lineBuf && opts.onStderrLine) opts.onStderrLine(lineBuf)
      const result = { code, stdout, stderr }
      if (failure) { failure = Object.assign(failure, { result }); reject(failure) } else resolve(result)
    })
  })
}

/** The last few lines of a program's error output, for logs. */
export function tail (text: string, lines = 5): string {
  return text.trim().split('\n').slice(-lines).join('\n')
}
