import type { Readable } from 'node:stream'
import { Config } from '../config'
import { LocalStorage } from './local-storage'
import { BucketStorage } from './bucket-storage'

export interface FileInfo {
  size: number
  contentType: string
}

/** An inclusive byte range, already checked against the file size. */
export interface ByteRange {
  start: number
  end: number
}

/**
 * Where uploads live (SPEC.md §7). Keys are `<id>/<filename>` and already
 * validated (keys.ts) before they get here.
 */
export interface FileStorage {
  /** Store a stream. Rejects (and stores nothing) if the stream errors. */
  put (key: string, body: Readable, contentType: string): Promise<void>
  head (key: string): Promise<FileInfo | undefined>
  /** Stream a file, or part of one. */
  get (key: string, range?: ByteRange): Promise<Readable>
  delete (key: string): Promise<void>
}

/**
 * A storage the browser and the worker can reach directly with signed links
 * (the bucket). Media summaries use it so a long upload doesn't go through
 * Railway's proxy, which cuts request bodies off after 5 minutes.
 */
export interface DirectStorage extends FileStorage {
  /** A signed PUT link; the uploader must send exactly this Content-Type. */
  presignPut (key: string, contentType: string, expiresInSeconds: number): Promise<string>
  presignGet (key: string, expiresInSeconds: number): Promise<string>
  /** Every key under a prefix. */
  list (prefix: string): Promise<string[]>
}

export function isDirectStorage (storage: FileStorage): storage is DirectStorage {
  return typeof (storage as Partial<DirectStorage>).presignPut === 'function'
}

export const FILE_STORAGE = Symbol('FILE_STORAGE')

export function createStorage (config: Config['files']): FileStorage {
  return config.driver === 's3' ? new BucketStorage(config) : new LocalStorage(config.dir)
}
