import { describe, expect, it } from 'bun:test'
import { escapeHtml, highlightMatch } from '../src/utils/highlight'

describe('escapeHtml', () => {
  it('escapes all HTML-sensitive characters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })
})

describe('highlightMatch', () => {
  it('escapes HTML in titles so markup cannot be injected', () => {
    const result = highlightMatch('<img src=x onerror=alert(1)>', 'img')
    expect(result).not.toContain('<img')
    expect(result).toContain('&lt;')
    expect(result).toContain('&lt;<mark>img</mark>')
  })

  it('HTML-escapes the search term before matching', () => {
    expect(highlightMatch('a <b> c', '<b>')).toBe('a <mark>&lt;b&gt;</mark> c')
  })

  it('regex-escapes the search term', () => {
    expect(highlightMatch('a.*+? b', '.*+?')).toBe('a<mark>.*+?</mark> b')
    expect(highlightMatch('100$ total', '100$')).toBe('<mark>100$</mark> total')
  })

  it('returns escaped text when the search term is empty', () => {
    const escaped = '&lt;script&gt;alert(1)&lt;/script&gt;'
    expect(highlightMatch('<script>alert(1)</script>', '')).toBe(escaped)
    expect(highlightMatch('<script>alert(1)</script>', '   ')).toBe(escaped)
  })

  it('highlights case-insensitively without breaking escaping', () => {
    expect(highlightMatch('Foo & foo', 'FOO')).toBe('<mark>Foo</mark> &amp; <mark>foo</mark>')
  })
})
