/**
 * Give this machine the model route the build was packaged with.
 *
 * Local mode runs the agent loop here, and the model it needs lives on the
 * deployment — the deployment holds the API key, and a user's machine neither has
 * one nor should be asked for one. Packaging bakes the route into the application
 * manifest; this puts it where the runtime reads it.
 *
 * The route goes into the profile's patch layer rather than `settings.yaml`,
 * because the two files differ in exactly the way that matters here. The base
 * bundle mounts the DeepSeek adapter with no configuration at all and resolves it
 * from the `llm-deepseek:` settings section, so a settings file that predates this
 * build — one the runtime itself created on first launch — has no such section and
 * leaves the client with no endpoint and the stock credential name. A patch
 * layer, by contrast, either configures the row or says nothing, and a machine
 * whose owner has configured the provider already says something.
 *
 * The credential is the one fact that lives in its own file, because it is not
 * configuration: `settings.yaml` names the reference, `.credentials.yaml` holds
 * the value.
 *
 * A deployment behind its own TLS terminator adds a third fact. The certificate
 * that terminator presents chains to an authority no machine trusts, and Node
 * reads no operating-system trust store, so the local Host — a separate process
 * from the shell that accepted the certificate for its window — refuses to
 * complete the handshake until it is told what to trust. The authority travels
 * inside the build for the same reason the route does: an installed client needs
 * no setup.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One deployment's model route, as packaging resolved it. */
export interface DesktopGatewayConfig {
  /** Deployment origin serving the gateway, for example `https://192.168.28.239:8443`. */
  readonly origin: string
  /** Model identifiers the gateway publishes; the first becomes the default. */
  readonly models: readonly string[]
  /** Gateway credential, absent when the build carried none. */
  readonly token?: string
  /** PEM certificate the deployment's terminator chains to, absent when the build carried none. */
  readonly certificateAuthority?: string
}

/** What one pass did, for the launch log. */
export interface DesktopGatewaySeed {
  /** Files written or extended. */
  readonly written: readonly string[]
  /** Files left untouched, with why. */
  readonly kept: readonly string[]
  /** Trust anchor the local Host must be given, when this build carried one. */
  readonly certificateAuthority?: string
}

/** Credential reference the patch names as the adapter's API-key source. */
const GATEWAY_CREDENTIAL = 'HQZ_GATEWAY_TOKEN'

/** Row id of the DeepSeek adapter in the base bundle. */
const ADAPTER_ROW = 'llm-deepseek'

/** Row id carrying the default model selection. */
const DEFAULT_MODEL_ROW = 'agent-default-model'

/** Trust-anchor file this application owns inside the profile directory. */
const CERTIFICATE_AUTHORITY_FILE = 'gateway-ca.crt'

/** A certificate block, which is what makes a file usable as a trust anchor. */
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/u

/**
 * Parse one manifest value.
 * @param value - `dshDesktopGateway` from the application manifest, if present.
 * @returns The route, or undefined when this build carries none or carries an unusable one.
 */
export function resolveDesktopGatewayConfig(value: unknown): DesktopGatewayConfig | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const origin = record.origin
  const models = record.models
  if (typeof origin !== 'string' || origin.trim() === '') return undefined
  if (!Array.isArray(models) || models.length === 0 || models.some(model => typeof model !== 'string')) return undefined
  const token = record.token
  if (token !== undefined && (typeof token !== 'string' || token.trim() === '')) return undefined
  let parsed: URL
  try { parsed = new URL(origin) } catch { return undefined }
  if (parsed.protocol !== 'https:') return undefined
  // An unusable authority costs this machine its model route if the whole route is
  // refused over it, and packaging already refuses to bake one that is not a
  // certificate. Keeping the route without it leaves a failure that names TLS.
  const authority = record.certificateAuthority
  const usableAuthority = typeof authority === 'string' && PEM_CERTIFICATE.test(authority) ? authority : undefined
  return {
    origin: parsed.origin,
    models: models as string[],
    ...(token === undefined ? {} : { token: token as string }),
    ...(usableAuthority === undefined ? {} : { certificateAuthority: usableAuthority }),
  }
}

/** Whether a patch document already configures a row, by row id. */
function configuresRow(patch: string, row: string): boolean {
  return new RegExp(`(?:^|\\n)\\s*-\\s*id:\\s*${row}\\s*(?:\\n|$)`, 'u').test(patch)
}

/** Whether a patch document carries anything beyond comments and an empty list. */
function hasRows(patch: string): boolean {
  return patch.split('\n').some(line => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#') && trimmed !== '[]'
  })
}

function patchBlock(config: DesktopGatewayConfig): string {
  const models = config.models.map(model => `      - id: ${model}`).join('\n')
  return [
    '# Written on first launch from the route this build was packaged with. Local mode',
    '# runs the agent loop on this machine and sends model requests to the deployment',
    '# gateway, so no AI key is stored here.',
    `- id: ${ADAPTER_ROW}`,
    '  config:',
    '    protocol: chat-completions',
    `    baseURL: ${config.origin}/llm/v1`,
    `    apiKeyEnv: ${GATEWAY_CREDENTIAL}`,
    '    models:',
    models,
    `- id: ${DEFAULT_MODEL_ROW}`,
    '  config:',
    '    provider: deepseek-official',
    `    model: ${config.models[0] ?? ''}`,
    '',
  ].join('\n')
}

function credentialsBlock(config: DesktopGatewayConfig): string {
  return [
    '# The gateway credential this build was packaged with. It authorizes the',
    "# deployment's own model quota, not an AI key.",
    'version: 1',
    'refs:',
    `  ${GATEWAY_CREDENTIAL}: ${config.token ?? ''}`,
    '',
  ].join('\n')
}

/**
 * Write the route into the profile patch layer, leaving a configured one alone.
 * @param path - the profile's `cordis.patch.yml`.
 * @param config - the route packaging baked.
 * @returns The path when this call wrote it, or undefined when it kept the existing document.
 */
function seedPatch(path: string, config: DesktopGatewayConfig): string | undefined {
  // A leading BOM is not content, and treating it as such would append a block
  // sequence after a flow sequence and produce two documents in one file.
  const existing = (existsSync(path) ? readFileSync(path, 'utf8') : '').replace(/^\uFEFF/u, '')
  if (configuresRow(existing, ADAPTER_ROW)) return undefined
  const block = patchBlock(config)
  let next: string
  if (hasRows(existing)) next = `${existing.trimEnd()}\n\n${block}`
  else {
    // Nothing configured. Keep whatever prose the file carries — provisioning
    // leaves a comment beside its empty list — and replace the list itself.
    const prose = existing.split('\n')
      .filter(line => line.trim() === '' || line.trim().startsWith('#'))
      .join('\n').trimEnd()
    next = prose === '' ? block : `${prose}\n\n${block}`
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, next, 'utf8')
  return path
}

/**
 * Add the credential to the document that holds it, keeping everything else.
 * @param path - the Harness home's `.credentials.yaml`.
 * @param config - the route packaging baked.
 * @returns The path when this call wrote it, or undefined when it needed nothing.
 */
function seedCredential(path: string, config: DesktopGatewayConfig): string | undefined {
  if (config.token === undefined) return undefined
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (new RegExp(`(?:^|\\n)\\s*${GATEWAY_CREDENTIAL}:`, 'u').test(existing)) return undefined
  let next: string
  if (existing.trim() === '') next = credentialsBlock(config)
  else if (/(?:^|\n)refs:[ \t]*(?:\n|$)/u.test(existing)) {
    // Same document, one more reference under the list it already has.
    next = existing.replace(/((?:^|\n)refs:[ \t]*\n)/u, `$1  ${GATEWAY_CREDENTIAL}: ${config.token}\n`)
  } else next = `${existing.trimEnd()}\nrefs:\n  ${GATEWAY_CREDENTIAL}: ${config.token}\n`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, next, 'utf8')
  return path
}

/**
 * Put the route and its credential where the runtime reads them.
 * @param dshHome - Harness home the local Host reads.
 * @param config - the route packaging baked.
 * @returns Which files were written and which were kept, and the trust anchor to pass on.
 */
export function seedDesktopGateway(dshHome: string, config: DesktopGatewayConfig): DesktopGatewaySeed {
  const patch = join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  const credentials = join(dshHome, '.credentials.yaml')
  const written: string[] = []
  const kept: string[] = []
  const patchResult = seedPatch(patch, config)
  if (patchResult === undefined) kept.push(patch)
  else written.push(patchResult)
  const credentialResult = seedCredential(credentials, config)
  if (config.token !== undefined) {
    if (credentialResult === undefined) kept.push(credentials)
    else written.push(credentialResult)
  }
  // A build that carries no authority of its own leaves whatever one provisioning
  // put here in place, which is how a machine pointed at another deployment — one
  // whose certificate this build never saw — still trusts it.
  const authority = config.certificateAuthority === undefined
    ? existingCertificateAuthority(dshHome, kept)
    : seedCertificateAuthority(dshHome, config.certificateAuthority, written, kept)
  return { written, kept, ...(authority === undefined ? {} : { certificateAuthority: authority }) }
}

/**
 * Write the deployment's certificate authority beside the profile that uses it.
 *
 * Unlike the patch, this file is not the owner's to configure: the deployment
 * decides what signs its certificate, and a machine that kept an older authority
 * would refuse the current one. The copy is therefore the build's, and a file
 * that already holds it is left alone to keep the launch log honest.
 * @param dshHome - Harness home the local Host reads.
 * @param authority - PEM certificate packaging baked.
 * @param written - Files this pass wrote, appended to.
 * @param kept - Files this pass left alone, appended to.
 * @returns The path the local Host must be pointed at.
 */
function seedCertificateAuthority(dshHome: string, authority: string, written: string[], kept: string[]): string {
  const path = certificateAuthorityPath(dshHome)
  if (existsSync(path) && readFileSync(path, 'utf8') === authority) kept.push(path)
  else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, authority, 'utf8')
    written.push(path)
  }
  return path
}

/**
 * Find the authority a machine was provisioned with.
 * @param dshHome - Harness home the local Host reads.
 * @param kept - Files this pass left alone, appended to.
 * @returns The path when this machine already holds a usable certificate.
 */
function existingCertificateAuthority(dshHome: string, kept: string[]): string | undefined {
  const path = certificateAuthorityPath(dshHome)
  if (!existsSync(path) || !PEM_CERTIFICATE.test(readFileSync(path, 'utf8'))) return undefined
  kept.push(path)
  return path
}

function certificateAuthorityPath(dshHome: string): string {
  return join(dshHome, 'profiles', 'desktop', CERTIFICATE_AUTHORITY_FILE)
}
