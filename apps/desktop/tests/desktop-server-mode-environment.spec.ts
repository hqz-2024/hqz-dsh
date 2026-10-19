import { expect, it, vi } from 'vitest'
import type { DesktopServerInterfaceAddress, DesktopServerInterfaceTable } from '../scripts/desktop-server-mode-environment.mjs'
import {
  formatDesktopServerHost,
  listDesktopServerHosts,
  resolveDesktopServerModeEnvironment,
  resolveDesktopServerModeForBuild,
  resolveDesktopServerOrigin,
  selectReachableDesktopServerHost,
} from '../scripts/desktop-server-mode-environment.mjs'

/** One adapter address, carrying exactly what address selection reads. */
const address = (value: string, family: string | number = 'IPv4', internal = false): DesktopServerInterfaceAddress =>
  ({ address: value, family, internal })

it('bakes the configured origin and refuses anything that is not one', () => {
  expect(resolveDesktopServerModeEnvironment({ DSH_DESKTOP_SERVER_ORIGIN: 'https://harness.example:8443' }))
    .toEqual({ origin: 'https://harness.example:8443', source: 'origin' })
  expect(resolveDesktopServerModeEnvironment({
    DSH_DESKTOP_SERVER_ORIGIN: 'https://harness.example:8443', DSH_DESKTOP_SERVER_LABEL: ' HQZ 局域网 ',
  })).toEqual({ origin: 'https://harness.example:8443', label: 'HQZ 局域网', source: 'origin' })
  for (const value of ['http://harness.example:8443', 'https://user:secret@harness.example:8443',
    'https://harness.example:8443/api', 'https://harness.example:8443/?token=x', 'harness.example']) {
    expect(() => resolveDesktopServerOrigin(value, 'DSH_DESKTOP_SERVER_ORIGIN')).toThrow('HTTPS origin')
  }
})

it('names only the address, taking the port and brackets from the setting', () => {
  expect(resolveDesktopServerModeEnvironment({ DSH_DESKTOP_SERVER_HOST: '10.0.0.5' }))
    .toEqual({ origin: 'https://10.0.0.5:8443', source: 'host' })
  expect(resolveDesktopServerModeEnvironment({ DSH_DESKTOP_SERVER_HOST: '10.0.0.5', DSH_DESKTOP_SERVER_PORT: '9443' }))
    .toEqual({ origin: 'https://10.0.0.5:9443', source: 'host' })
  expect(formatDesktopServerHost('fe80::1')).toBe('[fe80::1]')
  expect(formatDesktopServerHost('[fe80::1]')).toBe('[fe80::1]')
  for (const port of ['0', '65536', 'https', '-1']) {
    expect(() => resolveDesktopServerModeEnvironment({ DSH_DESKTOP_SERVER_HOST: '10.0.0.5', DSH_DESKTOP_SERVER_PORT: port }))
      .toThrow('TCP port')
  }
})

it('takes the address the deployment launcher already names', () => {
  // `start-dsh-lan.cmd` sets DSH_LAN_IP, so a build run from its environment
  // needs no detection: the operator has already said which address is served.
  expect(resolveDesktopServerModeEnvironment({ DSH_LAN_IP: '192.168.28.239' }))
    .toEqual({ origin: 'https://192.168.28.239:8443', source: 'lan-ip' })
  // An explicit host outranks it, and an explicit origin outranks both.
  expect(resolveDesktopServerModeEnvironment({ DSH_LAN_IP: '192.168.28.239', DSH_DESKTOP_SERVER_HOST: '10.1.1.1' })?.origin)
    .toBe('https://10.1.1.1:8443')
  expect(resolveDesktopServerModeEnvironment({
    DSH_LAN_IP: '192.168.28.239', DSH_DESKTOP_SERVER_HOST: '10.1.1.1', DSH_DESKTOP_SERVER_ORIGIN: 'https://named.example:8443',
  })?.origin).toBe('https://named.example:8443')
})

it('offers no server mode when the deployment says it has none', () => {
  expect(resolveDesktopServerModeEnvironment({ DSH_DESKTOP_SERVER_MODE: 'none', DSH_LAN_IP: '192.168.28.239' })).toBeUndefined()
  expect(resolveDesktopServerModeEnvironment({ DSH_DESKTOP_SERVER_MODE: 'auto', DSH_LAN_IP: '192.168.28.239' })?.origin)
    .toBe('https://192.168.28.239:8443')
  expect(() => resolveDesktopServerModeEnvironment({ DSH_DESKTOP_SERVER_MODE: 'server' }))
    .toThrow("must be 'auto' or 'none'")
})

it('detects a LAN address, private ranges first and loopback never', () => {
  const interfaces: DesktopServerInterfaceTable = {
    'vEthernet (WSL)': [address('172.20.0.1')],
    Ethernet: [address('192.168.28.239'), address('fe80::1234', 'IPv6')],
    'Loopback Pseudo-Interface 1': [address('127.0.0.1', 'IPv4', true)],
    'Local Area Connection* 2': [address('169.254.10.20')],
    Tailscale: [address('100.64.0.7')],
  }
  // Private ranges first ("100.64." is carrier-grade NAT, not a LAN a client routes to),
  // then interface name — the order only decides which candidate is probed first.
  expect(listDesktopServerHosts(interfaces)).toEqual(['192.168.28.239', '172.20.0.1', '100.64.0.7'])
  // One machine, one answer: the same table always yields the same list.
  expect(listDesktopServerHosts(interfaces)).toEqual(listDesktopServerHosts(interfaces))
  expect(resolveDesktopServerModeEnvironment({}, { interfaces }))
    .toEqual({ origin: 'https://192.168.28.239:8443', source: 'detected' })
  expect(resolveDesktopServerModeEnvironment({}, { interfaces: {} })).toBeUndefined()
  expect(resolveDesktopServerModeEnvironment({}, { interfaces: { Ethernet: [address('127.0.0.1', 'IPv4', true)] } })).toBeUndefined()
})

it('prefers the candidate that answers over the one the machine lists first', async () => {
  const log: string[] = []
  const selected = await selectReachableDesktopServerHost(['172.20.0.1', '192.168.28.239'], {
    port: 8443,
    log: message => { log.push(message) },
    probe: async origin => (origin.startsWith('https://192.168.28.239') ? 200 : undefined),
  })
  expect(selected).toEqual({ host: '192.168.28.239', origin: 'https://192.168.28.239:8443' })
  expect(log).toHaveLength(2)
  expect(log[0]).toContain('no answer')
  expect(log[1]).toContain('HTTP 200')
  await expect(selectReachableDesktopServerHost(['172.20.0.1'], { probe: async () => undefined })).resolves.toBeUndefined()
})

it('verifies a detected address and hands the builder an explicit one', async () => {
  const interfaces: DesktopServerInterfaceTable = { 'vEthernet (WSL)': [address('172.20.0.1')], Ethernet: [address('192.168.28.239')] }
  const probe = vi.fn(async (origin: string) => (origin.startsWith('https://192.168.28.239') ? 401 : undefined))
  const built = await resolveDesktopServerModeForBuild({ DSH_DESKTOP_SERVER_LABEL: 'HQZ' }, { interfaces, probe, log: () => {} })
  expect(built.serverMode).toEqual({ origin: 'https://192.168.28.239:8443', label: 'HQZ', source: 'detected' })
  // The winner is handed on as the host setting, so the builder does not detect again.
  expect(built.environment.DSH_DESKTOP_SERVER_HOST).toBe('192.168.28.239')
  expect(resolveDesktopServerModeEnvironment(built.environment, { interfaces })?.origin).toBe('https://192.168.28.239:8443')
})

it('keeps a candidate and warns when nothing answers, rather than failing the build', async () => {
  const lines: string[] = []
  const built = await resolveDesktopServerModeForBuild({}, {
    interfaces: { Ethernet: [address('192.168.28.239')] },
    probe: async () => undefined,
    log: message => { lines.push(message) },
  })
  expect(built.serverMode?.origin).toBe('https://192.168.28.239:8443')
  expect(built.environment.DSH_DESKTOP_SERVER_HOST).toBeUndefined()
  expect(lines.some(line => line.includes('WARNING'))).toBe(true)
})

it('never probes an address the operator configured', async () => {
  const probe = vi.fn(async () => 200)
  const built = await resolveDesktopServerModeForBuild({ DSH_LAN_IP: '192.168.28.239' }, { probe, log: () => {} })
  expect(built.serverMode).toEqual({ origin: 'https://192.168.28.239:8443', source: 'lan-ip' })
  expect(probe).not.toHaveBeenCalled()
  const disabled = await resolveDesktopServerModeForBuild({ DSH_DESKTOP_SERVER_MODE: 'none' }, { probe, log: () => {} })
  expect(disabled.serverMode).toBeUndefined()
  expect(disabled.environment.DSH_DESKTOP_SERVER_HOST).toBeUndefined()
  expect(probe).not.toHaveBeenCalled()
})
