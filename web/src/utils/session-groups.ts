import type { Session } from '../api/client'

type Project = { id: string; name?: string; worktree: string; rootDirectory?: string }
type RecentSession = Session & { projectDisplayName?: string; projectDisplayPath?: string }
export interface SessionGroup { id: string; name: string; directory: string; projectId?: string; sessions: RecentSession[] }
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '')

export function groupSessionsByProject(sessions: RecentSession[], projects: Project[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const project of projects) {
    const directory = project.rootDirectory || project.worktree
    groups.set(project.id, { id: project.id, projectId: project.id, name: project.name || normalize(directory).split('/').pop() || '项目', directory, sessions: [] })
  }
  const byPath = [...projects].sort((a, b) => (b.rootDirectory || b.worktree).length - (a.rootDirectory || a.worktree).length)
  for (const session of sessions) {
    const directory = normalize(session.directory || '')
    const project = projects.find(project => project.id === session.projectID) || byPath.find(project => {
      const root = normalize(project.rootDirectory || project.worktree)
      return root && (root === directory || directory.startsWith(`${root}/`))
    })
    const id = project?.id || session.projectID || `directory:${directory || '.'}`
    if (!groups.has(id)) groups.set(id, { id, directory: session.projectDisplayPath || session.directory, name: session.projectDisplayName || directory.split('/').pop() || '其他会话', sessions: [] })
    groups.get(id)!.sessions.push(session)
  }
  return [...groups.values()].map(group => ({ ...group, sessions: group.sessions.sort((a, b) => b.time.updated - a.time.updated) }))
    .sort((a, b) => (b.sessions[0]?.time.updated || 0) - (a.sessions[0]?.time.updated || 0))
}
