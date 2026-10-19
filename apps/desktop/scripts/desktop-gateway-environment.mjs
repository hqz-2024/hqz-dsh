/**
 * Resolve the model route a packaged client uses in local mode.
 *
 * Local mode runs the agent loop on the user's own machine, so a client that
 * cannot reach a model is a client that asks for an API key nobody has — the
 * deployment holds the key, not the machine. The route is therefore a fact of the
 * deployment, exactly like the address server mode connects to, and packaging
 * bakes it into the application manifest as `dshDesktopGateway`.
 *
 * The token is the one piece that is not a plain fact: it is the credential the
 * deployment's gateway issued. Baking it makes an installed client work with no
 * setup at all, which is the point of a packaged client, and the installer never
 * leaves the deployment's own authenticated download page. Leaving the setting
 * empty keeps the credential out of the artifact and leaves each machine to
 * `client/provision-client.ps1`.
 *
 * A deployment behind a TLS terminator is one more fact of the same kind. The
 * certificate the terminator presents is signed by its own authority, which no
 * operating system trusts, and Node reads no operating-system trust store at all.
 * The shell accepts the deployment's certificate for its own windows, but the
 * process that actually sends model requests is a separate Node process the shell
 * starts, so the trust anchor has to travel with the artifact too.
 */

import { readFileSync } from 'node:fs'

/** A file that starts and ends with a certificate block, so a key or a stray file is refused. */
const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/u

/** Default model identifiers the deployment's gateway publishes. */
export const DESKTOP_GATEWAY_DEFAULT_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

/** Credential reference the client's settings.yaml names as its API-key source. */
export const DESKTOP_GATEWAY_CREDENTIAL = 'HQZ_GATEWAY_TOKEN'

/**
 * Validate one configured origin.
 * @param value Candidate origin text.
 * @param name Setting name, for the failure message.
 * @returns The normalized origin.
 * @throws when the value is not an HTTPS origin without credentials, path, query or fragment.
 */
export function resolveDesktopGatewayOrigin(value, name) {
  let url
  try { url = new URL(value) } catch { throw new Error(`desktop package: ${name} requires an HTTPS origin`) }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`desktop package: ${name} requires an HTTPS origin without credentials, path, query, or fragment`)
  }
  return url.origin
}

/**
 * Read the trust anchor a client needs to reach this gateway.
 *
 * A named file is a deliberate setting, so an unreadable or non-certificate one
 * stops the build instead of shipping a client that cannot complete a handshake.
 * @param {NodeJS.ProcessEnv} environment File-owned release settings.
 * @returns {string | undefined} Normalized PEM text, or undefined when the build names none.
 * @throws when the setting is present but not a readable PEM certificate file.
 */
export function resolveDesktopGatewayCertificateAuthority(environment) {
  const path = (environment.DSH_DESKTOP_GATEWAY_CA_FILE ?? '').trim()
  if (path === '') return undefined
  let contents
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`desktop package: cannot read DSH_DESKTOP_GATEWAY_CA_FILE ${path}`)
  }
  const pem = contents.replace(/\r\n?/gu, '\n').trim()
  if (!PEM_CERTIFICATE.test(pem)) {
    throw new Error(`desktop package: DSH_DESKTOP_GATEWAY_CA_FILE ${path} is not a PEM certificate`)
  }
  return `${pem}\n`
}

/**
 * Resolve the local-mode model route from release settings.
 *
 * The gateway lives on the deployment server mode connects to, so its origin
 * defaults to that one and an operator only names it to split the two.
 * @param {NodeJS.ProcessEnv} environment File-owned release settings.
 * @param {string | undefined} serverOrigin Origin resolved for server mode, if any.
 * @returns {{ origin: string, models: string[], token?: string, certificateAuthority?: string } | undefined} The route to bake, or undefined when this deployment bakes none.
 * @throws when a value is present but unusable.
 */
export function resolveDesktopGatewayEnvironment(environment, serverOrigin) {
  const mode = (environment.DSH_DESKTOP_GATEWAY ?? '').trim().toLowerCase()
  if (mode === 'none') return undefined
  if (mode !== '' && mode !== 'auto') {
    throw new Error("desktop package: DSH_DESKTOP_GATEWAY must be 'auto' or 'none'")
  }
  const configured = (environment.DSH_DESKTOP_GATEWAY_ORIGIN ?? '').trim()
  const origin = configured === ''
    ? serverOrigin
    : resolveDesktopGatewayOrigin(configured, 'DSH_DESKTOP_GATEWAY_ORIGIN')
  // No origin means this deployment has nothing to route through: a build without
  // server mode and without an explicit gateway bakes no model route at all.
  if (origin === undefined) return undefined
  const configuredModels = (environment.DSH_DESKTOP_GATEWAY_MODELS ?? '').trim()
  const models = configuredModels === ''
    ? [...DESKTOP_GATEWAY_DEFAULT_MODELS]
    : configuredModels.split(',').map(model => model.trim()).filter(model => model !== '')
  if (models.length === 0) throw new Error('desktop package: DSH_DESKTOP_GATEWAY_MODELS must name at least one model')
  const token = (environment.DSH_DESKTOP_GATEWAY_TOKEN ?? '').trim()
  const certificateAuthority = resolveDesktopGatewayCertificateAuthority(environment)
  return {
    origin,
    models,
    ...(token === '' ? {} : { token }),
    ...(certificateAuthority === undefined ? {} : { certificateAuthority }),
  }
}
