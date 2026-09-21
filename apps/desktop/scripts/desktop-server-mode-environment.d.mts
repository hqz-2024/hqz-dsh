/** Server-mode default baked into a packaged client's application manifest. */
export interface DesktopServerModeDefault {
  origin: string
  /** Which input produced the origin, so a caller knows whether to verify it. */
  source: 'origin' | 'host' | 'lan-ip' | 'detected'
  label?: string
}

/** Default HTTPS port of a deployment published through its LAN reverse proxy. */
export const DESKTOP_SERVER_DEFAULT_PORT: number

/**
 * The part of one adapter address this module reads.
 *
 * Declared instead of reusing `NetworkInterfaceInfo`: the platform union there
 * requires fields (`scopeid`, `cidr`) that decide nothing about which address a
 * client can reach, and a caller with an address table of its own should not have
 * to invent them.
 */
export interface DesktopServerInterfaceAddress {
  address: string
  family: string | number
  internal: boolean
}

/** Address table keyed by interface name, as `networkInterfaces()` reports one. */
export type DesktopServerInterfaceTable = Record<string, readonly DesktopServerInterfaceAddress[]>

/**
 * List the addresses a LAN client could reach this machine on.
 * @param interfaces Address table, defaulting to this machine's.
 * @returns Ordered candidate addresses, without loopback or link-local entries.
 */
export function listDesktopServerHosts(interfaces?: DesktopServerInterfaceTable): string[]

/**
 * Render one host as the authority of an origin.
 * @param host IPv4 address, IPv6 address, or host name.
 * @returns The authority, with IPv6 brackets added when absent.
 */
export function formatDesktopServerHost(host: string): string

/**
 * Validate one configured deployment origin.
 * @param value Candidate origin text.
 * @param name Setting name, for the failure message.
 * @returns The normalized origin.
 */
export function resolveDesktopServerOrigin(value: string, name: string): string

/**
 * Resolve the server-mode default from release settings and this machine.
 * @param environment File-owned release settings.
 * @param options Address table override, for tests.
 * @returns The default to bake, or undefined when this deployment bakes none.
 */
export function resolveDesktopServerModeEnvironment(
  environment: NodeJS.ProcessEnv,
  options?: { interfaces?: DesktopServerInterfaceTable },
): DesktopServerModeDefault | undefined

/**
 * Ask one candidate origin whether anything is serving HTTPS there.
 * @param origin Origin to probe.
 * @param timeoutMs Bound on the attempt.
 * @returns The HTTP status, or undefined when nothing answered in time.
 */
export function probeDesktopServerOrigin(origin: string, timeoutMs?: number): Promise<number | undefined>

/**
 * Choose the first candidate address that is actually serving.
 * @param hosts Ordered candidate addresses.
 * @param options Attempt per candidate, the port to render, and a line sink.
 * @returns The reachable host and its origin, or undefined when none answered.
 */
export function selectReachableDesktopServerHost(
  hosts: readonly string[],
  options: { probe: (origin: string) => Promise<number | undefined>, port?: number, log?: (message: string) => void },
): Promise<{ host: string, origin: string } | undefined>

/**
 * Decide the server-mode default for one packaging run, verifying a detected address.
 * @param environment File-owned release settings.
 * @param options Address table, attempt and line sink overrides.
 * @returns The default to bake and the environment carrying its resolution.
 */
export function resolveDesktopServerModeForBuild(
  environment: NodeJS.ProcessEnv,
  options?: {
    interfaces?: DesktopServerInterfaceTable
    probe?: (origin: string) => Promise<number | undefined>
    log?: (message: string) => void
  },
): Promise<{ serverMode: DesktopServerModeDefault | undefined, environment: NodeJS.ProcessEnv }>
