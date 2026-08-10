import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { getDataDir } from '../config/loader'
import type { GitLabCiPipeline, GitLabReviewProjectSnapshot } from '@nine1bot/platform-gitlab/review'

export type ReviewRunStatus = 'accepted' | 'rejected' | 'blocked' | 'running' | 'succeeded' | 'failed'

export type ReviewRunCiSummary = {
  pipeline?: GitLabCiPipeline
  diagnostics: string[]
  observedAt?: number
  queryCount?: number
  jobLogReadCount?: number
  queriedJobIds?: number[]
}

export type ReviewRunRecord = {
  id: string
  rootRunId: string
  attempt: number
  retryOf?: string
  triggerKey: string
  generation: string
  platform: 'gitlab'
  idempotencyKey?: string
  status: ReviewRunStatus
  createdAt: number
  updatedAt: number
  error?: string
  trigger?: Record<string, unknown>
  project?: GitLabReviewProjectSnapshot
  ci?: ReviewRunCiSummary
  sessionId?: string
  turnSnapshotId?: string
  publishedAt?: number
  failureNotifiedAt?: number
  retryCount?: number
  lastRetryAt?: number
  warnings?: string[]
  context?: unknown
  rejectionKind?: string
  recoverable?: boolean
}

export type CreateReviewRunInput = Omit<
  ReviewRunRecord,
  'id' | 'rootRunId' | 'attempt' | 'retryOf' | 'triggerKey' | 'generation' | 'createdAt' | 'updatedAt'
> & {
  triggerKey?: string
}

export type ReviewRunIdentity = {
  runId: string
  sessionId?: string
  generation: string
}

type ReviewRunStoreFile = {
  version: 2
  sequence: number
  runs: ReviewRunRecord[]
}

const runs = new Map<string, ReviewRunRecord>()
let sequence = 0
let loaded = false
let storePathOverride: string | undefined
let maxRecordsOverride: number | undefined

function defaultStorePath() {
  return process.env.NINE1BOT_REVIEW_RUN_STORE_PATH || join(getDataDir(), 'review-runs.json')
}

function storePath() {
  return storePathOverride || defaultStorePath()
}

function maxRecords() {
  if (maxRecordsOverride !== undefined) return maxRecordsOverride
  const configured = Number(process.env.NINE1BOT_REVIEW_RUN_STORE_LIMIT)
  return Number.isFinite(configured) && configured > 0 ? configured : 100
}

export namespace ReviewRunStore {
  export function create(input: CreateReviewRunInput): ReviewRunRecord {
    load()
    const run = createRecord(input)
    runs.set(run.id, run)
    save()
    return { ...run }
  }

  export function findByIdempotencyKey(idempotencyKey: string): ReviewRunRecord | undefined {
    load()
    const matches = [...runs.values()].filter((run) => run.idempotencyKey === idempotencyKey)
    const latest = matches.sort(compareLatestAttemptFirst)[0]
    return latest ? { ...latest } : undefined
  }

  export function findLatestByTriggerKey(triggerKey: string): ReviewRunRecord | undefined {
    load()
    const latest = findLatestByTriggerKeyInternal(triggerKey)
    return latest ? { ...latest } : undefined
  }

  export function findBySessionId(sessionId: string): ReviewRunRecord | undefined {
    load()
    const matches = [...runs.values()].filter((run) => run.sessionId === sessionId)
    return matches.length === 1 ? { ...matches[0] } : undefined
  }

  export function get(id: string): ReviewRunRecord | undefined {
    load()
    const run = runs.get(id)
    return run ? { ...run } : undefined
  }

  export function update(id: string, patch: Partial<Omit<ReviewRunRecord, 'id' | 'createdAt'>>): ReviewRunRecord | undefined {
    load()
    const existing = runs.get(id)
    if (!existing) return undefined
    const next = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    }
    runs.set(id, next)
    save()
    return { ...next }
  }

  export function updateIfCurrent(
    identity: ReviewRunIdentity,
    patch: Partial<Omit<ReviewRunRecord, 'id' | 'rootRunId' | 'attempt' | 'retryOf' | 'triggerKey' | 'generation' | 'createdAt'>>,
  ): boolean {
    load()
    const existing = runs.get(identity.runId)
    if (!existing) return false
    if (existing.generation !== identity.generation || existing.sessionId !== identity.sessionId) return false
    if (findLatestByTriggerKeyInternal(existing.triggerKey)?.id !== existing.id) return false
    runs.set(existing.id, {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    })
    save()
    return true
  }

  export function createRetryAttempt(
    previous: ReviewRunRecord,
    input: CreateReviewRunInput,
  ): ReviewRunRecord | undefined {
    load()
    const existing = runs.get(previous.id)
    if (!existing || existing.generation !== previous.generation) return undefined
    if (findLatestByTriggerKeyInternal(existing.triggerKey)?.id !== existing.id) return undefined

    const run = createRecord({
      ...input,
      triggerKey: existing.triggerKey,
    }, {
      rootRunId: existing.rootRunId,
      attempt: existing.attempt + 1,
      retryOf: existing.id,
    })
    runs.set(run.id, run)
    save()
    return { ...run }
  }

  export function list(options: { limit?: number } = {}): ReviewRunRecord[] {
    load()
    const sorted = [...runs.values()].sort(compareNewestFirst)
    const limit = options.limit && Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : undefined
    return (limit ? sorted.slice(0, limit) : sorted).map((run) => ({ ...run }))
  }

  export function clearForTesting() {
    runs.clear()
    sequence = 0
    loaded = true
    if (storePathOverride && existsSync(storePathOverride)) {
      rmSync(storePathOverride, { force: true })
    }
  }

  export function setPathForTesting(filepath: string) {
    storePathOverride = filepath
    runs.clear()
    sequence = 0
    loaded = false
  }

  export function setMaxRecordsForTesting(limit: number | undefined) {
    maxRecordsOverride = limit
  }

  export function reloadForTesting() {
    runs.clear()
    sequence = 0
    loaded = false
  }
}

function createRecord(
  input: CreateReviewRunInput,
  lineage?: { rootRunId: string; attempt: number; retryOf: string },
): ReviewRunRecord {
  const now = Date.now()
  const id = `review_${now.toString(36)}_${(++sequence).toString(36)}`
  return {
    ...input,
    id,
    rootRunId: lineage?.rootRunId ?? id,
    attempt: lineage?.attempt ?? 1,
    retryOf: lineage?.retryOf,
    triggerKey: input.triggerKey || input.idempotencyKey || id,
    generation: randomUUID(),
    createdAt: now,
    updatedAt: now,
  }
}

function findLatestByTriggerKeyInternal(triggerKey: string) {
  return [...runs.values()]
    .filter((run) => run.triggerKey === triggerKey)
    .sort(compareLatestAttemptFirst)[0]
}

function load() {
  if (loaded) return
  loaded = true
  const filepath = storePath()
  if (!existsSync(filepath)) return
  try {
    const parsed = JSON.parse(readFileSync(filepath, 'utf-8')) as Partial<ReviewRunStoreFile>
    const records = Array.isArray(parsed.runs)
      ? parsed.runs.filter(isStoredReviewRunRecord).map(normalizeStoredReviewRun)
      : []
    runs.clear()
    for (const run of records) {
      runs.set(run.id, { ...run })
    }
    sequence = typeof parsed.sequence === 'number' && Number.isFinite(parsed.sequence)
      ? parsed.sequence
      : inferSequence(records)
  } catch {
    runs.clear()
    sequence = 0
  }
}

function save() {
  const filepath = storePath()
  mkdirSync(dirname(filepath), { recursive: true })
  prune()
  const data: ReviewRunStoreFile = {
    version: 2,
    sequence,
    runs: [...runs.values()],
  }
  const tempPath = `${filepath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tempPath, filepath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

function prune() {
  const limit = maxRecords()
  if (runs.size <= limit) return
  const keep = new Set(
    [...runs.values()]
      .sort(compareNewestFirst)
      .slice(0, limit)
      .map((run) => run.id),
  )
  for (const id of runs.keys()) {
    if (!keep.has(id)) runs.delete(id)
  }
}

function inferSequence(records: ReviewRunRecord[]) {
  return records.length
}

function compareNewestFirst(a: ReviewRunRecord, b: ReviewRunRecord) {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id)
}

function compareLatestAttemptFirst(a: ReviewRunRecord, b: ReviewRunRecord) {
  return b.attempt - a.attempt || compareNewestFirst(a, b)
}

function normalizeStoredReviewRun(input: Record<string, unknown>): ReviewRunRecord {
  const id = input.id as string
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined
  return {
    ...input,
    id,
    platform: 'gitlab',
    status: input.status as ReviewRunStatus,
    createdAt: input.createdAt as number,
    updatedAt: input.updatedAt as number,
    rootRunId: typeof input.rootRunId === 'string' && input.rootRunId ? input.rootRunId : id,
    attempt: typeof input.attempt === 'number' && Number.isInteger(input.attempt) && input.attempt > 0
      ? input.attempt
      : 1,
    triggerKey: typeof input.triggerKey === 'string' && input.triggerKey
      ? input.triggerKey
      : idempotencyKey || id,
    generation: typeof input.generation === 'string' && input.generation
      ? input.generation
      : `legacy-${id}`,
  } as ReviewRunRecord
}

function isStoredReviewRunRecord(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  return typeof record.id === 'string'
    && record.platform === 'gitlab'
    && typeof record.status === 'string'
    && typeof record.createdAt === 'number'
    && typeof record.updatedAt === 'number'
}
