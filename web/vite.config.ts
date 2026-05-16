import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = path.resolve(webRoot, '..')
const packageJsonPath = path.join(projectRoot, 'packages/nine1bot/package.json')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

function readGitValue(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined
  } catch {
    return undefined
  }
}

const webProvenance = {
  productName: 'Nine1Bot',
  packageName: 'nine1bot',
  provenanceId: 'nine1bot.provenance.v1',
  version: process.env.NINE1BOT_VERSION || packageJson.version,
  sourceRepository: 'https://github.com/contrueCT/nine1bot',
  license: 'MIT',
  spdxLicenseIdentifier: 'MIT',
  copyright: 'Copyright (c) 2025-2026 contrueCT / Nine1Bot contributors',
  build: {
    commit: process.env.NINE1BOT_COMMIT || readGitValue(['rev-parse', '--short=12', 'HEAD']),
    date: process.env.NINE1BOT_BUILD_DATE || new Date().toISOString(),
  },
}

export default defineConfig({
  plugins: [vue()],
  define: {
    __NINE1BOT_WEB_PROVENANCE__: JSON.stringify(webProvenance),
  },
  server: {
    proxy: {
      '/session': 'http://localhost:4096',
      '/event': 'http://localhost:4096',
      '/file': 'http://localhost:4096',
      '/project': 'http://localhost:4096',
      '/global': 'http://localhost:4096',
      '/find': 'http://localhost:4096',
      '/mcp': 'http://localhost:4096',
      '/skill': 'http://localhost:4096',
      '/provider': 'http://localhost:4096',
      '/config': 'http://localhost:4096',
      '/auth': 'http://localhost:4096',
      '/webhooks': 'http://localhost:4096',
      '/agent-terminal': 'http://localhost:4096',
      '/browse': 'http://localhost:4096',
      '/question': 'http://localhost:4096',
      '/permission': 'http://localhost:4096',
      '/preferences': 'http://localhost:4096',
    }
  }
})
