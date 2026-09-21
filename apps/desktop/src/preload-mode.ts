/**
 * The mode banner the shell draws over whichever document the window shows.
 *
 * Server mode loads a document this shell did not author — the deployment's own
 * Web UI — and that document cannot know which deployment it is being shown
 * for. The banner is therefore shell-owned and lives in a shadow root so the
 * page's stylesheets cannot restyle or hide it, and it is the one signal that
 * survives a page this shell does not control.
 *
 * It appears only in server mode. Local mode is the deployment the application
 * itself carries, so the absence of the banner is the local signal, and a
 * permanent badge over the user's own workspace would be noise.
 * @module preload-mode
 */

import type { IpcRenderer } from 'electron'
import { DESKTOP_IPC, type DesktopModePresentation } from './ipc.ts'

/** Attribute on the banner host, so the shell and its tests share one handle. */
export const MODE_BANNER_ATTRIBUTE = 'data-dsh-mode-banner'

/** The pill's own stylesheet, applied inline because the page owns no class names here. */
const PILL_STYLE = [
  'position:fixed',
  'top:8px',
  'left:50%',
  'transform:translateX(-50%)',
  'display:flex',
  'align-items:center',
  'gap:10px',
  'padding:4px 8px 4px 12px',
  'border-radius:999px',
  'font:500 12px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif',
  'color:#3b2600',
  'background:#f7c948',
  'box-shadow:0 2px 10px rgba(0,0,0,.28)',
  'pointer-events:auto',
  'user-select:none',
  'white-space:nowrap',
].join(';')

/** The switch button's stylesheet. */
const ACTION_STYLE = [
  'font:inherit',
  'padding:1px 10px',
  'border:0',
  'border-radius:999px',
  'cursor:pointer',
  'color:#f7c948',
  'background:#3b2600',
].join(';')

/**
 * Render or remove the banner for one presentation.
 * @param ipc - the preload's renderer IPC channel, used by the switch action.
 * @param presentation - the mode the window shows and what it may switch to.
 */
function render(ipc: IpcRenderer, presentation: DesktopModePresentation): void {
  const existing = document.querySelector(`[${MODE_BANNER_ATTRIBUTE}]`)
  if (presentation.mode === 'local') {
    existing?.remove()
    return
  }
  const host = existing ?? (() => {
    const created = document.createElement('div')
    created.setAttribute(MODE_BANNER_ATTRIBUTE, '')
    // The host itself must take no layout space and intercept no clicks meant
    // for the page; only the pill inside it is interactive.
    created.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647'
    document.body.append(created)
    return created
  })()
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  root.replaceChildren()
  const pill = document.createElement('div')
  pill.style.cssText = PILL_STYLE
  const text = document.createElement('span')
  text.textContent = presentation.label === undefined
    ? presentation.text
    : `${presentation.text} · ${presentation.label}`
  text.title = presentation.origin ?? ''
  pill.append(text)
  if (presentation.canSwitch) {
    const action = document.createElement('button')
    action.type = 'button'
    action.textContent = presentation.switchText
    action.style.cssText = ACTION_STYLE
    action.addEventListener('click', () => { ipc.send(DESKTOP_IPC.modeSwitch, 'local') })
    pill.append(action)
  }
  root.append(pill)
}

/**
 * Install the banner.
 *
 * The listener is installed on every document, including one the shell did not
 * author, because a preload belongs to the window rather than to an origin. The
 * banner carries no privileged bridge: switching modes is a request the main
 * process validates against the window's own top frame, so a page cannot use it
 * to reach anything.
 * @param ipc - the preload's renderer IPC channel.
 */
export function installModeBanner(ipc: IpcRenderer): void {
  ipc.on(DESKTOP_IPC.mode, (_event, presentation: unknown) => {
    if (typeof presentation !== 'object' || presentation === null) return
    const value = presentation as DesktopModePresentation
    if (value.mode !== 'local' && value.mode !== 'server') return
    const install = (): void => { render(ipc, value) }
    if (document.body === null) document.addEventListener('DOMContentLoaded', install, { once: true })
    else install()
  })
}
