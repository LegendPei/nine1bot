import type { Argv, ArgumentsCamelCase } from 'yargs'
import * as prompts from '@clack/prompts'
import { UI } from '../ui'
import { resolveConfigContext } from '../../config/loader'
import {
  FileAccessCredentialStore,
  MIN_ACCESS_PASSWORD_LENGTH,
  validateAccessPassword,
} from '../../access-auth/credential-store'
import { updateConfigValue } from '../../config/editor'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasProviderApiKey(providerConfig: unknown): boolean {
  if (!isRecord(providerConfig) || !isRecord(providerConfig.options)) {
    return false
  }

  return typeof providerConfig.options.apiKey === 'string' && providerConfig.options.apiKey.length > 0
}

function getMcpDisplayInfo(mcpConfig: unknown): { type: string; enabled: boolean } {
  if (!isRecord(mcpConfig)) {
    return { type: 'unknown', enabled: true }
  }

  return {
    type: typeof mcpConfig.type === 'string' ? mcpConfig.type : 'unknown',
    enabled: typeof mcpConfig.enabled === 'boolean' ? mcpConfig.enabled : true,
  }
}

/**
 * 显示配置
 */
async function showConfig(): Promise<void> {
  const context = await resolveConfigContext({ startDir: process.cwd() })
  const configPath = context.writePath

  UI.title('Configuration')
  UI.info(`File: ${configPath}`)
  UI.empty()

  const config = context.effective
  if (context.sources.length > 0) {
    UI.println('Sources:')
    for (const source of context.sources) UI.println(`  ${source.kind}: ${source.path}`)
    UI.empty()
  }

  // 显示 server 配置
  UI.println('Server:')
  UI.println(`  port:        ${UI.formatConfigValue(config.server.port)}`)
  UI.println(`  hostname:    ${UI.formatConfigValue(config.server.hostname)}`)
  UI.println(`  openBrowser: ${UI.formatConfigValue(config.server.openBrowser)}`)
  UI.empty()

  // 显示 auth 配置
  UI.println('Auth:')
  UI.println(`  enabled:        ${UI.formatConfigValue(config.auth.enabled)}`)
  UI.println(`  enabledSource:  ${UI.formatConfigValue(context.provenance['auth.enabled'])}`)
  UI.println(`  legacyPassword: ${UI.formatConfigValue(config.auth.password ? 'configured (migration required)' : undefined)}`)
  UI.empty()

  // 显示 tunnel 配置
  UI.println('Tunnel:')
  UI.println(`  enabled:  ${UI.formatConfigValue(config.tunnel.enabled)}`)
  UI.println(`  provider: ${UI.formatConfigValue(config.tunnel.provider)}`)
  if (config.tunnel.ngrok) {
    UI.println(`  ngrok.authToken: ${UI.formatConfigValue(config.tunnel.ngrok.authToken ? '***' : undefined)}`)
  }
  if (config.tunnel.natapp) {
    UI.println(`  natapp.authToken: ${UI.formatConfigValue(config.tunnel.natapp.authToken ? '***' : undefined)}`)
  }
  UI.empty()

  // 显示 model 配置
  if (config.model) {
    UI.println('Model:')
    UI.println(`  default: ${UI.formatConfigValue(config.model)}`)
    UI.empty()
  }

  // 显示 provider 配置（隐藏 API key）
  if (config.provider && Object.keys(config.provider).length > 0) {
    UI.println('Providers:')
    for (const [name, providerConfig] of Object.entries(config.provider)) {
      const hasApiKey = hasProviderApiKey(providerConfig) ? ' (configured)' : ''
      UI.println(`  ${name}${hasApiKey}`)
    }
    UI.empty()
  }

  // 显示 MCP 配置
  if (config.mcp && Object.keys(config.mcp).length > 0) {
    UI.println('MCP Servers:')
    for (const [name, mcpConfig] of Object.entries(config.mcp)) {
      const { type, enabled } = getMcpDisplayInfo(mcpConfig)
      UI.println(`  ${name}: ${type} (${enabled ? 'enabled' : 'disabled'})`)
    }
    UI.empty()
  }
}

/**
 * 设置配置值
 */
async function setConfig(key: string, value: string): Promise<void> {
  if (key === 'auth.password') {
    throw new Error("Use 'nine1bot config set-password' so the password is not exposed in shell history")
  }
  const { writePath: configPath } = await resolveConfigContext({ startDir: process.cwd() })

  // 解析键路径，例如 "server.port" -> ["server", "port"]
  const keys = key.split('.')

  // 解析值
  let parsedValue: any = value
  if (value === 'true') parsedValue = true
  else if (value === 'false') parsedValue = false
  else if (/^\d+$/.test(value)) parsedValue = parseInt(value)

  await updateConfigValue(configPath, keys, parsedValue)
  UI.success(`Set ${key} = ${JSON.stringify(parsedValue)}`)
}

/**
 * 在编辑器中打开配置文件
 */
async function editConfig(): Promise<void> {
  const { writePath: configPath } = await resolveConfigContext({ startDir: process.cwd() })

  // 尝试使用系统默认编辑器打开
  const { exec } = await import('child_process')
  const { promisify } = await import('util')
  const execAsync = promisify(exec)

  const platform = process.platform

  try {
    if (platform === 'win32') {
      await execAsync(`start "" "${configPath}"`)
    } else if (platform === 'darwin') {
      await execAsync(`open "${configPath}"`)
    } else {
      // Linux - 尝试 xdg-open 或环境变量中的编辑器
      const editor = process.env.EDITOR || 'xdg-open'
      await execAsync(`${editor} "${configPath}"`)
    }
    UI.success(`Opened ${configPath}`)
  } catch {
    UI.info(`Config file: ${configPath}`)
    UI.warn('Could not open editor automatically. Please open the file manually.')
  }
}

async function promptAccessPassword(): Promise<string> {
  const first = await prompts.password({
    message: 'Set a password for WebUI access',
    validate(value) {
      try {
        validateAccessPassword(value || '')
      } catch (error) {
        return error instanceof Error
          ? error.message
          : `Password must be at least ${MIN_ACCESS_PASSWORD_LENGTH} characters`
      }
    },
  })
  if (prompts.isCancel(first)) throw new UI.CancelledError()
  const confirmation = await prompts.password({ message: 'Confirm the WebUI access password' })
  if (prompts.isCancel(confirmation)) throw new UI.CancelledError()
  if (first !== confirmation) throw new Error('Passwords do not match')
  return first
}

async function setAccessPassword(): Promise<void> {
  const password = await promptAccessPassword()
  const context = await resolveConfigContext({ startDir: process.cwd() })
  await updateConfigValue(context.writePath, ['auth', 'enabled'], true)
  for (const source of context.sources) {
    await updateConfigValue(source.path, ['auth', 'password'], undefined)
  }
  await new FileAccessCredentialStore().setPassword(password)
  UI.success(`WebUI access password updated; auth is enabled in ${context.writePath}`)
}

async function migrateAccessPassword(): Promise<void> {
  const context = await resolveConfigContext({ startDir: process.cwd() })
  const legacy = context.effective.auth.password
  if (!legacy) throw new Error('No legacy auth.password value was found in the effective configuration')
  await new FileAccessCredentialStore().setPassword(legacy)
  await updateConfigValue(context.writePath, ['auth', 'enabled'], true)
  const legacySource = context.provenance['auth.password']
  if (legacySource && legacySource !== 'schema-default') {
    await updateConfigValue(legacySource, ['auth', 'password'], undefined)
  }
  UI.success('Migrated WebUI access password to the hashed credential store')
}

async function disableAccessAuth(): Promise<void> {
  const context = await resolveConfigContext({ startDir: process.cwd() })
  await updateConfigValue(context.writePath, ['auth', 'enabled'], false)
  UI.success(`Disabled WebUI access authentication in ${context.writePath}`)
}

async function showAccessAuthStatus(): Promise<void> {
  const context = await resolveConfigContext({ startDir: process.cwd() })
  let source: 'environment' | 'credential-store' | 'legacy-config' | 'missing' | 'invalid-credential'
  if (process.env.NINE1BOT_WEB_PASSWORD !== undefined) {
    source = 'environment'
  } else {
    try {
      const credential = await new FileAccessCredentialStore().load()
      source = credential
        ? 'credential-store'
        : context.effective.auth.password
          ? 'legacy-config'
          : 'missing'
    } catch {
      source = 'invalid-credential'
    }
  }
  UI.title('WebUI Access Authentication')
  UI.println(`  enabled: ${context.effective.auth.enabled}`)
  UI.println(`  source:  ${source}`)
  UI.println(`  active:  ${context.effective.auth.enabled && source !== 'missing' && source !== 'invalid-credential'}`)
  UI.println(`  config:  ${context.writePath}`)
}

/**
 * Config 命令处理器
 */
export const ConfigCommand = {
  command: 'config [action] [key] [value]',
  describe: 'Manage configuration',
  builder: (yargs: Argv) => {
    return yargs
      .positional('action', {
        describe: 'Action to perform',
        choices: ['show', 'set', 'edit', 'set-password', 'migrate-auth', 'disable-auth', 'auth-status'] as const,
        default: 'show' as const,
      })
      .positional('key', {
        describe: 'Configuration key (for set)',
        type: 'string',
      })
      .positional('value', {
        describe: 'Configuration value (for set)',
        type: 'string',
      })
  },
  handler: async (args: ArgumentsCamelCase<{ action: string; key?: string; value?: string }>) => {
    try {
      switch (args.action) {
        case 'show':
          await showConfig()
          break
        case 'set':
          if (!args.key || args.value === undefined) {
            UI.error('Usage: nine1bot config set <key> <value>')
            UI.info('Example: nine1bot config set server.port 8080')
            process.exit(1)
          }
          await setConfig(args.key, args.value)
          break
        case 'edit':
          await editConfig()
          break
        case 'set-password':
          await setAccessPassword()
          break
        case 'migrate-auth':
          await migrateAccessPassword()
          break
        case 'disable-auth':
          await disableAccessAuth()
          break
        case 'auth-status':
          await showAccessAuthStatus()
          break
        default:
          UI.error(`Unknown action: ${args.action}`)
          process.exit(1)
      }
    } catch (error: any) {
      UI.error(error.message)
      process.exit(1)
    }
  },
}
