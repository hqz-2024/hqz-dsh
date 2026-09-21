/**
 * Resolve the deployment a packaged client should offer in server mode.
 *
 * The value lands in the application manifest as `dshDesktopServerMode`, which
 * `src/server-mode.ts` reads as its last-precedence default: a person's own
 * `desktop-client.json` and the `DSH_DESKTOP_SERVER_MODE` environment variable
 * both override it. So this is the answer to "which deployment does a machine
 * that was never configured connect to", and getting it wrong ships a client
 * that opens nothing.
 *
 * Release settings are file-owned, so an explicit origin wins. Failing that the
 * build answers the question the way the deployment does: the address dsh is
 * actually serving on. `DSH_LAN_IP` is the variable this deployment's launcher
 * already sets, and when nothing names an address the machine's LAN address is
 * used, preferring the private ranges a client can route to.
 */

import { networkInterfaces } from 'node:os'
import { request } from 'node:https'

/** Default HTTPS port of a deployment published through its LAN reverse proxy. */
export const DESKTOP_SERVER_DEFAULT_PORT = 8443

const PRIVATE_ADDRESS = [/^192\.168\./u, /^10\./u, /^172\.(?:1[6-9]|2\d|3[01])\./u]

function isIPv4(family) {
  return family === 'IPv4' || family === 4
}

/**
 * List the addresses a LAN client could reach this machine on.
 *
 * Private ranges come first because a deployment is almost always reached over
 * the same LAN, then interface name and address order the rest, so one machine
 * produces the same list on every build instead of one that follows the order
 * the operating system happened to enumerate adapters in.
 * @param {ReturnType<typeof networkInterfaces>} interfaces Address table, defaulting to this machine's.
 * @returns {string[]} Ordered candidate addresses, without loopback or link-local entries.
 */
export function listDesktopServerHosts(interfaces = networkInterfaces()) {
  const candidates = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (!isIPv4(address.family) || address.internal || address.address.startsWith('169.254.')) continue
      candidates.push({ name, address: address.address, private: PRIVATE_ADDRESS.some(pattern => pattern.test(address.address)) })
    }
  }
  return candidates
    .sort((left, right) => Number(right.private) - Number(left.private)
      || left.name.localeCompare(right.name) || left.address.localeCompare(right.address))
    .map(candidate => candidate.address)
}

/**
 * Render one host as the authority of an origin.
 * @param {string} host IPv4 address, IPv6 address, or host name.
 * @returns {string} The authority, with IPv6 brackets added when absent.
 * @throws {Error} When the value cannot be an authority.
 */
export function formatDesktopServerHost(host) {
  const trimmed = host.trim()
  if (trimmed === '' || /[\s/\\]/u.test(trimmed)) throw new Error(`desktop package: unusable server host ${JSON.stringify(host)}`)
  if (/^\[.*\]$/u.test(trimmed)) return trimmed
  return trimmed.includes(':') ? `[${trimmed}]` : trimmed
}

/**
 * Validate one configured deployment origin.
 * @param {string} value Candidate origin text.
 * @param {string} name Setting name, for the failure message.
 * @returns {string} The normalized origin.
 * @throws {Error} When the value is not an HTTPS origin without credentials, path, query or fragment.
 */
export function resolveDesktopServerOrigin(value, name) {
  let url
  try { url = new URL(value) } catch { throw new Error(`desktop package: ${name} requires an HTTPS origin`) }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`desktop package: ${name} requires an HTTPS origin without credentials, path, query, or fragment`)
  }
  return url.origin
}

function resolvePort(value) {
  if (value === undefined || value.trim() === '') return DESKTOP_SERVER_DEFAULT_PORT
  const port = Number(value.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('desktop package: DSH_DESKTOP_SERVER_PORT must be a TCP port number')
  }
  return port
}

/**
 * Resolve the server-mode default from release settings and this machine.
 *
 * `DSH_DESKTOP_SERVER_MODE=none` states that this deployment has no second
 * address to offer; that is a decision, not a missing value, so it is spelled
 * out rather than inferred from an absent origin.
 * @param {NodeJS.ProcessEnv} environment File-owned release settings.
 * @param {{ interfaces?: ReturnType<typeof networkInterfaces> }} [options] Address table override, for tests.
 * @returns {{ origin: string, source: 'origin' | 'host' | 'lan-ip' | 'detected', label?: string } | undefined} The default to bake, or undefined when this deployment bakes none.
 */
export function resolveDesktopServerModeEnvironment(environment, options = {}) {
  const mode = (environment.DSH_DESKTOP_SERVER_MODE ?? '').trim().toLowerCase()
  if (mode === 'none') return undefined
  if (mode !== '' && mode !== 'auto') {
    throw new Error("desktop package: DSH_DESKTOP_SERVER_MODE must be 'auto' or 'none'")
  }
  const label = (environment.DSH_DESKTOP_SERVER_LABEL ?? '').trim()
  const named = value => (label === '' ? value : { ...value, label })
  const configuredOrigin = (environment.DSH_DESKTOP_SERVER_ORIGIN ?? '').trim()
  if (configuredOrigin !== '') {
    return named({ origin: resolveDesktopServerOrigin(configuredOrigin, 'DSH_DESKTOP_SERVER_ORIGIN'), source: 'origin' })
  }
  const port = resolvePort(environment.DSH_DESKTOP_SERVER_PORT)
  const configuredHost = (environment.DSH_DESKTOP_SERVER_HOST ?? '').trim()
  if (configuredHost !== '') {
    return named({ origin: `https://${formatDesktopServerHost(configuredHost)}:${String(port)}`, source: 'host' })
  }
  // The launcher that starts this deployment already names the address it is
  // reached on, so a build run from its environment needs no detection at all.
  const lanAddress = (environment.DSH_LAN_IP ?? '').trim()
  if (lanAddress !== '') {
    return named({ origin: `https://${formatDesktopServerHost(lanAddress)}:${String(port)}`, source: 'lan-ip' })
  }
  const [detected] = listDesktopServerHosts(options.interfaces)
  if (detected === undefined) return undefined
  return named({ origin: `https://${formatDesktopServerHost(detected)}:${String(port)}`, source: 'detected' })
}

/**
 * Ask one candidate origin whether anything is serving HTTPS there.
 * @param {string} origin Origin to probe.
 * @param {number} [timeoutMs] Bound on the attempt.
 * @returns {Promise<number | undefined>} The HTTP status, or undefined when nothing answered in time.
 */
export function probeDesktopServerOrigin(origin, timeoutMs = 3000) {
  return new Promise(resolve => {
    const attempt = request(`${origin}/auth/me`, { method: 'GET', rejectUnauthorized: false, timeout: timeoutMs }, response => {
      response.resume()
      resolve(response.statusCode)
    })
    attempt.on('timeout', () => { attempt.destroy() })
    // A refused connection, an unreachable host and a TLS failure all answer the
    // same question — nothing usable is there — so they share one outcome.
    attempt.on('error', () => { resolve(undefined) })
    attempt.end()
  })
}

/**
 * Choose the first candidate address that is actually serving, so a build bakes
 * the address dsh answers on rather than the first one the machine lists.
 * @param {readonly string[]} hosts Ordered candidate addresses.
 * @param {{ probe: (origin: string) => Promise<number | undefined>, port?: number, log?: (message: string) => void }} options Attempt per candidate, the port to render, and a line sink.
 * @returns {Promise<{ host: string, origin: string } | undefined>} The reachable host and its origin, or undefined when none answered.
 */
export async function selectReachableDesktopServerHost(hosts, options) {
  const port = options.port ?? DESKTOP_SERVER_DEFAULT_PORT
  const log = options.log ?? (() => {})
  for (const host of hosts) {
    const origin = `https://${formatDesktopServerHost(host)}:${String(port)}`
    const status = await options.probe(origin)
    log(`desktop package: server mode candidate ${origin} -> ${status === undefined ? 'no answer' : `HTTP ${String(status)}`}`)
    if (status !== undefined) return { host, origin }
  }
  return undefined
}

/**
 * Decide the server-mode default for one packaging run.
 *
 * Detection is verified rather than assumed: the address that answers is baked,
 * and a machine whose deployment is not up keeps the detected candidate and says
 * so, because failing a build over an unreachable default would be worse than
 * shipping one an operator can still correct from the client settings file.
 * @param {NodeJS.ProcessEnv} environment File-owned release settings.
 * @param {{ interfaces?: ReturnType<typeof networkInterfaces>, probe?: (origin: string) => Promise<number | undefined>, log?: (message: string) => void }} [options] Address table, attempt and line sink overrides.
 * @returns {Promise<{ serverMode: { origin: string, source: string, label?: string } | undefined, environment: NodeJS.ProcessEnv }>} The default to bake and the environment carrying its resolution.
 */
export async function resolveDesktopServerModeForBuild(environment, options = {}) {
  const log = options.log ?? (() => {})
  const resolved = resolveDesktopServerModeEnvironment(environment, options)
  if (resolved === undefined) {
    log('desktop package: server mode default disabled for this build')
    return { serverMode: undefined, environment }
  }
  if (resolved.source !== 'detected') {
    log(`desktop package: server mode default ${resolved.origin} (from ${resolved.source})`)
    return { serverMode: resolved, environment }
  }
  const port = resolvePort(environment.DSH_DESKTOP_SERVER_PORT)
  const selected = await selectReachableDesktopServerHost(listDesktopServerHosts(options.interfaces), {
    probe: options.probe ?? (origin => probeDesktopServerOrigin(origin)),
    port,
    log,
  })
  if (selected === undefined) {
    log(`desktop package: WARNING no LAN address answered on port ${String(port)}; baking the first candidate ${resolved.origin}`)
    return { serverMode: resolved, environment }
  }
  // The chosen host becomes an explicit setting, so the builder and every later
  // reader of this environment agree on one address instead of re-detecting it.
  return { serverMode: { ...resolved, origin: selected.origin }, environment: { ...environment, DSH_DESKTOP_SERVER_HOST: selected.host } }
}
