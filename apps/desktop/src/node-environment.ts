/** Electron Node-mode startup, with private shell launchers scoped to package installation. */

import { delimiter } from 'node:path'

/**
 * Select Electron's Node mode and the shell launcher used by package scripts.
 * @param executable - Electron executable running the application.
 * @param bin - Directory containing the node shell launcher.
 * @param environment - Caller environment preserved for plugin execution.
 * @returns Environment for a Node-mode child process.
 */
export function desktopNodeEnvironment(executable: string, bin: string | undefined, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    ELECTRON_RUN_AS_NODE: '1',
    ...(bin === undefined ? {} : { DSH_DESKTOP_NODE_EXECUTABLE: executable, PATH: `${bin}${delimiter}${environment.PATH ?? ''}` }),
  }
}

/**
 * Add the deployment's certificate authority to the trust store a Node process starts with.
 *
 * Node reads no operating-system trust store, and `NODE_EXTRA_CA_CERTS` is read once
 * while it boots, so a deployment behind its own TLS terminator is reachable only
 * when the variable is already in the environment. Accepting that certificate in the
 * shell covers the shell's own requests; the Host that sends model requests is a
 * different process and needs the anchor for itself.
 * @param environment - Environment for a Node-mode child process.
 * @param authority - Certificate file to add, absent when this build carries none.
 * @returns The environment such a child must start with.
 */
export function withCertificateAuthority(environment: NodeJS.ProcessEnv, authority: string | undefined): NodeJS.ProcessEnv {
  if (authority === undefined) return environment
  return { ...environment, NODE_EXTRA_CA_CERTS: authority }
}
