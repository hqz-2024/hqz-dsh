import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopLog } from '../src/desktop-log.ts'

let directory: string
let file: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-log-'))
  file = join(directory, 'desktop.log')
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it('appends one line per report, with its level and an error text when there is one', () => {
  const log = new DesktopLog(file)
  log.info('desktop mode: switching to server')
  log.error('desktop mode: switching to server failed', new Error('Host did not start'))
  log.error('desktop mode: another failure', 'plain text')
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  expect(lines).toHaveLength(3)
  expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z info desktop mode: switching to server$/)
  expect(lines[1]).toContain('error desktop mode: switching to server failed: Host did not start')
  expect(lines[2]).toContain('error desktop mode: another failure: plain text')
})

it('creates the directory it needs', () => {
  const nested = join(directory, 'missing', 'desktop.log')
  new DesktopLog(nested).info('first line')
  expect(readFileSync(nested, 'utf8')).toContain('first line')
})

it('keeps one previous file once the live one passes its cap', () => {
  const log = new DesktopLog(file)
  writeFileSync(file, `${'x'.repeat(600 * 1024)}\n`)
  log.info('after the cap')
  // The oversized file moved aside rather than being appended to or deleted.
  expect(statSync(`${file}.1`).size).toBeGreaterThan(600 * 1024)
  expect(readFileSync(file, 'utf8').trimEnd().split('\n')).toHaveLength(1)
  // And the kept file is replaced, not accumulated, on the next rotation.
  writeFileSync(file, `${'y'.repeat(600 * 1024)}\n`)
  log.info('after the second cap')
  expect(readFileSync(`${file}.1`, 'utf8')).toContain('y'.repeat(10))
})

it('never throws where it cannot write, because a launch outranks its log', () => {
  // A directory where the file should be: the write cannot succeed, and the
  // application must not notice.
  const log = new DesktopLog(directory)
  expect(() => { log.info('unwritable'); log.error('unwritable', new Error('nope')) }).not.toThrow()
})
