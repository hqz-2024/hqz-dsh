// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC, type DesktopModePresentation } from '../src/ipc.ts'
import { MODE_BANNER_PILL_STYLE, installModeBanner } from '../src/preload-mode.ts'

const ipc = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: ipc }))

/** Deliver one presentation to the banner the way the main process does. */
const present = (mode: DesktopModePresentation['mode'], extra: Partial<DesktopModePresentation> = {}): void => {
  const handler = ipc.on.mock.calls.at(-1)?.[1] as ((event: unknown, value: unknown) => void) | undefined
  handler?.(undefined, {
    mode, text: mode === 'server' ? 'Server mode' : 'Local mode', switchText: 'Switch to local', canSwitch: true, ...extra,
  })
}

afterEach(() => {
  document.querySelector('[data-dsh-mode-banner]')?.remove()
  ipc.send.mockClear()
  ipc.on.mockClear()
})

it('keeps the banner out of the bundled document, where its absence is the signal', () => {
  installModeBanner(ipc as never)
  present('local')
  expect(document.querySelector('[data-dsh-mode-banner]')).toBeNull()
})

it('marks the pill as a control rather than a drag handle', () => {
  // The pill sits inside the native caption strip, which the operating system
  // treats as a window drag region. Without the opt-out the press moves the
  // window and the button never receives a click — which is exactly how a switch
  // that works from a script came to be unclickable for a person.
  installModeBanner(ipc as never)
  present('server', { label: 'HQZ' })
  const pill = document.querySelector('[data-dsh-mode-banner]')?.shadowRoot?.firstElementChild as HTMLElement
  // jsdom drops this non-standard property while parsing, so the stylesheet that
  // carries it is the assertion.
  expect(MODE_BANNER_PILL_STYLE).toContain('-webkit-app-region:no-drag')
  expect(pill.getAttribute('style')).toBeTruthy()
  expect(pill.textContent).toContain('Server mode')
  expect(pill.textContent).toContain('HQZ')
})

it('asks for the bundled deployment when the person presses the action', () => {
  installModeBanner(ipc as never)
  present('server')
  const action = document.querySelector('[data-dsh-mode-banner]')?.shadowRoot?.querySelector('button')
  expect(action?.textContent).toBe('Switch to local')
  action?.click()
  expect(ipc.send).toHaveBeenCalledWith(DESKTOP_IPC.modeSwitch, 'local')
})

it('offers no action it cannot honour', () => {
  installModeBanner(ipc as never)
  present('server', { canSwitch: false })
  expect(document.querySelector('[data-dsh-mode-banner]')?.shadowRoot?.querySelector('button')).toBeNull()
})
