/**
 * Remote-server mode for the Desktop shell.
 *
 * Desktop normally loads the Web application from the Host it starts itself.
 * This module describes the second mode: the same window loading an existing
 * deployment's Web UI over the network, with that deployment owning accounts,
 * workspaces, sessions and the model route.
 *
 * The two modes are one window; only the document differs. What this module
 * owns is everything decided before a document loads: where the server is,
 * whether its certificate is the one the deployment published, which navigation
 * a document this shell did not author may perform, and which mode the window
 * shows. Starting the local Host is the caller's business, and local mode keeps
 * running underneath so switching back costs one page load.
 * @module server-mode
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'

/** The two documents one Desktop window can show. */
export const DESKTOP_MODES = ['local', 'server'] as const

/** Which deployment the window is currently showing. */
export type DesktopMode = (typeof DESKTOP_MODES)[number]

/** Whether `value` names a mode. */
export function isDesktopMode(value: unknown): value is DesktopMode {
  return typeof value === 'string' && (DESKTOP_MODES as readonly string[]).includes(value)
}

/** Validated description of the deployment's Web UI. */
export interface DesktopServerModeConfig {
  /**
   * Absolute origin of the deployment's Web UI, for example
   * `https://192.168.28.239:8443`. Only the origin is kept: a path, query or
   * credentials in the configured value would silently change which document
   * the window adopts.
   */
  readonly origin: string
  /**
   * SHA-256 fingerprint of the expected server certificate, in the
   * `AA:BB:…` form `X509Certificate.fingerprint256` produces. Present means the
   * certificate is pinned and any other certificate is refused, which is what
   * makes trusting a self-signed deployment safe against a later substitution.
   * Absent accepts the deployment's self-signed certificate for this origin and
   * records the fingerprint it saw.
   */
  readonly certificateSha256?: string
  /** Optional display name for the deployment, shown in the window title and the mode banner. */
  readonly label?: string
}

/** Where a candidate configuration came from, for diagnostics. */
export interface ResolvedServerModeConfig extends DesktopServerModeConfig {
  /** Human-readable source of the winning configuration. */
  readonly source: string
}

/**
 * Normalize a certificate fingerprint for comparison.
 *
 * Accepts the colon-separated uppercase form `X509Certificate` emits as well as
 * bare hex, and ignores surrounding whitespace. Anything that is not 32 bytes of
 * hex is rejected rather than compared, because a fingerprint that cannot match
 * would otherwise read as "pinned" while accepting nothing.
 * @param value - candidate fingerprint text.
 * @returns the canonical colon-separated uppercase hex, or undefined when unusable.
 */
export function normalizeFingerprint(value: string): string | undefined {
  const bare = value.trim().replaceAll(':', '').replaceAll(/\s+/gu, '').toUpperCase()
  if (!/^[0-9A-F]{64}$/u.test(bare)) return undefined
  return bare.match(/.{2}/gu)?.join(':')
}

/**
 * SHA-256 fingerprint of a PEM certificate, in the form used for pinning.
 * @param pem - certificate data as Electron's `Certificate.data` supplies it.
 * @returns the colon-separated uppercase fingerprint.
 */
export function certificateFingerprint256(pem: string): string {
  return new X509Certificate(pem).fingerprint256
}

/**
 * Parse one candidate configuration object.
 * @param input - value from a manifest field, an environment variable or the user file.
 * @param source - where the value came from, for diagnostics.
 * @returns the validated configuration, or undefined when the value is absent.
 * @throws when the value is present but unusable: a configured server that
 * silently fell back to local mode would leave the user in the wrong deployment
 * without ever seeing an error.
 */
export function resolveDesktopServerModeConfig(input: unknown, source: string): ResolvedServerModeConfig | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`desktop server mode: ${source} must be an object`)
  }
  const value = input as Record<string, unknown>
  const origin = value.origin
  if (typeof origin !== 'string' || origin.trim() === '') {
    throw new Error(`desktop server mode: ${source} must declare a nonempty origin`)
  }
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error(`desktop server mode: ${source} origin is not a URL: ${origin}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`desktop server mode: ${source} origin must use https, received ${parsed.protocol}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`desktop server mode: ${source} origin must not carry credentials`)
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`desktop server mode: ${source} origin must be an origin without a path, query or fragment`)
  }
  const label = value.label
  if (label !== undefined && (typeof label !== 'string' || label.trim() === '')) {
    throw new Error(`desktop server mode: ${source} label must be a nonempty string when present`)
  }
  const pin = value.certificateSha256
  const normalizedPin = pin === undefined || typeof pin !== 'string' ? undefined : normalizeFingerprint(pin)
  if (pin !== undefined && normalizedPin === undefined) {
    throw new Error(`desktop server mode: ${source} certificateSha256 must be a SHA-256 fingerprint`)
  }
  return {
    origin: parsed.origin,
    ...(normalizedPin === undefined ? {} : { certificateSha256: normalizedPin }),
    ...(label === undefined ? {} : { label: label.trim() }),
    source,
  }
}

/** Files the shell reads for the deployment and the selected mode. */
export interface DesktopClientPaths {
  /** JSON file a person may edit to point the client at another deployment. */
  readonly settingsFile: string
  /** JSON file the shell writes the selected mode into, so it survives a restart. */
  readonly modeFile: string
}

/**
 * Parse one JSON document.
 * @param path - file to read.
 * @returns the parsed value, or undefined when the file is absent.
 * @throws when the file exists but cannot be read or parsed: a settings file
 * that silently did nothing would leave the user in local mode with no
 * indication of why the deployment they configured was ignored.
 */
function readJson(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`desktop client state: cannot read ${path}: ${String(error)}`, { cause: error })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`desktop client state: ${path} is not valid JSON: ${String(error)}`, { cause: error })
  }
}

/**
 * Parse the environment override.
 *
 * The variable carries the deployment, but its name reads like a mode
 * selector, so a bare `local` is the mistake to expect from it. That value is
 * reported as the variable holding something other than a deployment, together
 * with what it should hold and how local mode is reached, rather than as
 * whatever `JSON.parse` happened to say about the first character.
 * @param value - raw `DSH_DESKTOP_SERVER_MODE`, usually only set in development.
 * @returns the parsed value, or undefined when unset or blank.
 * @throws when the value is present and is not JSON.
 */
function parseEnvironmentValue(value: string | undefined): unknown {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch (error) {
    throw new Error(
      `desktop server mode: DSH_DESKTOP_SERVER_MODE is not valid JSON (received ${JSON.stringify(trimmed)}); `
      + 'it carries the deployment, for example {"origin":"https://deployment.example:8443"}, and an unset '
      + 'variable starts in local mode',
      { cause: error },
    )
  }
}

/**
 * Resolve the deployment the client should offer in server mode.
 *
 * Precedence is override, then the person's own file, then the packaged
 * default: an operator can repoint one machine without repackaging, and a
 * release can carry a default for everyone else. A value that is present but
 * unusable throws at whichever layer supplied it — including the settings file
 * — because falling through would silently connect the user to a deployment
 * other than the one they configured.
 * @param options.manifestValue - `dshDesktopServerMode` from the application manifest.
 * @param options.environmentValue - raw `DSH_DESKTOP_SERVER_MODE`, usually only set in development.
 * @param options.settingsFile - user-editable JSON file whose `server` member is a candidate.
 * @returns the winning configuration with its source, or undefined when none is configured.
 */
export function resolveServerModeConfig(options: {
  readonly manifestValue: unknown
  readonly environmentValue: string | undefined
  readonly settingsFile: string
}): ResolvedServerModeConfig | undefined {
  const environment = parseEnvironmentValue(options.environmentValue)
  const userFile = readJson(options.settingsFile) as { server?: unknown } | undefined
  return resolveDesktopServerModeConfig(environment, 'DSH_DESKTOP_SERVER_MODE')
    ?? resolveDesktopServerModeConfig(userFile?.server, options.settingsFile)
    ?? resolveDesktopServerModeConfig(options.manifestValue, 'the application manifest')
}

/**
 * The mode the previous run left selected.
 *
 * A stored mode that cannot be read, or that names something other than the two
 * modes, resolves to local: the local deployment is the one that always exists,
 * so a damaged preference must not strand the window on a server it cannot
 * reach.
 * @param modeFile - file the shell wrote on the previous switch, if any.
 * @returns the mode to start in.
 */
export function readDesktopMode(modeFile: string): DesktopMode {
  let stored: { mode?: unknown } | undefined
  try {
    stored = readJson(modeFile) as { mode?: unknown } | undefined
  } catch {
    // A preference the shell itself wrote and can no longer read is not worth
    // failing a launch over; the local deployment always exists.
    stored = undefined
  }
  return isDesktopMode(stored?.mode) ? stored.mode : 'local'
}

/**
 * Persist the selected mode for the next launch.
 *
 * A failed write is reported rather than thrown: the switch has already
 * happened in this window, and refusing it because a preference could not be
 * stored would be worse than starting in local mode next time.
 * @param modeFile - file to write.
 * @param mode - the mode now shown.
 * @returns the failure, or undefined when the write succeeded.
 */
export function writeDesktopMode(modeFile: string, mode: DesktopMode): Error | undefined {
  try {
    writeFileSync(modeFile, `${JSON.stringify({ mode }, undefined, 2)}\n`, 'utf8')
    return undefined
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/** Outcome of one TLS trust decision, with the reason the shell logs. */
export interface CertificateDecision {
  readonly accept: boolean
  /** Fingerprint actually presented, or undefined when the certificate could not be read. */
  readonly fingerprint?: string
  /** Operator-facing reason; never a credential. */
  readonly reason: string
}

/**
 * Decide whether to trust a certificate the network stack rejected.
 *
 * The trust question is scoped to the configured origin: another host's failure
 * is never accepted here, and a pinned deployment accepts only the pinned
 * certificate. Without a pin the deployment's self-signed certificate is
 * accepted for its own origin — the same trust a client gives by installing the
 * deployment's root certificate — and the fingerprint is reported so an
 * operator can pin it afterwards.
 *
 * The fingerprint is an argument rather than read from Electron's certificate
 * here, so the decision is a pure function of the three facts it turns on and
 * the caller owns the parsing step that can fail.
 * @param config - the configured deployment.
 * @param url - URL whose load reported the certificate error.
 * @param fingerprint - SHA-256 fingerprint of the presented certificate, or
 * undefined when the caller could not read one.
 */
export function decideServerCertificate(
  config: DesktopServerModeConfig,
  url: string,
  fingerprint: string | undefined,
): CertificateDecision {
  let requested: URL
  try {
    requested = new URL(url)
  } catch {
    return { accept: false, reason: `unreadable URL for a certificate error: ${url}` }
  }
  if (requested.origin !== config.origin) {
    return { accept: false, reason: `certificate error outside ${config.origin}: ${requested.origin}` }
  }
  if (fingerprint === undefined) {
    return { accept: false, reason: `unreadable certificate for ${config.origin}` }
  }
  if (config.certificateSha256 !== undefined) {
    return config.certificateSha256 === fingerprint
      ? { accept: true, fingerprint, reason: `pinned certificate accepted for ${config.origin}` }
      : { accept: false, fingerprint, reason: `certificate for ${config.origin} does not match the pinned fingerprint` }
  }
  return { accept: true, fingerprint, reason: `self-signed certificate accepted for ${config.origin}; pin ${fingerprint} to require it` }
}

/**
 * Whether a navigation is the server document or something that document may do
 * inside itself.
 *
 * Server mode loads a document this shell did not author, so the rule is origin
 * containment rather than an allowlist of paths: same-origin navigations stay in
 * the window — a single-page application rewrites its own URL constantly — while
 * every other destination is handed to the operating system's browser.
 * `about:blank` is admitted because Chromium opens it for a window's first
 * document.
 * @param config - the configured deployment, or undefined when none is configured.
 * @param url - navigation target.
 */
export function serverNavigationAllowed(config: DesktopServerModeConfig | undefined, url: string): boolean {
  if (config === undefined) return false
  if (url === 'about:blank') return true
  try {
    return new URL(url).origin === config.origin
  } catch {
    return false
  }
}
