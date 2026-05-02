export type ReviewRunStatus = 'accepted' | 'rejected' | 'blocked' | 'running' | 'succeeded' | 'failed'

export type ReviewRunRecord = {
  id: string
  platform: 'gitlab'
  idempotencyKey?: string
  status: ReviewRunStatus
  createdAt: number
  updatedAt: number
  error?: string
  trigger?: Record<string, unknown>
  sessionId?: string
  turnSnapshotId?: string
  warnings?: string[]
}

export type CreateReviewRunInput = Omit<ReviewRunRecord, 'id' | 'createdAt' | 'updatedAt'>

const runs = new Map<string, ReviewRunRecord>()
let sequence = 0

export namespace ReviewRunStore {
  export function create(input: CreateReviewRunInput): ReviewRunRecord {
    const now = Date.now()
    const run = {
      ...input,
      id: `review_${now.toString(36)}_${(++sequence).toString(36)}`,
      createdAt: now,
      updatedAt: now,
    } satisfies ReviewRunRecord
    runs.set(run.id, run)
    return { ...run }
  }

  export function findByIdempotencyKey(idempotencyKey: string): ReviewRunRecord | undefined {
    for (const run of runs.values()) {
      if (run.idempotencyKey === idempotencyKey) return { ...run }
    }
    return undefined
  }

  export function update(id: string, patch: Partial<Omit<ReviewRunRecord, 'id' | 'createdAt'>>): ReviewRunRecord | undefined {
    const existing = runs.get(id)
    if (!existing) return undefined
    const next = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    }
    runs.set(id, next)
    return { ...next }
  }

  export function list(): ReviewRunRecord[] {
    return [...runs.values()].map((run) => ({ ...run }))
  }

  export function clearForTesting() {
    runs.clear()
    sequence = 0
  }
}
