import { describe, expect, it } from 'bun:test'
import { groupSessionsByProject } from '../src/utils/session-groups'
import type { Session } from '../src/api/client'

const session = (id: string, directory: string, projectID?: string): Session => ({ id, directory, projectID, title: id, time: { created: 1, updated: Number(id) || 1 } })
describe('Agent project groups', () => {
  it('groups by stable project identity and does not merge same-named projects', () => {
    const groups = groupSessionsByProject([session('1', '/a/app', 'a'), session('2', '/b/app', 'b')], [
      { id: 'a', name: 'app', worktree: '/a/app' }, { id: 'b', name: 'app', worktree: '/b/app' },
    ])
    expect(groups.map(group => group.id)).toEqual(['b', 'a'])
    expect(groups.every(group => group.sessions.length === 1)).toBe(true)
  })
  it('uses the closest directory project for legacy sessions and retains unregistered directories', () => {
    const groups = groupSessionsByProject([session('1', '/repo/nested/src'), session('2', '/elsewhere')], [
      { id: 'root', worktree: '/repo' }, { id: 'nested', worktree: '/repo/nested' },
    ])
    expect(groups.find(group => group.id === 'nested')?.sessions[0].id).toBe('1')
    expect(groups.find(group => group.id === 'directory:/elsewhere')?.sessions[0].id).toBe('2')
    expect(groups.find(group => group.id === 'root')?.sessions).toEqual([])
  })
})
