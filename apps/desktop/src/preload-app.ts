/** Origin-scoped boot, native directory selection, and update presentation with native confirmation actions. */

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, SCHEME, type DshDesktopProductApi, type DesktopUpdatePresentation } from './ipc.ts'
import { installModeBanner } from './preload-mode.ts'
import { markDocumentPlatform } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'

const product: DshDesktopProductApi = {
  protocolVersion: 1,
  updates: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.updatesStatus) as Promise<DesktopUpdatePresentation>,
    open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdatePresentation): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.updatesPresentation, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.updatesPresentation, handle) }
    },
  },
}

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick) as Promise<string | null>,
  })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  })
}

markDocumentPlatform()
syncNativeTheme()
// The Windows caption and the mode banner belong to the window rather than to
// one origin: server mode shows the deployment's own Web UI, and without the
// caption its title bar would lose the menus and the window would give no sign
// of which deployment it is showing. Both stay outside the gate above, which
// guards only the privileged bridges.
const caption = syncWindowsAppearance()
installModeBanner(ipcRenderer)
// The caption menubar mounts itself once the application frame publishes its
// overlay seat; server mode has no such seat, so the shell's own mode report is
// what mounts it there.
ipcRenderer.on(DESKTOP_IPC.mode, (_event, presentation: unknown) => {
  if (typeof presentation !== 'object' || presentation === null) return
  const value = presentation as { mode?: unknown }
  if (value.mode !== 'local' && value.mode !== 'server') return
  caption.setServerMode(value.mode === 'server')
})
// Main-process IPC also verifies the owning window and top frame.
contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' ? product : { protocolVersion: 1 })
