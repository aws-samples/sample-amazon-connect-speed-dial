import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mockClient } from 'aws-sdk-client-mock'
import {
  S3Client,
  PutObjectCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3'
import { s3ObjectStore } from '../../src/adapters/s3.js'

const s3 = mockClient(S3Client)
beforeEach(() => { s3.reset() })

const store = () => s3ObjectStore('us-east-1')

describe('upload', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'csp-s3-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('sends ContentLength alongside the stream body', async () => {
    // A stream body without a length cannot be signed, so the upload fails at
    // request time rather than anywhere useful.
    const file = join(tmp, 'doc.txt')
    writeFileSync(file, 'hello world')
    s3.on(PutObjectCommand).resolves({})
    await store().upload(file, 'kb-bucket', 'nested/doc.txt')
    const input = s3.commandCalls(PutObjectCommand)[0]!.args[0]!.input
    expect(input.Bucket).toBe('kb-bucket')
    expect(input.Key).toBe('nested/doc.txt')
    expect(input.ContentLength).toBe(11)
    expect(input.Body).toBeDefined()
    // The mocked send() never consumes the body, so the stream would open the
    // file lazily AFTER this test deletes the tmpdir. Close it here.
    const body = input.Body as Readable
    body.on('error', () => {})
    body.destroy()
  })
})

describe('listBuckets', () => {
  it('returns names and drops unnamed entries', async () => {
    s3.on(ListBucketsCommand).resolves({ Buckets: [{ Name: 'a' }, {}, { Name: 'b' }] })
    expect(await store().listBuckets()).toEqual(['a', 'b'])
  })
})

describe('listVersions', () => {
  it('returns versions BEFORE delete markers', async () => {
    // Order matters: the caller deletes in batches of 1000 and re-lists, and a
    // bucket empties only when both kinds are gone.
    s3.on(ListObjectVersionsCommand).resolves({
      Versions: [{ Key: 'a', VersionId: 'v1' }],
      DeleteMarkers: [{ Key: 'b', VersionId: 'd1' }],
    })
    expect(await store().listVersions('bkt')).toEqual([
      { key: 'a', versionId: 'v1' },
      { key: 'b', versionId: 'd1' },
    ])
  })

  it('drops entries with no key', async () => {
    s3.on(ListObjectVersionsCommand).resolves({ Versions: [{ VersionId: 'v1' }] })
    expect(await store().listVersions('bkt')).toEqual([])
  })
})

describe('deleteObjects', () => {
  it('requests Quiet mode with the key/version pairs', async () => {
    s3.on(DeleteObjectsCommand).resolves({})
    await store().deleteObjects('bkt', [{ key: 'a', versionId: 'v1' }, { key: 'b' }])
    expect(s3.commandCalls(DeleteObjectsCommand)[0]!.args[0]!.input.Delete).toEqual({
      Objects: [{ Key: 'a', VersionId: 'v1' }, { Key: 'b', VersionId: undefined }],
      Quiet: true,
    })
  })

  it('THROWS on the per-object Errors array, which arrives with HTTP 200', async () => {
    // DeleteObjects does not reject for per-object failures. Discarding them made
    // the caller's re-list-until-empty loop spin forever on a locked object.
    s3.on(DeleteObjectsCommand).resolves({
      Errors: [{ Key: 'a', Code: 'AccessDenied', Message: 'no DeleteObjectVersion' }],
    })
    await expect(store().deleteObjects('bkt', [{ key: 'a' }]))
      .rejects.toThrow(/1 object\(s\) could not be deleted from bkt \(AccessDenied/)
  })

  it('does not throw when Errors is absent or empty', async () => {
    s3.on(DeleteObjectsCommand).resolves({ Errors: [] })
    await expect(store().deleteObjects('bkt', [{ key: 'a' }])).resolves.toBeUndefined()
  })
})

describe('deleteBucket', () => {
  it('deletes by name', async () => {
    s3.on(DeleteBucketCommand).resolves({})
    await store().deleteBucket('bkt')
    expect(s3.commandCalls(DeleteBucketCommand)[0]!.args[0]!.input).toEqual({ Bucket: 'bkt' })
  })
})
