import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  FileAccessCredentialStore,
  accessPasswordLength,
  validateAccessPassword,
} from './credential-store'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createStore(): Promise<FileAccessCredentialStore> {
  const directory = await mkdtemp(join(tmpdir(), 'nine1bot-access-auth-'))
  tempDirs.push(directory)
  return new FileAccessCredentialStore(join(directory, 'access-auth.json'))
}

describe('FileAccessCredentialStore', () => {
  it('stores only an Argon2id hash and increments the credential version', async () => {
    const store = await createStore()
    const first = await store.setPassword('correct horse battery')
    const second = await store.setPassword('another secure password')
    const raw = await readFile(store.path, 'utf8')

    expect(first.passwordHash).toStartWith('$argon2id$')
    expect(second.credentialVersion).toBe(first.credentialVersion + 1)
    expect(raw).not.toContain('correct horse battery')
    expect(raw).not.toContain('another secure password')
    expect(await Bun.password.verify('another secure password', second.passwordHash)).toBe(true)
  })

  it('counts Unicode code points and enforces the password policy', () => {
    expect(accessPasswordLength('密码密码密码密码密码密码')).toBe(12)
    expect(() => validateAccessPassword('short')).toThrow('12-256')
    expect(() => validateAccessPassword('            ')).toThrow('whitespace')
    expect(() => validateAccessPassword('密码密码密码密码密码密码')).not.toThrow()
  })

  it('repairs a malformed credential file when setting a new password', async () => {
    const store = await createStore()
    await writeFile(store.path, JSON.stringify({
      schemaVersion: 1,
      passwordHash: '$argon2i$malformed',
      credentialVersion: 1,
      updatedAt: new Date().toISOString(),
    }), 'utf8')

    const repaired = await store.setPassword('replacement secure password')
    expect(repaired.passwordHash).toStartWith('$argon2id$')
    expect(await Bun.password.verify('replacement secure password', repaired.passwordHash)).toBe(true)
  })
})
