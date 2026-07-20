import { chmod, mkdir, open, readFile, rename, rm } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { getAccessAuthPath } from '../config/loader'

export const MIN_ACCESS_PASSWORD_LENGTH = 12
export const MAX_ACCESS_PASSWORD_LENGTH = 256

export type AccessCredential = {
  schemaVersion: 1
  passwordHash: string
  credentialVersion: number
  updatedAt: string
}

export function accessPasswordLength(password: string): number {
  return Array.from(password).length
}

export function validateAccessPassword(password: string): void {
  const length = accessPasswordLength(password)
  if (!password || !password.trim()) {
    throw new Error('Web access password cannot be empty or whitespace only')
  }
  if (length < MIN_ACCESS_PASSWORD_LENGTH || length > MAX_ACCESS_PASSWORD_LENGTH) {
    throw new Error(
      `Web access password must be ${MIN_ACCESS_PASSWORD_LENGTH}-${MAX_ACCESS_PASSWORD_LENGTH} characters`,
    )
  }
}

export async function hashAccessPassword(password: string): Promise<string> {
  validateAccessPassword(password)
  return Bun.password.hash(password, 'argon2id')
}

function validateCredential(value: unknown): AccessCredential {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid Web access credential file')
  }
  const record = value as Partial<AccessCredential>
  if (
    record.schemaVersion !== 1 ||
    typeof record.passwordHash !== 'string' ||
    !record.passwordHash.startsWith('$argon2id$') ||
    typeof record.credentialVersion !== 'number' ||
    !Number.isInteger(record.credentialVersion) ||
    record.credentialVersion < 1 ||
    typeof record.updatedAt !== 'string'
  ) {
    throw new Error('Invalid Web access credential file')
  }
  return record as AccessCredential
}

export class FileAccessCredentialStore {
  constructor(readonly path: string = getAccessAuthPath()) {}

  async load(): Promise<AccessCredential | undefined> {
    try {
      const content = await readFile(this.path, 'utf8')
      return validateCredential(JSON.parse(content))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in Web access credential file: ${this.path}`)
      }
      throw error
    }
  }

  async setPassword(password: string): Promise<AccessCredential> {
    let existing: AccessCredential | undefined
    try {
      existing = await this.load()
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (!message.startsWith('Invalid Web access credential file') &&
          !message.startsWith('Invalid JSON in Web access credential file')) {
        throw error
      }
      // A corrupted verifier must be repairable by the command named in the
      // startup error. The replacement starts a new credential generation.
      existing = undefined
    }
    const credential: AccessCredential = {
      schemaVersion: 1,
      passwordHash: await hashAccessPassword(password),
      credentialVersion: (existing?.credentialVersion ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    }
    await this.write(credential)
    return credential
  }

  async write(credential: AccessCredential): Promise<void> {
    validateCredential(credential)
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      await chmod(directory, 0o700)
    }

    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    )
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    try {
      if (process.platform !== 'win32') {
        await chmod(temporaryPath, 0o600)
      }
      await rename(temporaryPath, this.path)
      if (process.platform !== 'win32') {
        await chmod(this.path, 0o600)
      }
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {})
      throw error
    }
  }
}
