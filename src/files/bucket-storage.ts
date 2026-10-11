import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { Readable } from 'node:stream'
import type { BucketFilesConfig } from '../config'
import type { ByteRange, FileInfo, FileStorage } from './storage'

/**
 * An S3-compatible bucket (Railway Storage Buckets). Private: files are only
 * reachable through GET /files/*, which streams them (SPEC.md §7).
 */
export class BucketStorage implements FileStorage {
  private readonly s3: S3Client
  private readonly bucket: string

  constructor (config: BucketFilesConfig) {
    this.bucket = config.bucket
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
    })
  }

  async put (key: string, body: Readable, contentType: string): Promise<void> {
    // Multipart upload, so the size doesn't have to be known up front.
    // A stream error aborts the multipart upload: nothing is left behind.
    await new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }
    }).done()
  }

  async head (key: string): Promise<FileInfo | undefined> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? 'application/octet-stream' }
    } catch (err) {
      if (err instanceof S3ServiceException && (err.$metadata.httpStatusCode === 404 || err.name === 'NotFound')) return undefined
      throw err
    }
  }

  async get (key: string, range?: ByteRange): Promise<Readable> {
    const res = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Range: range ? `bytes=${range.start}-${range.end}` : undefined
    }))
    return res.Body as Readable
  }

  async delete (key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
}
