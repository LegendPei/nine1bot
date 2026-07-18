export function createSessionEventReconciler<Event>(applyEvent: (event: Event) => void) {
  let nextGeneration = 0
  let current:
    | {
        id: number
        sessionID: string
        buffering: boolean
        events: Event[]
      }
    | undefined

  function begin(sessionID: string) {
    current = {
      id: ++nextGeneration,
      sessionID,
      buffering: true,
      events: [],
    }
    return current.id
  }

  function isCurrent(generation: number) {
    return current?.id === generation
  }

  function replay(generation: number) {
    if (!isCurrent(generation) || !current) return false
    const events = current.events.splice(0)
    events.forEach(applyEvent)
    return true
  }

  function buffer(generation: number, event: Event) {
    if (!isCurrent(generation) || !current) return false
    if (current.buffering) {
      current.events.push(event)
      return true
    }
    applyEvent(event)
    return false
  }

  function applySnapshot(generation: number, apply: () => void) {
    if (!isCurrent(generation)) return false
    apply()
    return replay(generation)
  }

  function finish(generation: number) {
    if (!isCurrent(generation) || !current) return false
    replay(generation)
    current.buffering = false
    return true
  }

  return {
    begin,
    buffer,
    applySnapshot,
    finish,
    isCurrent,
    sessionID() {
      return current?.sessionID
    },
  }
}

export interface SessionRecoveryDependencies<
  Message,
  Status extends { type: string },
  Question extends { sessionID: string },
  Permission extends { sessionID: string },
> {
  getMessages(sessionID: string): Promise<Message[]>
  getStatuses(): Promise<Record<string, Status>>
  getQuestions(): Promise<Question[]>
  getPermissions(): Promise<Permission[]>
}

export async function loadSessionRecoverySnapshot<
  Message,
  Status extends { type: string },
  Question extends { sessionID: string },
  Permission extends { sessionID: string },
>(
  sessionID: string,
  dependencies: SessionRecoveryDependencies<Message, Status, Question, Permission>,
) {
  const [messages, statuses, questions, permissions] = await Promise.all([
    dependencies.getMessages(sessionID),
    dependencies.getStatuses(),
    dependencies.getQuestions(),
    dependencies.getPermissions(),
  ])

  return {
    messages,
    status: statuses[sessionID] ?? { type: 'idle' as const },
    questions: questions.filter((question) => question.sessionID === sessionID),
    permissions: permissions.filter((permission) => permission.sessionID === sessionID),
  }
}
