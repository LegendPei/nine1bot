// Copyright (c) 2025-2026 contrueCT / Nine1Bot contributors
// SPDX-License-Identifier: MIT

declare const NINE1BOT_VERSION: string | undefined
declare const NINE1BOT_COMMIT: string | undefined
declare const NINE1BOT_BUILD_DATE: string | undefined
declare const NINE1BOT_COMPILED: boolean | undefined

const PACKAGE_VERSION = '1.0.1'

function definedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function compiledString(name: 'version' | 'commit' | 'buildDate'): string | undefined {
  if (name === 'version') {
    return typeof NINE1BOT_VERSION === 'undefined' ? undefined : definedString(NINE1BOT_VERSION)
  }
  if (name === 'commit') {
    return typeof NINE1BOT_COMMIT === 'undefined' ? undefined : definedString(NINE1BOT_COMMIT)
  }
  return typeof NINE1BOT_BUILD_DATE === 'undefined' ? undefined : definedString(NINE1BOT_BUILD_DATE)
}

function compiledFlag(): boolean {
  return typeof NINE1BOT_COMPILED === 'boolean' ? NINE1BOT_COMPILED : false
}

export const NINE1BOT_PROVENANCE = Object.freeze({
  productName: 'Nine1Bot',
  packageName: 'nine1bot',
  provenanceId: 'nine1bot.provenance.v1',
  version: compiledString('version') ?? definedString(process.env.NINE1BOT_VERSION) ?? PACKAGE_VERSION,
  sourceRepository: 'https://github.com/contrueCT/nine1bot',
  license: 'MIT',
  spdxLicenseIdentifier: 'MIT',
  copyright: 'Copyright (c) 2025-2026 contrueCT / Nine1Bot contributors',
  build: {
    commit: compiledString('commit') ?? definedString(process.env.NINE1BOT_COMMIT),
    date: compiledString('buildDate') ?? definedString(process.env.NINE1BOT_BUILD_DATE),
    compiled: compiledFlag(),
  },
})

export type Nine1BotProvenance = typeof NINE1BOT_PROVENANCE

export function formatProvenanceLines(provenance: Nine1BotProvenance = NINE1BOT_PROVENANCE): string[] {
  const lines = [
    `${provenance.productName} ${provenance.version}`,
    `Source: ${provenance.sourceRepository}`,
    `License: ${provenance.license}`,
    `SPDX: ${provenance.spdxLicenseIdentifier}`,
    `Provenance: ${provenance.provenanceId}`,
    provenance.build.commit ? `Commit: ${provenance.build.commit}` : undefined,
    provenance.build.date ? `Build date: ${provenance.build.date}` : undefined,
    `Compiled binary: ${provenance.build.compiled ? 'yes' : 'no'}`,
    provenance.copyright,
  ]

  return lines.filter((line): line is string => Boolean(line))
}
