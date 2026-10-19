/**
 * Periodic archiving of this machine's local sessions.
 *
 * The client half of the archive pipeline is `client/export-session.mjs`, which
 * provisioning places under `$DSH_HOME/client/`. This module does not reimplement
 * it: it runs that script on a timer with the shell's own Node, so the machine
 * that talks to the deployment and the transcript that reaches it are one
 * implementation rather than two that drift.
 *
 * A machine that was never provisioned for archiving has no script, and nothing
 * is scheduled — the desktop application must not acquire a network habit from
 * a file it did not ship.
 *
 * Archiving never blocks or breaks the application: one run at a time, a bounded
 * deadline, and every failure logged instead of raised. Sessions are durable, so
 * a missed run costs nothing that the next one will not pick up.
 * @module session-archive
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { desktopNodeEnvironment } from './node-environment.ts'

/** Default seconds between archive runs, matching the update poll's order of magnitude. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Shortest accepted interval; below this the knob is a mistake, not a schedule. */
const MIN_INTERVAL_MS = 10_000

/** Default deadline for one run. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** How long after startup the first run waits, so archive traffic never competes with boot. */
const FIRST_RUN_DELAY_MS = 60_000

/** Validated archiving schedule. */
export interface SessionArchiveConfig {
  /** Absolute path of the export script provisioning placed on this machine. */
  readonly script: string
  /** Milliseconds between runs. */
  readonly intervalMs: number
  /** Deadline for one run. */
  readonly timeoutMs: number
}

/** What one run reported. */
export interface SessionArchiveRun {
  /** Whether the script exited successfully. */
  readonly ok: boolean
  /** Exit code, or undefined when the child was killed. */
  readonly code?: number
  /** The script's stdout and stderr, bounded. */
  readonly output: string
}

/**
 * Read one positive integer setting.
 * @param value - raw setting.
 * @param name - setting name for the diagnostic.
 * @param minimum - smallest accepted value.
 * @returns the value, or undefined when unset or unusable.
 */
function positiveInteger(value: string | undefined, name: string, minimum: number): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > 2_147_483_647) {
    console.warn(`desktop session archive: ignoring ${name}=${value}; expected an integer from ${String(minimum)} through 2147483647`)
    return undefined
  }
  return parsed
}

/**
 * Resolve the archiving schedule for this machine.
 *
 * Two facts must agree before anything is scheduled, because either alone would
 * start work the machine was never configured for: the export script exists
 * (provisioning put it there) **and** a destination is configured — the
 * `archive.json` provisioning writes beside it, or an explicit
 * `HQZ_ARCHIVE_ORIGIN`. The script itself resolves the same destination the same
 * way, so the switch and the run cannot disagree about where archives go.
 *
 * An explicit `DSH_DESKTOP_ARCHIVE_INTERVAL_MS=0` turns the timer off without
 * removing the machine's ability to run one on demand.
 * @param options.dshHome - the Harness home this application owns the sessions of.
 * @param options.environment - process environment carrying the overrides.
 * @returns the schedule, or undefined when this machine does not archive.
 */
export function resolveSessionArchiveConfig(options: {
  readonly dshHome: string
  readonly environment: NodeJS.ProcessEnv
}): SessionArchiveConfig | undefined {
  const configuredScript = options.environment.DSH_DESKTOP_ARCHIVE_SCRIPT
  const script = configuredScript !== undefined && configuredScript.trim() !== ''
    ? configuredScript.trim()
    : join(options.dshHome, 'client', 'export-session.mjs')
  if (!existsSync(script)) return undefined
  const destination = options.environment.HQZ_ARCHIVE_ORIGIN
  const hasDestination = (destination !== undefined && destination.trim() !== '')
    || existsSync(join(options.dshHome, 'archive.json'))
  if (!hasDestination) return undefined
  const raw = options.environment.DSH_DESKTOP_ARCHIVE_INTERVAL_MS
  if (raw !== undefined && raw.trim() === '0') return undefined
  return {
    script,
    intervalMs: positiveInteger(raw, 'DSH_DESKTOP_ARCHIVE_INTERVAL_MS', MIN_INTERVAL_MS) ?? DEFAULT_INTERVAL_MS,
    timeoutMs: positiveInteger(options.environment.DSH_DESKTOP_ARCHIVE_TIMEOUT_MS, 'DSH_DESKTOP_ARCHIVE_TIMEOUT_MS', 1000) ?? DEFAULT_TIMEOUT_MS,
  }
}

/**
 * The archive timer this application owns.
 *
 * One instance per process. `start()` schedules, `dispose()` stops, and
 * `runNow()` exists for the menu action and for tests; all three share the single
 * in-flight guard, so a manual run never races a scheduled one.
 */
export class SessionArchive {
  private timer: NodeJS.Timeout | undefined
  private running: Promise<SessionArchiveRun> | undefined
  private disposed = false

  /**
   * @param node - the Node executable to run the script with.
   * @param config - the validated schedule.
   * @param dshHome - the Harness home whose sessions this run archives.
   * @param environment - environment the child inherits.
   */
  constructor(
    private readonly node: string,
    private readonly config: SessionArchiveConfig,
    private readonly dshHome: string,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  /** Begin the schedule; the first run waits so it never competes with startup. */
  start(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setTimeout(() => { this.tick() }, FIRST_RUN_DELAY_MS)
    // A timer must never hold the process open on its own.
    this.timer.unref?.()
  }

  /** Stop the schedule. A run already in flight is left to finish or time out. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private tick(): void {
    this.timer = undefined
    void this.runNow().finally(() => {
      if (this.disposed) return
      this.timer = setTimeout(() => { this.tick() }, this.config.intervalMs)
      this.timer.unref?.()
    })
  }

  /**
   * Run the export script once.
   * @returns what the run reported; never rejects, because a failed archive is
   * a log line rather than an application fault.
   */
  runNow(): Promise<SessionArchiveRun> {
    if (this.running !== undefined) return this.running
    const running = this.spawnOnce().catch((error: unknown) => ({
      ok: false,
      output: `desktop session archive: ${String(error instanceof Error ? error.message : error)}`,
    })).finally(() => {
      if (this.running === running) this.running = undefined
    })
    this.running = running
    return running
  }

  /** Spawn the script, collect its output, and enforce the deadline. */
  private spawnOnce(): Promise<SessionArchiveRun> {
    return new Promise((resolve) => {
      const child = spawn(this.node, [this.config.script, '--pending'], {
        env: desktopNodeEnvironment(this.node, undefined, {
          ...this.environment,
          // The script derives the archive origin and token from the Harness home;
          // stating it keeps the child archiving the sessions this application owns
          // even when the environment that launched the shell never set it.
          DSH_HOME: this.dshHome,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let output = ''
      const collect = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-8_000) }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      const deadline = setTimeout(() => {
        output = `${output}\ndesktop session archive: exceeded ${String(this.config.timeoutMs)} ms`
        child.kill('SIGTERM')
      }, this.config.timeoutMs)
      deadline.unref?.()
      child.once('error', (error: Error) => {
        clearTimeout(deadline)
        resolve({ ok: false, output: `${output}\ndesktop session archive: ${error.message}` })
      })
      child.once('exit', (code) => {
        clearTimeout(deadline)
        resolve({ ok: code === 0, ...(code === null ? {} : { code }), output: output.trim() })
      })
    })
  }
}
