import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDesktopGatewayConfig, seedDesktopGateway } from '../src/desktop-gateway.ts'

const CONFIG = { origin: 'https://192.168.28.239:8443', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], token: 'gw-test' }
const AUTHORITY = '-----BEGIN CERTIFICATE-----\ncaddy-root\n-----END CERTIFICATE-----\n'

let home: string
let patch: string
let credentials: string
let authority: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-desktop-gateway-'))
  patch = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  credentials = join(home, '.credentials.yaml')
  authority = join(home, 'profiles', 'desktop', 'gateway-ca.crt')
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

it('takes the deployment certificate when the build carries one and ignores anything else', () => {
  const route = { origin: 'https://h.example:8443', models: ['m'] }
  expect(resolveDesktopGatewayConfig({ ...route, certificateAuthority: AUTHORITY })?.certificateAuthority).toBe(AUTHORITY)
  // A value that is not a certificate costs this machine the anchor, never the route:
  // without a route it could not reach a model at all, and packaging refuses to bake
  // a value that is not a certificate in the first place.
  for (const value of [undefined, null, 7, '', 'not a certificate', '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n']) {
    const resolved = resolveDesktopGatewayConfig({ ...route, certificateAuthority: value })
    expect(resolved?.origin).toBe('https://h.example:8443')
    expect(resolved?.certificateAuthority).toBeUndefined()
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

it('writes the deployment authority this build trusts and reports where it is', () => {
  const seed = seedDesktopGateway(home, { ...CONFIG, certificateAuthority: AUTHORITY })
  expect(seed.certificateAuthority).toBe(authority)
  expect(seed.written).toEqual([patch, credentials, authority])
  expect(readFileSync(authority, 'utf8')).toBe(AUTHORITY)
})

it('replaces an authority the deployment no longer signs with', () => {
  // A machine that kept the previous authority would refuse the certificate the
  // deployment presents now, so this file follows the build rather than its owner.
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(authority, 'stale')
  const seed = seedDesktopGateway(home, { ...CONFIG, certificateAuthority: AUTHORITY })
  expect(readFileSync(authority, 'utf8')).toBe(AUTHORITY)
  expect(seed.written).toContain(authority)

  const again = seedDesktopGateway(home, { ...CONFIG, certificateAuthority: AUTHORITY })
  expect(again.kept).toEqual([patch, credentials, authority])
  expect(again.written).toEqual([])
})

it('reports no authority for a build that carries none', () => {
  expect(seedDesktopGateway(home, CONFIG).certificateAuthority).toBeUndefined()
  expect(() => readFileSync(authority, 'utf8')).toThrow()
})

it('keeps a provisioned authority a build without one does not replace', () => {
  // A machine pointed at another deployment by client/provision-client.ps1 holds
  // that deployment's authority, which this build has never seen.
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(authority, AUTHORITY)
  const seed = seedDesktopGateway(home, CONFIG)
  expect(seed.certificateAuthority).toBe(authority)
  expect(seed.kept).toEqual([authority])
  expect(seed.written).toEqual([patch, credentials])
  // A file that is not a certificate is not a trust anchor, and saying so keeps a
  // broken provisioning run visible instead of silently trusting nothing.
  writeFileSync(authority, 'stale')
  expect(seedDesktopGateway(home, CONFIG).certificateAuthority).toBeUndefined()
})
