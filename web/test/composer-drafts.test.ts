import { afterEach, describe, expect, it } from 'bun:test'
import { beginSend, clearComposerDrafts, finishSend, getComposerDraft, moveComposerDraft, restoreAttempt } from '../src/composables/composer-drafts'

afterEach(() => clearComposerDrafts())
describe('conversation drafts', () => {
  it('keeps text, plan and uploaded attachments when switching conversations', () => {
    const a = getComposerDraft('A')
    a.text = 'unfinished A'
    a.planMode = true
    a.uploads.attachments.value.push({ id: 'file', file: new File(['data'], 'a.txt'), filename: 'a.txt', size: 4, mime: 'text/plain', status: 'ready', progress: 100, url: 'file:///a.txt' })
    getComposerDraft('B').text = 'unfinished B'
    expect(getComposerDraft('A').text).toBe('unfinished A')
    expect(getComposerDraft('A').planMode).toBe(true)
    expect(getComposerDraft('A').uploads.attachments.value[0].filename).toBe('a.txt')
  })
  it('keeps a failed send separate from a newer draft and restores the full attempt on request', () => {
    const a = getComposerDraft('A')
    a.text = 'original'
    a.planMode = true
    const attempt = beginSend(a)
    a.text = 'new input'
    finishSend(a, attempt, false)
    expect(a.text).toBe('new input')
    expect(attempt.status).toBe('failed')
    expect(restoreAttempt(a, attempt)).toBe(false)
    a.text = ''
    expect(restoreAttempt(a, attempt)).toBe(true)
    expect(a.text).toBe('original')
    expect(a.planMode).toBe(true)
  })
  it('moves pending state to the created session without replacing the draft object', () => {
    const draft = getComposerDraft('draft-A')
    draft.text = 'hello'
    const attempt = beginSend(draft)
    moveComposerDraft('draft-A', 'session-A')
    expect(getComposerDraft('session-A')).toBe(draft)
    getComposerDraft('session-B').text = 'B'
    finishSend(draft, attempt, false)
    expect(getComposerDraft('session-B').text).toBe('B')
    expect(getComposerDraft('session-A').attempts[0].text).toBe('hello')
  })
})
