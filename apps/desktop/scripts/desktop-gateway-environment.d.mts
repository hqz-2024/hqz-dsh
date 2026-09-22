/** Model route a packaged client uses in local mode. */
export interface DesktopGatewayDefault {
  origin: string
  models: string[]
  /** Gateway credential, present when the build was given one. */
  token?: string
}

/** Default model identifiers the deployment's gateway publishes. */
export const DESKTOP_GATEWAY_DEFAULT_MODELS: string[]

/** Credential reference the client's settings.yaml names as its API-key source. */
export const DESKTOP_GATEWAY_CREDENTIAL: string

/**
 * Validate one configured origin.
 * @param value Candidate origin text.
 * @param name Setting name, for the failure message.
 * @returns The normalized origin.
 */
export function resolveDesktopGatewayOrigin(value: string, name: string): string

/**
 * Resolve the local-mode model route from release settings.
 * @param environment File-owned release settings.
 * @param serverOrigin Origin resolved for server mode, if any.
 * @returns The route to bake, or undefined when this deployment bakes none.
 */
export function resolveDesktopGatewayEnvironment(
  environment: NodeJS.ProcessEnv,
  serverOrigin: string | undefined,
): DesktopGatewayDefault | undefined
