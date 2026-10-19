/**
 * The record a client machine can hand over when a window shows the wrong thing.
 *
 * The shell reports diagnostics to the console, which nobody sees in a packaged
 * Windows application. That left two field reports — a window stuck reconnecting
 * and a switch that appeared to do nothing — without the lines that name the
 * cause, so the decisions taken before a document loads are written beside the
 * shell's own state as well.
 *
 * Nothing here may break a launch: an unresolvable directory, a locked file or a
 * full disk ends that one write and leaves the application running.
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** Cap on the live file; the file it replaces is kept beside it as `<name>.1`. */
const MAX_BYTES = 512 * 1024

/** Append-only diagnostics for one installation. */
export class DesktopLog {
  /** @param file - absolute path of the file to append to. */
  constructor(private readonly file: string) {}

  /**
   * Append one informational line.
   * @param message - what happened, without a trailing newline.
   */
  info(message: string): void { this.write('info', message) }

  /**
   * Append one failure.
   * @param message - what failed.
   * @param cause - the failure, when the caller has one.
   */
  error(message: string, cause?: unknown): void {
    const detail = cause === undefined ? '' : `: ${cause instanceof Error ? cause.message : String(cause)}`
    this.write('error', `${message}${detail}`)
  }

  private write(level: 'info' | 'error', message: string): void {
    try {
      this.rotate()
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${new Date().toISOString()} ${level} ${message}\n`, 'utf8')
    } catch {
      // The console carries the same line for anyone running from a terminal, and
      // a machine that cannot write its log still has to run the application.
    }
  }

  private rotate(): void {
    const size = statSync(this.file, { throwIfNoEntry: false })?.size ?? 0
    if (size < MAX_BYTES) return
    const previous = `${this.file}.1`
    rmSync(previous, { force: true })
    renameSync(this.file, previous)
  }
}
