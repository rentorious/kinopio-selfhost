#!/usr/bin/env node
// Let the browser upload media straight to the bucket (docs/MEDIA-SUMMARIES.md §6).
// Sets one CORS rule: PUT from the app's own origin. Run once per bucket, with the
// app service's variables:
//
//   railway run --service <app> -- node tools/bucket-cors.mjs https://<your-app>.up.railway.app
import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3'

const origin = process.argv[2]
if (!/^https?:\/\/[^/]+$/.test(origin ?? '')) {
  console.error('usage: node tools/bucket-cors.mjs https://<your-app-origin>')
  process.exit(1)
}
const s3 = new S3Client({
  endpoint: process.env.ENDPOINT,
  region: process.env.REGION ?? 'auto',
  forcePathStyle: process.env.BUCKET_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: process.env.ACCESS_KEY_ID, secretAccessKey: process.env.SECRET_ACCESS_KEY }
})
await s3.send(new PutBucketCorsCommand({
  Bucket: process.env.BUCKET,
  CORSConfiguration: {
    CORSRules: [{ AllowedOrigins: [origin], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }]
  }
}))
const { CORSRules } = await s3.send(new GetBucketCorsCommand({ Bucket: process.env.BUCKET }))
console.log('bucket CORS:', JSON.stringify(CORSRules))
