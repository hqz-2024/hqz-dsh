import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DESKTOP_GATEWAY_DEFAULT_MODELS,
  resolveDesktopGatewayCertificateAuthority,
  resolveDesktopGatewayEnvironment,
  resolveDesktopGatewayOrigin,
} from '../scripts/desktop-gateway-environment.mjs'

it('defaults the gateway to the deployment server mode connects to', () => {
  // One deployment serves both, so naming the deployment address once is enough.
  expect(resolveDesktopGatewayEnvironment({}, 'https://192.168.28.239:8443'))
    .toEqual({ origin: 'https://192.168.28.239:8443', models: DESKTOP_GATEWAY_DEFAULT_MODELS })
  expect(resolveDesktopGatewayEnvironment({}, undefined)).toBeUndefined()
})

it('takes an explicit origin, models and token, and bakes no token when none is given', () => {
  expect(resolveDesktopGatewayEnvironment({
    DSH_DESKTOP_GATEWAY_ORIGIN: 'https://gw.example:8443',
    DSH_DESKTOP_GATEWAY_MODELS: 'deepseek-v4-flash, deepseek-v4-pro',
    DSH_DESKTOP_GATEWAY_TOKEN: 'gw-token',
  }, undefined)).toEqual({ origin: 'https://gw.example:8443', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], token: 'gw-token' })
  expect(resolveDesktopGatewayEnvironment({ DSH_DESKTOP_GATEWAY_ORIGIN: 'https://gw.example:8443' }, undefined)?.token)
    .toBeUndefined()
})

it('lets a deployment state that it bakes no route', () => {
  expect(resolveDesktopGatewayEnvironment({ DSH_DESKTOP_GATEWAY: 'none' }, 'https://192.168.28.239:8443')).toBeUndefined()
  expect(resolveDesktopGatewayEnvironment({ DSH_DESKTOP_GATEWAY: 'auto' }, 'https://192.168.28.239:8443')?.origin)
    .toBe('https://192.168.28.239:8443')
  expect(() => resolveDesktopGatewayEnvironment({ DSH_DESKTOP_GATEWAY: 'yes' }, 'https://h.example:8443'))
    .toThrow("must be 'auto' or 'none'")
})

it('refuses values a client could not use', () => {
  expect(() => resolveDesktopGatewayEnvironment({ DSH_DESKTOP_GATEWAY_ORIGIN: 'http://gw.example:8443' }, undefined))
    .toThrow('HTTPS origin')
  expect(() => resolveDesktopGatewayEnvironment({ DSH_DESKTOP_GATEWAY_ORIGIN: 'https://gw.example:8443/llm/v1' }, undefined))
    .toThrow('HTTPS origin')
  expect(() => resolveDesktopGatewayEnvironment({
    DSH_DESKTOP_GATEWAY_ORIGIN: 'https://gw.example:8443', DSH_DESKTOP_GATEWAY_MODELS: ' , ',
  }, undefined)).toThrow('at least one model')
  expect(resolveDesktopGatewayOrigin('https://gw.example:8443', 'X')).toBe('https://gw.example:8443')
})

it('bakes the certificate authority a client must trust to reach the gateway', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-gateway-authority-'))
  try {
    const certificate = join(directory, 'deployment-root.crt')
    writeFileSync(certificate, '-----BEGIN CERTIFICATE-----\r\ncaddy\r\nroot\r\n-----END CERTIFICATE-----')
    const route = resolveDesktopGatewayEnvironment({
      DSH_DESKTOP_GATEWAY_ORIGIN: 'https://gw.example:8443',
      DSH_DESKTOP_GATEWAY_CA_FILE: certificate,
    }, undefined)
    // One line ending and one trailing newline, so the manifest and the file the
    // client writes hold the same bytes whatever the build host wrote.
    expect(route?.certificateAuthority)
      .toBe('-----BEGIN CERTIFICATE-----\ncaddy\nroot\n-----END CERTIFICATE-----\n')
    expect(resolveDesktopGatewayEnvironment({ DSH_DESKTOP_GATEWAY_ORIGIN: 'https://gw.example:8443' }, undefined))
      .toEqual({ origin: 'https://gw.example:8443', models: DESKTOP_GATEWAY_DEFAULT_MODELS })
    expect(resolveDesktopGatewayCertificateAuthority({})).toBeUndefined()

    const missing = join(directory, 'missing.crt')
    expect(() => resolveDesktopGatewayCertificateAuthority({ DSH_DESKTOP_GATEWAY_CA_FILE: missing }))
      .toThrow('cannot read DSH_DESKTOP_GATEWAY_CA_FILE')
    // A named trust anchor is checked even where no route is baked, because the
    // archive script reaches the deployment over the same certificate.
    expect(() => resolveDesktopGatewayCertificateAuthority({
      DSH_DESKTOP_GATEWAY: 'none', DSH_DESKTOP_GATEWAY_CA_FILE: missing,
    })).toThrow('cannot read DSH_DESKTOP_GATEWAY_CA_FILE')

    const wrong = join(directory, 'not-a-certificate.crt')
    writeFileSync(wrong, 'hello')
    expect(() => resolveDesktopGatewayCertificateAuthority({ DSH_DESKTOP_GATEWAY_CA_FILE: wrong }))
      .toThrow('is not a PEM certificate')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
