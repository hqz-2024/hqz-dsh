import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDesktopGatewayConfig, seedDesktopGateway } from '../src/desktop-gateway.ts'

const CONFIG = { origin: 'https://192.168.28.239:8443', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], token: 'gw-test' }

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dsh-desktop-gateway-')) })
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

it('writes the route the runtime reads, and nothing else', () => {
  const seed = seedDesktopGateway(home, CONFIG)
  expect(seed.written).toEqual([join(home, 'settings.yaml'), join(home, '.credentials.yaml')])
  expect(seed.kept).toEqual([])
  const settings = readFileSync(join(home, 'settings.yaml'), 'utf8')
  expect(settings).toContain('baseURL: https://192.168.28.239:8443/llm/v1')
  expect(settings).toContain('apiKeyEnv: HQZ_GATEWAY_TOKEN')
  expect(settings).toContain('    - id: deepseek-v4-flash\n    - id: deepseek-v4-pro\n')
  expect(settings).toContain('model: deepseek-v4-flash')
  expect(settings).toContain('defaultPreset: danger-full-access')
  const credentials = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  expect(credentials).toContain('version: 1')
  expect(credentials).toContain('  HQZ_GATEWAY_TOKEN: gw-test')
})

it('leaves a machine that is already configured exactly as it is', () => {
  // This is a first-run default, not a policy: a hand-provisioned machine, or one
  // its owner has since pointed somewhere else, keeps the settings it has. The
  // credential is still written when it is missing, because without it a route
  // that points at the deployment would have nothing to authenticate with.
  writeFileSync(join(home, 'settings.yaml'), 'llm-deepseek:\n  baseURL: https://elsewhere.example/v1\n')
  const seed = seedDesktopGateway(home, CONFIG)
  expect(seed.kept).toEqual([join(home, 'settings.yaml')])
  expect(seed.written).toEqual([join(home, '.credentials.yaml')])
  expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('elsewhere.example')
  expect(readFileSync(join(home, '.credentials.yaml'), 'utf8')).toContain('  HQZ_GATEWAY_TOKEN: gw-test')
})

it('writes nothing at all when both files are already there', () => {
  writeFileSync(join(home, 'settings.yaml'), 'llm-deepseek:\n  baseURL: https://elsewhere.example/v1\n')
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  HQZ_GATEWAY_TOKEN: mine\n')
  const seed = seedDesktopGateway(home, CONFIG)
  expect(seed.written).toEqual([])
  expect(seed.kept).toEqual([join(home, 'settings.yaml'), join(home, '.credentials.yaml')])
  expect(readFileSync(join(home, '.credentials.yaml'), 'utf8')).toContain('mine')
})

it('writes no credential when the build carried none', () => {
  const seed = seedDesktopGateway(home, { origin: CONFIG.origin, models: CONFIG.models })
  expect(seed.written).toEqual([join(home, 'settings.yaml')])
  expect(() => readFileSync(join(home, '.credentials.yaml'), 'utf8')).toThrow()
})
