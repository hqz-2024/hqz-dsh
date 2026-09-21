import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideServerCertificate,
  isDesktopMode,
  normalizeFingerprint,
  readDesktopMode,
  resolveDesktopServerModeConfig,
  resolveServerModeConfig,
  serverNavigationAllowed,
  writeDesktopMode,
} from '../src/server-mode.ts'

/** A fingerprint-shaped value; the trust decision never parses it. */
const PIN = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const OTHER = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00'

const ORIGIN = 'https://192.168.28.239:8443'

describe('server-mode configuration', () => {
  it('keeps only the origin of a configured deployment', () => {
    expect(resolveDesktopServerModeConfig({ origin: `${ORIGIN}/`, label: ' hqz-dsh ' }, 'test'))
      .toEqual({ origin: ORIGIN, label: 'hqz-dsh', source: 'test' })
  })

  it('refuses a deployment that cannot be trusted or addressed', () => {
    // Every rejected value would otherwise put the user in front of a document
    // the operator did not intend, so each one fails loud instead of falling back.
    expect(() => resolveDesktopServerModeConfig({ origin: 'http://host:80' }, 'test')).toThrow(/must use https/u)
    expect(() => resolveDesktopServerModeConfig({ origin: 'https://user:pw@host/' }, 'test')).toThrow(/credentials/u)
    expect(() => resolveDesktopServerModeConfig({ origin: 'https://host/app' }, 'test')).toThrow(/without a path/u)
    expect(() => resolveDesktopServerModeConfig({ origin: 'https://host/?token=x' }, 'test')).toThrow(/without a path/u)
    expect(() => resolveDesktopServerModeConfig({ origin: 'not a url' }, 'test')).toThrow(/not a URL/u)
    expect(() => resolveDesktopServerModeConfig({ origin: '' }, 'test')).toThrow(/nonempty origin/u)
    expect(() => resolveDesktopServerModeConfig({ origin: ORIGIN, certificateSha256: 'short' }, 'test')).toThrow(/SHA-256/u)
    expect(() => resolveDesktopServerModeConfig({ origin: ORIGIN, label: '  ' }, 'test')).toThrow(/nonempty string/u)
    expect(() => resolveDesktopServerModeConfig('https://host', 'test')).toThrow(/must be an object/u)
  })

  it('treats an absent deployment as no server mode at all', () => {
    expect(resolveDesktopServerModeConfig(undefined, 'test')).toBeUndefined()
    expect(resolveDesktopServerModeConfig(null, 'test')).toBeUndefined()
  })

  it('normalizes a fingerprint written in either accepted spelling', () => {
    expect(normalizeFingerprint(PIN.toLowerCase().replaceAll(':', ''))).toBe(PIN)
    expect(normalizeFingerprint(` ${PIN} `)).toBe(PIN)
    expect(normalizeFingerprint('AA:BB')).toBeUndefined()
  })
})

describe('server-mode configuration precedence', () => {
  let directory: string
  let settingsFile: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-mode-'))
    settingsFile = join(directory, 'desktop-client.json')
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  it('prefers the environment, then the person\'s file, then the packaged default', () => {
    const manifestValue = { origin: 'https://manifest.example:8443' }
    expect(resolveServerModeConfig({ manifestValue, environmentValue: undefined, settingsFile })?.origin)
      .toBe('https://manifest.example:8443')

    writeFileSync(settingsFile, JSON.stringify({ server: { origin: 'https://file.example:8443' } }))
    expect(resolveServerModeConfig({ manifestValue, environmentValue: undefined, settingsFile })?.origin)
      .toBe('https://file.example:8443')
    expect(resolveServerModeConfig({ manifestValue, environmentValue: undefined, settingsFile })?.source)
      .toBe(settingsFile)

    expect(resolveServerModeConfig({
      manifestValue, environmentValue: JSON.stringify({ origin: 'https://env.example:8443' }), settingsFile,
    })?.origin).toBe('https://env.example:8443')
  })

  it('fails loud on a settings file it cannot use, naming the file', () => {
    // A settings file that silently did nothing would leave the user in local
    // mode with no indication of why their own deployment was ignored.
    writeFileSync(settingsFile, '{ this is not json')
    expect(() => resolveServerModeConfig({ manifestValue: undefined, environmentValue: undefined, settingsFile }))
      .toThrow(/not valid JSON/u)
    writeFileSync(settingsFile, JSON.stringify({ server: { origin: 'http://plain.example' } }))
    expect(() => resolveServerModeConfig({ manifestValue: undefined, environmentValue: undefined, settingsFile }))
      .toThrow(/must use https/u)
    expect(() => resolveServerModeConfig({
      manifestValue: undefined, environmentValue: '{"origin":"http://plain.example"}', settingsFile,
    })).toThrow(/must use https/u)
  })

  it('names the environment variable when its value is a mode word rather than a deployment', () => {
    // The variable's name reads like a mode selector, so `local` is the mistake
    // to expect from it; the report has to name what it carries instead of
    // repeating what JSON.parse said about the first character.
    const resolve = (): unknown => resolveServerModeConfig({
      manifestValue: undefined, environmentValue: 'local', settingsFile,
    })
    expect(resolve).toThrow(/DSH_DESKTOP_SERVER_MODE is not valid JSON/u)
    expect(resolve).toThrow(/unset variable starts in local mode/u)
  })

  it('prefers a usable later layer over a deployment the file does not configure', () => {
    writeFileSync(settingsFile, JSON.stringify({ somethingElse: true }))
    expect(resolveServerModeConfig({
      manifestValue: { origin: 'https://manifest.example:8443' }, environmentValue: undefined, settingsFile,
    })?.origin).toBe('https://manifest.example:8443')
  })
})

describe('selected mode', () => {
  let directory: string
  let modeFile: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-mode-file-'))
    modeFile = join(directory, 'desktop-mode.json')
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  it('starts local when nothing was stored', () => {
    expect(readDesktopMode(modeFile)).toBe('local')
  })

  it('remembers the mode across a restart', () => {
    expect(writeDesktopMode(modeFile, 'server')).toBeUndefined()
    expect(JSON.parse(readFileSync(modeFile, 'utf8'))).toEqual({ mode: 'server' })
    expect(readDesktopMode(modeFile)).toBe('server')
  })

  it('falls back to local rather than stranding the window on a damaged preference', () => {
    writeFileSync(modeFile, 'not json')
    expect(readDesktopMode(modeFile)).toBe('local')
    writeFileSync(modeFile, JSON.stringify({ mode: 'somewhere' }))
    expect(readDesktopMode(modeFile)).toBe('local')
  })

  it('reports a write failure instead of refusing the switch the user already made', () => {
    const failure = writeDesktopMode(join(directory, 'missing', 'desktop-mode.json'), 'server')
    expect(failure).toBeInstanceOf(Error)
  })

  it('recognizes only the two modes', () => {
    expect(isDesktopMode('local')).toBe(true)
    expect(isDesktopMode('server')).toBe(true)
    expect(isDesktopMode('remote')).toBe(false)
    expect(isDesktopMode(undefined)).toBe(false)
  })
})

describe('certificate trust', () => {
  const config = { origin: ORIGIN, certificateSha256: PIN }

  it('accepts only the pinned certificate for the configured origin', () => {
    expect(decideServerCertificate(config, `${ORIGIN}/`, PIN).accept).toBe(true)
    expect(decideServerCertificate(config, `${ORIGIN}/`, OTHER).accept).toBe(false)
  })

  it('accepts a self-signed certificate for its own origin when nothing is pinned', () => {
    const decision = decideServerCertificate({ origin: ORIGIN }, `${ORIGIN}/api`, OTHER)
    expect(decision.accept).toBe(true)
    expect(decision.reason).toContain(OTHER)
  })

  it('never extends trust to another origin, even when that origin is the pinned one', () => {
    expect(decideServerCertificate(config, 'https://evil.example/', PIN).accept).toBe(false)
    expect(decideServerCertificate(config, 'not a url', PIN).accept).toBe(false)
  })

  it('refuses a certificate the caller could not read', () => {
    expect(decideServerCertificate(config, `${ORIGIN}/`, undefined).accept).toBe(false)
  })
})

describe('server document navigation', () => {
  const config = { origin: ORIGIN }

  it('keeps the deployment and anything it navigates to inside itself', () => {
    expect(serverNavigationAllowed(config, `${ORIGIN}/`)).toBe(true)
    expect(serverNavigationAllowed(config, `${ORIGIN}/settings/models`)).toBe(true)
    // Chromium opens this for a window's first document.
    expect(serverNavigationAllowed(config, 'about:blank')).toBe(true)
  })

  it('hands every other destination to the operating system', () => {
    expect(serverNavigationAllowed(config, 'https://example.com/')).toBe(false)
    expect(serverNavigationAllowed(config, 'https://192.168.28.239:8444/')).toBe(false)
    expect(serverNavigationAllowed(config, 'file:///C:/Windows/System32/')).toBe(false)
    expect(serverNavigationAllowed(undefined, `${ORIGIN}/`)).toBe(false)
  })
})
