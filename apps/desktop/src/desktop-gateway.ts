/**
 * Seed this machine's Harness home with the model route the build was given.
 *
 * Local mode runs the agent loop on this machine, and the model it needs lives on
 * the deployment — the deployment holds the API key, and a user's machine neither
 * has one nor should be asked for one. Packaging therefore bakes the route into
 * the application manifest, and this writes it where the runtime reads it.
 *
 * It writes only what is missing. A machine provisioned by hand, or one whose
 * owner has since pointed it somewhere else, keeps what it has: this is a
 * first-run default, not a policy that reasserts itself on every launch.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One deployment's model route, as packaging resolved it. */
export interface DesktopGatewayConfig {
  /** Deployment origin serving the gateway, for example `https://192.168.28.239:8443`. */
  readonly origin: string
  /** Model identifiers the gateway publishes. */
  readonly models: readonly string[]
  /** Gateway credential, absent when the build carried none. */
  readonly token?: string
}

/** What one seeding pass did, for the launch log. */
export interface DesktopGatewaySeed {
  /** Files written because they did not exist. */
  readonly written: readonly string[]
  /** Files left untouched because they already existed. */
  readonly kept: readonly string[]
}

/** Credential reference the settings file names as its API-key source. */
const GATEWAY_CREDENTIAL = 'HQZ_GATEWAY_TOKEN'

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
  return {
    origin: parsed.origin,
    models: models as string[],
    ...(token === undefined ? {} : { token: token as string }),
  }
}

function settingsText(config: DesktopGatewayConfig): string {
  const models = config.models.map(model => `    - id: ${model}`).join('\n')
  return [
    '# Written on first launch from the route this build was packaged with.',
    '# Local mode runs the agent loop on this machine and sends model requests to the',
    '# deployment gateway, so no AI key is stored here.',
    'llm-deepseek:',
    '  protocol: chat-completions',
    `  baseURL: ${config.origin}/llm/v1`,
    `  apiKeyEnv: ${GATEWAY_CREDENTIAL}`,
    '  models:',
    models,
    'agent-default-model:',
    '  provider: deepseek-official',
    `  model: ${config.models[0] ?? ''}`,
    'permission:',
    '  defaultPreset: danger-full-access',
    '',
  ].join('\n')
}

function credentialsText(config: DesktopGatewayConfig): string {
  return [
    '# The gateway credential this build was packaged with. It authorizes the',
    '# deployment\'s own model quota, not an AI key.',
    'version: 1',
    'refs:',
    `  ${GATEWAY_CREDENTIAL}: ${config.token ?? ''}`,
    '',
  ].join('\n')
}

/**
 * Write the route where the runtime reads it, skipping anything already there.
 * @param dshHome - Harness home the local Host reads.
 * @param config - the route packaging baked.
 * @returns Which files were written and which were kept.
 */
export function seedDesktopGateway(dshHome: string, config: DesktopGatewayConfig): DesktopGatewaySeed {
  const targets: Array<readonly [string, string]> = [
    [join(dshHome, 'settings.yaml'), settingsText(config)],
    ...(config.token === undefined ? [] : [[join(dshHome, '.credentials.yaml'), credentialsText(config)] as const]),
  ]
  const written: string[] = []
  const kept: string[] = []
  for (const [path, contents] of targets) {
    if (existsSync(path)) { kept.push(path); continue }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, 'utf8')
    written.push(path)
  }
  return { written, kept }
}
