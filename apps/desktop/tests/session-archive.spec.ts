import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSessionArchiveConfig, SessionArchive } from '../src/session-archive.ts'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

/** One fake child process the schedule can drive. */
function fakeChild(options: { code?: number | null, stdout?: string, stderr?: string, error?: Error, never?: boolean } = {}) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const emit = (event: string, ...args: unknown[]) => {
    for (const handler of listeners.get(event) ?? []) handler(...args)
  }
  const child = {
    stdout: { on: (_event: string, handler: (chunk: Buffer) => void) => { if (options.stdout !== undefined) handler(Buffer.from(options.stdout)) } },
    stderr: { on: (_event: string, handler: (chunk: Buffer) => void) => { if (options.stderr !== undefined) handler(Buffer.from(options.stderr)) } },
    // A killed child still exits; the schedule depends on that to settle.
    kill: vi.fn(() => { queueMicrotask(() => { emit('exit', null) }) }),
    once: (event: string, handler: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return child
    },
  }
  if (options.never !== true) {
    queueMicrotask(() => {
      if (options.error !== undefined) emit('error', options.error)
      else emit('exit', options.code ?? 0)
    })
  }
  return child
}

describe('session archive scheduling', () => {
  let home: string
  let clientDir: string
  const environment: NodeJS.ProcessEnv = {}

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-archive-home-'))
    clientDir = join(home, 'client')
    mkdirSync(clientDir, { recursive: true })
    spawnMock.mockReset()
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  const writeScript = () => { writeFileSync(join(clientDir, 'export-session.mjs'), '// export\n') }
  const writeDestination = () => { writeFileSync(join(home, 'archive.json'), '{ "origin": "https://example:8443" }\n') }

  it('does nothing on a machine that was never provisioned', () => {
    // The deployment repo carries the script; only provisioning makes a machine
    // archive. A missing destination is what distinguishes the two.
    expect(resolveSessionArchiveConfig({ dshHome: home, environment })).toBeUndefined()
    writeScript()
    expect(resolveSessionArchiveConfig({ dshHome: home, environment })).toBeUndefined()
  })

  it('schedules once both the script and a destination exist', () => {
    writeScript()
    writeDestination()
    const config = resolveSessionArchiveConfig({ dshHome: home, environment })
    expect(config?.script).toBe(join(clientDir, 'export-session.mjs'))
    expect(config?.intervalMs).toBe(6 * 60 * 60 * 1000)
    expect(config?.timeoutMs).toBe(10 * 60 * 1000)
  })

  it('accepts an explicit destination override without archive.json', () => {
    writeScript()
    expect(resolveSessionArchiveConfig({ dshHome: home, environment: { HQZ_ARCHIVE_ORIGIN: 'https://x.example:1' } })?.origin)
      .toBeUndefined()
    expect(resolveSessionArchiveConfig({ dshHome: home, environment: { HQZ_ARCHIVE_ORIGIN: 'https://x.example:1' } }))
      .toBeDefined()
  })

  it('honours an explicit script path and interval', () => {
    const elsewhere = join(home, 'other.mjs')
    writeFileSync(elsewhere, '// export\n')
    writeDestination()
    const config = resolveSessionArchiveConfig({
      dshHome: home,
      environment: { DSH_DESKTOP_ARCHIVE_SCRIPT: elsewhere, DSH_DESKTOP_ARCHIVE_INTERVAL_MS: '30000', DSH_DESKTOP_ARCHIVE_TIMEOUT_MS: '5000' },
    })
    expect(config?.script).toBe(elsewhere)
    expect(config?.intervalMs).toBe(30_000)
    expect(config?.timeoutMs).toBe(5_000)
  })

  it('turns the timer off on request without unconfiguring the machine', () => {
    writeScript()
    writeDestination()
    expect(resolveSessionArchiveConfig({ dshHome: home, environment: { DSH_DESKTOP_ARCHIVE_INTERVAL_MS: '0' } })).toBeUndefined()
  })

  it('ignores an unusable interval instead of scheduling something absurd', () => {
    writeScript()
    writeDestination()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveSessionArchiveConfig({ dshHome: home, environment: { DSH_DESKTOP_ARCHIVE_INTERVAL_MS: '5' } })?.intervalMs)
      .toBe(6 * 60 * 60 * 1000)
    expect(resolveSessionArchiveConfig({ dshHome: home, environment: { DSH_DESKTOP_ARCHIVE_INTERVAL_MS: 'later' } })?.intervalMs)
      .toBe(6 * 60 * 60 * 1000)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('one archive run', () => {
  const config = { script: 'C:/script.mjs', intervalMs: 60_000, timeoutMs: 5_000 }

  beforeEach(() => { spawnMock.mockReset() })
  afterEach(() => { vi.useRealTimers() })

  it('runs the script with this machine\'s Harness home and reports success', async () => {
    spawnMock.mockReturnValue(fakeChild({ code: 0, stdout: '{"note":"x.md"}' }))
    const archive = new SessionArchive('node.exe', config, 'C:/home', { PATH: 'x' })
    const run = await archive.runNow()
    expect(run.ok).toBe(true)
    expect(run.output).toContain('note')
    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }]
    expect(command).toBe('node.exe')
    // `--pending` is the scheduled selector: every session changed since the
    // ledger was last written, not just the most recent one.
    expect(args).toEqual(['C:/script.mjs', '--pending'])
    expect(options.env.DSH_HOME).toBe('C:/home')
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('reports a failed run instead of raising it', async () => {
    spawnMock.mockReturnValue(fakeChild({ code: 3, stderr: '没有归档端地址' }))
    const archive = new SessionArchive('node.exe', config, 'C:/home', {})
    const run = await archive.runNow()
    expect(run.ok).toBe(false)
    expect(run.code).toBe(3)
    expect(run.output).toContain('没有归档端地址')
  })

  it('survives a child that cannot start at all', async () => {
    spawnMock.mockReturnValue(fakeChild({ error: new Error('spawn ENOENT') }))
    const archive = new SessionArchive('node.exe', config, 'C:/home', {})
    const run = await archive.runNow()
    expect(run.ok).toBe(false)
    expect(run.output).toContain('spawn ENOENT')
  })

  it('shares one run between concurrent callers', async () => {
    spawnMock.mockReturnValue(fakeChild({ code: 0 }))
    const archive = new SessionArchive('node.exe', config, 'C:/home', {})
    const [first, second] = await Promise.all([archive.runNow(), archive.runNow()])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
  })

  it('kills a run that exceeds its deadline and still settles', async () => {
    vi.useFakeTimers()
    const child = fakeChild({ never: true })
    spawnMock.mockReturnValue(child)
    const archive = new SessionArchive('node.exe', { ...config, timeoutMs: 1_000 }, 'C:/home', {})
    const pending = archive.runNow()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    // A killed child still exits, so a run that overran its deadline can never
    // hold the schedule — or a later quit — open.
    const run = await pending
    expect(run.ok).toBe(false)
    expect(run.output).toContain('exceeded 1000 ms')
  })

  it('stops scheduling after disposal', async () => {
    vi.useFakeTimers()
    spawnMock.mockReturnValue(fakeChild({ code: 0 }))
    const archive = new SessionArchive('node.exe', { ...config, intervalMs: 10_000 }, 'C:/home', {})
    archive.start()
    archive.dispose()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
