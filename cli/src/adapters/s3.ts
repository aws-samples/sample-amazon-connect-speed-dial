import { createReadStream, statSync } from 'node:fs'
import {
  S3Client,
  PutObjectCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3'
import type { ObjectStore } from '../core/ports.js'

export function s3ObjectStore(region: string): ObjectStore {
  const s3 = new S3Client({ region })
  return {
    async upload(localPath, bucket, key) {
      // ContentLength is required alongside a stream body: without it the SDK
      // cannot sign the request.
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentLength: statSync(localPath).size,
      }))
    },
    async listBuckets() {
      const r = await s3.send(new ListBucketsCommand({}))
      return (r.Buckets ?? []).map((b) => b.Name ?? '').filter(Boolean)
    },
    async listVersions(bucket) {
      const r = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }))
      // Versions first, then delete markers.
      return [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])]
        .filter((o) => o.Key)
        .map((o) => ({ key: o.Key as string, versionId: o.VersionId }))
    },
    async deleteObjects(bucket, objects) {
      const r = await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: objects.map((o) => ({ Key: o.key, VersionId: o.versionId })),
          Quiet: true,
        },
      }))
      // DeleteObjects returns HTTP 200 with a populated Errors array for
      // per-object failures (a missing s3:DeleteObjectVersion, an object lock) —
      // it does NOT throw. Discarding that made the caller's
      // re-list-until-empty loop spin forever on such a bucket.
      if (r.Errors?.length) {
        const first = r.Errors[0]!
        throw new Error(
          `${r.Errors.length} object(s) could not be deleted from ${bucket} `
          + `(${first.Code ?? 'unknown'}: ${first.Message ?? 'no message'})`)
      }
    },
    async deleteBucket(bucket) {
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }))
    },
  }
}
