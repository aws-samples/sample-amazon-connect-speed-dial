import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CliError } from '../lib/errors.js'
import { outputBySuffix } from './shared.js'
import type { CdkOutputs } from './cdkDeploy.js'
import type { Clock, KnowledgeBases, ObjectStore } from '../core/ports.js'

// Populate the Bedrock knowledge base: upload the content, start an ingestion
// job, poll it to completion. The command returns what happened; renderSync()
// prints it.
//
// Directory upload re-uploads every non-hidden file rather than computing a
// delta. Harmless: ingestion is idempotent and the content is small. Files and
// directories whose name starts with '.' are skipped.

const POLL_INTERVAL_MS = 10_000
/** ~10 minutes. Small knowledge bases finish inside a minute. */
const MAX_POLLS = 60

export interface KbTarget {
  bucket: string
  knowledgeBaseId: string
  dataSourceId: string
}

export interface SyncKbPorts {
  storage: Pick<ObjectStore, 'upload'>
  knowledgeBases: Pick<KnowledgeBases, 'startIngestion' | 'getIngestion'>
  clock: Clock
}

export interface SyncKbReport {
  target: KbTarget
  uploaded: number
  jobId: string
  scanned: number
  indexed: number
  failed: number
}

/** The knowledge base a deployed project owns, from its cdk-outputs.json.
 *  `outputsPath` is only used to make the error actionable. */
export function kbTargetFrom(outputs: CdkOutputs, outputsPath: string): KbTarget {
  const bucket = outputBySuffix(outputs, 'Wisdom', 'KnowledgeBaseBucketName')
  const knowledgeBaseId = outputBySuffix(outputs, 'Wisdom', 'BedrockKnowledgeBaseId')
  const dataSourceId = outputBySuffix(outputs, 'Wisdom', 'BedrockDataSourceId')
  if (!bucket || !knowledgeBaseId || !dataSourceId) {
    throw new CliError(`knowledge-base outputs missing from ${outputsPath} `
      + '— was the project deployed with knowledgeBaseEnabled=true?')
  }
  return { bucket, knowledgeBaseId, dataSourceId }
}

/** Non-hidden files under `root`, as [localPath, s3Key] pairs, sorted stably. */
function walkContent(root: string, prefix = ''): Array<[string, string]> {
  const files: Array<[string, string]> = []
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    const local = join(root, e.name)
    const key = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) files.push(...walkContent(local, key))
    else if (e.isFile()) files.push([local, key])
  }
  return files
}

export async function syncKb(
  contentPath: string, target: KbTarget, aws: SyncKbPorts,
): Promise<SyncKbReport> {
  if (!existsSync(contentPath)) throw new CliError(`content path not found: ${contentPath}`)

  const files = statSync(contentPath).isDirectory()
    ? walkContent(contentPath)
    : [[contentPath, basename(contentPath)] as [string, string]]
  for (const [local, key] of files) await aws.storage.upload(local, target.bucket, key)

  const { knowledgeBaseId: kbId, dataSourceId: dsId } = target
  const jobId = await aws.knowledgeBases.startIngestion(kbId, dsId)

  let last = { status: 'STARTING' } as Awaited<ReturnType<KnowledgeBases['getIngestion']>>
  for (let i = 0; i < MAX_POLLS; i++) {
    last = await aws.knowledgeBases.getIngestion(kbId, dsId, jobId)
    if (last.status === 'COMPLETE' || last.status === 'FAILED' || last.status === 'STOPPED') break
    await aws.clock.sleep(POLL_INTERVAL_MS)
  }

  if (last.status !== 'COMPLETE') {
    // The reasons belong on the error, not on stdout — they explain the failure.
    const reasons = last.failureReasons?.length ? `\n  ${last.failureReasons.join('\n  ')}` : ''
    throw new CliError(`ingestion job ${jobId} did not complete (status: ${last.status})${reasons}`)
  }

  const s = last.statistics ?? {}
  return {
    target,
    uploaded: files.length,
    jobId,
    scanned: s.numberOfDocumentsScanned ?? 0,
    indexed: (s.numberOfNewDocumentsIndexed ?? 0) + (s.numberOfModifiedDocumentsIndexed ?? 0),
    failed: s.numberOfDocumentsFailed ?? 0,
  }
}

export function renderSync(r: SyncKbReport): string[] {
  const lines = [
    `Knowledge base ${r.target.knowledgeBaseId} populated `
      + `(data source ${r.target.dataSourceId}, bucket ${r.target.bucket})`,
    `Uploaded ${r.uploaded} file(s); job ${r.jobId} — `
      + `scanned: ${r.scanned}, indexed: ${r.indexed}, failed: ${r.failed}`,
  ]
  if (r.failed > 0) {
    lines.push('⚠ some documents failed to index — check supported formats/size limits')
  }
  lines.push('✓ Done. The AI agent can now retrieve this content on the next call.')
  return lines
}
