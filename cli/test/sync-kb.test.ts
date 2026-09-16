import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  syncKb, renderSync, kbTargetFrom,
  type KbTarget, type SyncKbPorts,
} from '../src/commands/syncKb.js'
import { CliError } from '../src/lib/errors.js'

// Region precedence and readOutputs are covered by shared.test.ts;
// this file is about the sync itself.

const TARGET: KbTarget = {
  bucket: 'kb-bucket', knowledgeBaseId: 'kb-1', dataSourceId: 'ds-1',
}

interface Fakes {
  uploads: Array<{ localPath: string; bucket: string; key: string }>
  waits: number[]
}

function ports(over: Partial<SyncKbPorts> = {}): SyncKbPorts & Fakes {
  const uploads: Fakes['uploads'] = []
  const waits: number[] = []
  return {
    uploads,
    waits,
    storage: { async upload(localPath, bucket, key) { uploads.push({ localPath, bucket, key }) } },
    knowledgeBases: {
      async startIngestion() { return 'job-1' },
      async getIngestion() { return { status: 'COMPLETE' } },
    },
    clock: { async sleep(ms) { waits.push(ms) } },
    ...over,
  }
}

let contentDir: string
beforeEach(() => { contentDir = mkdtempSync(join(tmpdir(), 'csp-synckb-')) })
afterEach(() => { rmSync(contentDir, { recursive: true, force: true }) })

describe('kbTargetFrom', () => {
  const path = '/p/cdk-outputs.json'

  it('reads the three Wisdom outputs', () => {
    expect(kbTargetFrom({
      'proj-Wisdom': {
        KnowledgeBaseBucketName: 'kb-bucket',
        BedrockKnowledgeBaseId: 'kb-1',
        BedrockDataSourceId: 'ds-1',
      },
    }, path)).toEqual(TARGET)
  })

  it('fails verbatim when any one of the three is absent', () => {
    expect(() => kbTargetFrom({ 'proj-Wisdom': { AssistantId: 'a-1' } }, path))
      .toThrow(new CliError(
        `knowledge-base outputs missing from ${path} — was the project deployed with knowledgeBaseEnabled=true?`))
    expect(() => kbTargetFrom({
      'proj-Wisdom': { KnowledgeBaseBucketName: 'kb-bucket', BedrockKnowledgeBaseId: 'kb-1' },
    }, path)).toThrow(/knowledge-base outputs missing/)
  })
})

describe('syncKb upload', () => {
  it('uploads every non-hidden file, keyed relative to the content root', async () => {
    writeFileSync(join(contentDir, 'a.txt'), 'a')
    mkdirSync(join(contentDir, 'nested', 'deep'), { recursive: true })
    writeFileSync(join(contentDir, 'nested', 'b.md'), 'b')
    writeFileSync(join(contentDir, 'nested', 'deep', 'c.pdf'), 'c')
    writeFileSync(join(contentDir, '.hidden'), 'x')
    mkdirSync(join(contentDir, '.git'))
    writeFileSync(join(contentDir, '.git', 'config'), 'x')
    writeFileSync(join(contentDir, 'nested', '.hidden'), 'x')

    const p = ports()
    const r = await syncKb(contentDir, TARGET, p)
    expect(p.uploads.map((u) => u.key).sort())
      .toEqual(['a.txt', 'nested/b.md', 'nested/deep/c.pdf'])
    expect(p.uploads.every((u) => u.bucket === 'kb-bucket')).toBe(true)
    expect(p.uploads.find((u) => u.key === 'nested/b.md')?.localPath)
      .toBe(join(contentDir, 'nested', 'b.md'))
    expect(r.uploaded).toBe(3)
  })

  it('uploads a single file under its basename', async () => {
    const file = join(contentDir, 'policy.pdf')
    writeFileSync(file, 'pdf')
    const p = ports()
    await syncKb(file, TARGET, p)
    expect(p.uploads).toEqual([{ localPath: file, bucket: 'kb-bucket', key: 'policy.pdf' }])
  })

  it('fails verbatim when the content path does not exist', async () => {
    const missing = join(contentDir, 'nope')
    await expect(syncKb(missing, TARGET, ports()))
      .rejects.toThrow(new CliError(`content path not found: ${missing}`))
  })
})

describe('syncKb ingestion polling', () => {
  it('polls until COMPLETE, waiting 10s between polls and not after the last', async () => {
    const statuses = ['STARTING', 'IN_PROGRESS', 'IN_PROGRESS', 'COMPLETE']
    let polls = 0
    const p = ports({
      knowledgeBases: {
        async startIngestion() { return 'job-1' },
        async getIngestion() { return { status: statuses[polls++]! } },
      },
    })
    const r = await syncKb(contentDir, TARGET, p)
    expect(polls).toBe(4)
    expect(p.waits).toEqual([10_000, 10_000, 10_000])
    expect(r.jobId).toBe('job-1')
  })

  it('fails with the status and the reasons the job reported', async () => {
    const p = ports({
      knowledgeBases: {
        async startIngestion() { return 'job-1' },
        async getIngestion() {
          return { status: 'FAILED', failureReasons: ['bad format', 'too large'] }
        },
      },
    })
    await expect(syncKb(contentDir, TARGET, p)).rejects.toThrow(
      /ingestion job job-1 did not complete \(status: FAILED\)[\s\S]*bad format[\s\S]*too large/)
  })

  it('fails on STOPPED with no reasons to report', async () => {
    const p = ports({
      knowledgeBases: {
        async startIngestion() { return 'job-1' },
        async getIngestion() { return { status: 'STOPPED' } },
      },
    })
    await expect(syncKb(contentDir, TARGET, p))
      .rejects.toThrow(new CliError('ingestion job job-1 did not complete (status: STOPPED)'))
  })

  it('gives up after 60 polls when the job never terminates', async () => {
    let polls = 0
    const p = ports({
      knowledgeBases: {
        async startIngestion() { return 'job-1' },
        async getIngestion() { polls += 1; return { status: 'IN_PROGRESS' } },
      },
    })
    await expect(syncKb(contentDir, TARGET, p))
      .rejects.toThrow(/did not complete \(status: IN_PROGRESS\)/)
    expect(polls).toBe(60)
  })
})

describe('syncKb statistics', () => {
  const withStats = (statistics: Record<string, number>): Partial<SyncKbPorts> => ({
    knowledgeBases: {
      async startIngestion() { return 'job-1' },
      async getIngestion() { return { status: 'COMPLETE', statistics } },
    },
  })

  it('counts indexed as new + modified', async () => {
    const r = await syncKb(contentDir, TARGET, ports(withStats({
      numberOfDocumentsScanned: 5,
      numberOfNewDocumentsIndexed: 3,
      numberOfModifiedDocumentsIndexed: 1,
      numberOfDocumentsFailed: 0,
    })))
    expect(r).toMatchObject({ scanned: 5, indexed: 4, failed: 0 })
  })

  it('defaults every counter to 0 when statistics are absent', async () => {
    const r = await syncKb(contentDir, TARGET, ports())
    expect(r).toMatchObject({ scanned: 0, indexed: 0, failed: 0 })
  })
})

describe('renderSync', () => {
  const report = {
    target: TARGET, uploaded: 3, jobId: 'job-1', scanned: 5, indexed: 4, failed: 0,
  }

  it('reports the counts and the knowledge base it filled', () => {
    const text = renderSync(report).join('\n')
    expect(text).toContain('kb-1')
    expect(text).toContain('scanned: 5')
    expect(text).toContain('indexed: 4')
  })

  it('warns when documents failed to index', () => {
    const text = renderSync({ ...report, failed: 2 }).join('\n')
    expect(text).toContain('failed to index')
  })

  it('does not warn when nothing failed', () => {
    expect(renderSync(report).join('\n')).not.toContain('failed to index')
  })
})
