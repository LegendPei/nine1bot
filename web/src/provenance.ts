export interface WebProvenance {
  productName: string
  packageName: string
  provenanceId: string
  version: string
  sourceRepository: string
  license: string
  spdxLicenseIdentifier: string
  copyright: string
  build: {
    commit?: string
    date?: string
  }
}

declare const __NINE1BOT_WEB_PROVENANCE__: Partial<WebProvenance> | undefined

const DEFAULT_PROVENANCE: WebProvenance = {
  productName: 'Nine1Bot',
  packageName: 'nine1bot',
  provenanceId: 'nine1bot.provenance.v1',
  version: '1.0.1',
  sourceRepository: 'https://github.com/contrueCT/nine1bot',
  license: 'MIT',
  spdxLicenseIdentifier: 'MIT',
  copyright: 'Copyright (c) 2025-2026 contrueCT / Nine1Bot contributors',
  build: {},
}

function definedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeProvenance(value: Partial<WebProvenance> | undefined): WebProvenance {
  return {
    ...DEFAULT_PROVENANCE,
    ...value,
    version: definedString(value?.version) ?? DEFAULT_PROVENANCE.version,
    build: {
      commit: definedString(value?.build?.commit),
      date: definedString(value?.build?.date),
    },
  }
}

export const NINE1BOT_WEB_PROVENANCE = Object.freeze(
  normalizeProvenance(
    typeof __NINE1BOT_WEB_PROVENANCE__ === 'undefined'
      ? undefined
      : __NINE1BOT_WEB_PROVENANCE__
  )
)
