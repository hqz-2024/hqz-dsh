import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDesktopGatewayConfig, seedDesktopGateway } from '../src/desktop-gateway.ts'

const CONFIG = { origin: 'https://192.168.28.239:8443', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], token: 'gw-test' }

let home: string
let patch: string
let credentials: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-desktop-gateway-'))
  patch = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  credentials = join(home, '.credentials.yaml')
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

it('accepts only a route it can actually use', () => {
  expect(resolveDesktopGatewayConfig({ origin: 'https://h.example:8443', models: ['m'] }))
    .toEqual({ origin: 'https://h.example:8443', models: ['m'] })
  expect(resolveDesktopGatewayConfig({ origin: 'https://h.example:8443', models: ['m'], token: 't' })?.token).toBe('t')
  for (const value of [undefined, null, 'auto', [], {}, { origin: 'https://h.example:8443' },
    { origin: 'https://h.example:8443', models: [] }, { origin: 'http://h.example:8443', models: ['m'] },
    { origin: 'https://h.example:8443', models: [7] }, { origin: 'https://h.example:8443', models: ['m'], token: '' }]) {
    expect(resolveDesktopGatewayConfig(value)).toBeUndefined()
  }
})

it('configures both rows in the patch layer, which a settings file cannot defeat', () => {
  const seed = seedDesktopGateway(home, CONFIG)
  expect(seed.written).toEqual([patch, credentials])
  expect(seed.kept).toEqual([])
  const document = readFileSync(patch, 'utf8')
  expect(document).toContain('- id: llm-deepseek\n  config:\n    protocol: chat-completions\n')
  expect(document).toContain('    baseURL: https://192.168.28.239:8443/llm/v1\n')
  expect(document).toContain('    apiKeyEnv: HQZ_GATEWAY_TOKEN\n')
  expect(document).toContain('      - id: deepseek-v4-flash\n      - id: deepseek-v4-pro\n')
  // The base bundle's own default model is not one this gateway publishes, so the
  // default has to come from the same layer that names the endpoint.
  expect(document).toContain('- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash\n')
  expect(readFileSync(credentials, 'utf8')).toContain('  HQZ_GATEWAY_TOKEN: gw-test')
})

it('extends an empty patch document rather than producing two YAML documents', () => {
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(patch, '# 桌面 profile 的补丁层\n[]\n')
  seedDesktopGateway(home, CONFIG)
  const document = readFileSync(patch, 'utf8')
  expect(document.startsWith('# 桌面 profile 的补丁层')).toBe(true)
  expect(document).not.toContain('[]')
  expect(document).toContain('- id: llm-deepseek')
})

it('appends to a patch that configures other rows, keeping them', () => {
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(patch, '- id: some-other-row\n  config:\n    keep: me\n')
  const seed = seedDesktopGateway(home, CONFIG)
  expect(seed.written).toEqual([patch, credentials])
  const document = readFileSync(patch, 'utf8')
  expect(document.startsWith('- id: some-other-row\n  config:\n    keep: me\n')).toBe(true)
  expect(document).toContain('- id: llm-deepseek')
})

it('leaves a provider someone already configured exactly as it is', () => {
  // This is a first-run default, not a policy: a hand-provisioned machine, or one
  // its owner has pointed somewhere else, keeps what it has.
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(patch, '- id: llm-deepseek\n  config:\n    baseURL: https://elsewhere.example/v1\n')
  const seed = seedDesktopGateway(home, CONFIG)
  expect(seed.kept).toEqual([patch])
  expect(seed.written).toEqual([credentials])
  expect(readFileSync(patch, 'utf8')).toContain('elsewhere.example')
})

it('adds the credential to an existing document, under the list it already has', () => {
  writeFileSync(credentials, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-someone-elses\nrecords:\n  browser-session:\n    kind: x\n')
  const seed = seedDesktopGateway(home, CONFIG)
  expect(seed.written).toEqual([patch, credentials])
  const document = readFileSync(credentials, 'utf8')
  expect(document).toContain('refs:\n  HQZ_GATEWAY_TOKEN: gw-test\n  DEEPSEEK_API_KEY: sk-someone-elses\n')
  expect(document).toContain('records:')
})

it('keeps a credential the machine already has, and writes none when the build carried none', () => {
  writeFileSync(credentials, 'version: 1\nrefs:\n  HQZ_GATEWAY_TOKEN: mine\n')
  expect(seedDesktopGateway(home, CONFIG).kept).toEqual([credentials])
  expect(readFileSync(credentials, 'utf8')).toContain('mine')

  const second = mkdtempSync(join(tmpdir(), 'dsh-desktop-gateway-'))
  try {
    const seed = seedDesktopGateway(second, { origin: CONFIG.origin, models: CONFIG.models })
    expect(seed.written).toEqual([join(second, 'profiles', 'desktop', 'cordis.patch.yml')])
    expect(() => readFileSync(join(second, '.credentials.yaml'), 'utf8')).toThrow()
  } finally { rmSync(second, { recursive: true, force: true }) }
})

it('writes nothing on a second launch', () => {
  seedDesktopGateway(home, CONFIG)
  const again = seedDesktopGateway(home, CONFIG)
  expect(again.written).toEqual([])
  expect(again.kept).toEqual([patch, credentials])
})
