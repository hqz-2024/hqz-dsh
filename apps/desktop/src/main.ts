import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'
/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  nativeTheme,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { resolveDesktopPaths } from './paths.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DesktopProjectManager } from './project-manager.ts'
import { DesktopHostProcess, DesktopHostUncleanExitError } from './host-process.ts'
import { installDesktopDirectoryPicker } from './directory-picker.ts'
import { DesktopBackendController } from './backend-controller.ts'
import { DESKTOP_IPC, SCHEME, assertDesktopSender, type DesktopModePresentation, type DesktopUpdateState } from './ipc.ts'
import { formatDesktopMessage, resolveDesktopLocale } from './locale.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { DesktopUpdateCoordinator } from './update-coordinator.ts'
import { serveWebDocument, authenticateWebHost, forwardWebRequest } from './web-document.ts'
import { serveShellDocument } from './shell-document.ts'
import { resolveSessionArchiveConfig, SessionArchive } from './session-archive.ts'
import {
  certificateFingerprint256,
  decideServerCertificate,
  isDesktopMode,
  resolveServerModeConfig,
  serverNavigationAllowed,
  startupDesktopMode,
  writeDesktopMode,
  type DesktopMode,
} from './server-mode.ts'
import { DesktopFatalRecovery } from './fatal-recovery.ts'
import { DesktopLog } from './desktop-log.ts'
import { resolveDesktopGatewayConfig, seedDesktopGateway } from './desktop-gateway.ts'
import { DesktopUpdateJournal } from './update-journal.ts'
import { DesktopUpdatePreparationError } from './update-error.ts'
import { DesktopUpdateSchedule, resolveDesktopUpdateScheduleConfig } from './update-schedule.ts'
import { desktopUpdateErrorSummary, presentDesktopUpdate } from './update-presentation.ts'
import { desktopErrorState } from './startup-error.ts'
import { DesktopMandatoryUpdatePolicy, resolveDesktopPolicyConfig, type DesktopPolicyState } from './mandatory-update-policy.ts'
import { DesktopMandatoryUpdateWindow } from './mandatory-update-window.ts'
import { DesktopPolicyTestAuth } from './policy-test-auth.ts'
import { DesktopUpdateDialog, type UpdateDialogOptions } from './update-dialog.ts'
import { readDesktopRuntime } from './runtime-tree.ts'

let focusPrimaryWindow = (): void => {}
let stopForRecovery = async (): Promise<void> => {}
let shuttingDown = false
let windowsLanguage: string | undefined

function currentDesktopLocale(): ReturnType<typeof resolveDesktopLocale> {
  return resolveDesktopLocale(windowsLanguage ?? app.getLocale())
}
// Beside the shell's own state, so a machine that shows the wrong document can
// hand over the lines that say which mode it chose and why it refused a
// certificate. The console carries the same lines for a terminal launch.
const log = new DesktopLog(join(app.getPath('userData'), 'desktop.log'))

/** Report one line to both the console and this installation's log. */
function note(message: string): void {
  console.info(message)
  log.info(message)
}

const recovery = new DesktopFatalRecovery({
  messages: () => currentDesktopLocale().messages,
  show: options => dialog.showMessageBox(options),
  stop: () => { shuttingDown = true; return stopForRecovery() },
  disablePlugins: async () => {
    const manager = new DesktopProjectManager(resolveDesktopPaths(), runtimeResources())
    const backupPath = await manager.disableAllPlugins()
    console.info('Desktop profile recovery completed:', { profilePatchBackup: backupPath ?? null, homePatch: 'unchanged' })
  },
  exit: () => { app.quit() },
  restart: () => { app.relaunch(); app.quit() },
})

function reportFatal(error: unknown): void {
  console.error(error)
  log.error('fatal', error)
  if (shuttingDown) return
  void recovery.report(error).catch((failure: unknown) => { console.error(failure); app.exit(1) })
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}])

interface RuntimeResources {
  readonly nodeBin: string
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
}

function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged
  const node = process.execPath
  const nodeBin = development ? join(app.getAppPath(), 'scripts', 'node-bin') : join(process.resourcesPath, 'runtime', 'bin')
  const pnpm = (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : undefined)
    ?? (development ? join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
      : join(process.resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'))
  const dsh = (development ? process.env.DSH_DESKTOP_DSH_DIR : undefined)
    ?? (development ? join(app.getAppPath(), '.desktop-build', 'development', 'project') : join(app.getAppPath(), 'dsh'))
  return { node, nodeBin, pnpm, dsh }
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  if (!enabled || configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

function createWindow(preload: string, show = false, primary = false, staysInWindow: (url: string) => boolean = () => false): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show,
    ...(process.platform === 'win32' && primary ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT, color: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb',
        symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115' },
    } : {}),
    // hiddenInset places traffic lights inside the sidebar; sidebar vibrancy
    // needs a transparent window background to show through the page.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar' as const,
      // 'active' keeps the vibrancy material stable when the window blurs;
      // 'followWindow' washes the sidebar out behind an unfocused window.
      visualEffectState: 'active' as const,
      backgroundColor: '#00000000',
    } : {}),
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('context-menu', (_event, { isEditable, selectionText, editFlags }) => {
    const items: MenuItemConstructorOptions[] = []
    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    } else if (selectionText.length > 0) {
      items.push({ role: 'copy', enabled: editFlags.canCopy })
    }
    // Empty accelerators suppress Electron's default shortcut labels for native roles.
    if (items.length > 0) {
      const messages = currentDesktopLocale().messages
      Menu.buildFromTemplate(items.map(item => ({
        ...item,
        ...(process.platform === 'win32' && item.role !== undefined && item.role in messages
          ? { label: messages[item.role as keyof typeof messages] } : {}),
        accelerator: '',
      }))).popup({ window })
    }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const destination = new URL(url)
    const current = new URL(window.webContents.getURL())
    // A single-page application rewrites its own URL constantly, so a document
    // stays in the window as long as it remains on the origin it is already
    // showing. That covers both schemes the Web application is served over:
    // `http:` for the Host the shell starts, `https:` for a deployment behind a
    // TLS terminator. Anything else — and any navigation the server-mode policy
    // allows — is either dropped or handed to the system browser.
    const sameOrigin = (destination.protocol === 'http:' || destination.protocol === 'https:')
      && destination.origin === current.origin
    if (destination.protocol !== `${SCHEME}:` && !sameOrigin && !staysInWindow(url)) {
      event.preventDefault()
      if (['http:', 'https:'].includes(destination.protocol)) void shell.openExternal(url)
    }
  })
  return window
}

async function main(): Promise<void> {
  const journalDirectory = process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR
  const updateJournal = journalDirectory === undefined ? undefined : new DesktopUpdateJournal(journalDirectory, app.getVersion())
  const resources = runtimeResources()
  const dshHome = resolveDshHome()
  const paths = resolveDesktopPaths(dshHome)
  const development = !app.isPackaged
  const activeProject = paths.profile
  const manager = new DesktopProjectManager(paths, resources)
  // Archiving this machine's own sessions is a client capability with no
  // dependence on the window: it is scheduled from the Harness home alone, and a
  // machine that was never provisioned for it simply has no script to run.
  const archiveConfig = resolveSessionArchiveConfig({ dshHome, environment: process.env })
  const archive = archiveConfig === undefined
    ? undefined
    : new SessionArchive(resources.node, archiveConfig, dshHome, process.env)
  /**
   * Run one archive pass and report it.
   *
   * Failure is reported, never raised: the script's own output names what went
   * wrong (no sessions yet, no token provisioned, deployment unreachable), and
   * a client that cannot archive must still start and work.
   */
  const runArchiveNow = async (): Promise<void> => {
    if (archive === undefined) return
    const run = await archive.runNow()
    const detail = run.output === '' ? 'no output' : run.output
    if (run.ok) note(`desktop session archive: ${detail}`)
    else log.error(`desktop session archive: failed (${run.code === undefined ? 'killed' : String(run.code)})`, detail)
  }
  // The deployment this window may show in server mode, and the mode the last
  // run left selected. Both are resolved before the first window exists, because
  // the document that window loads is what they decide.
  const clientSettingsFile = join(app.getPath('userData'), 'desktop-client.json')
  const modeFile = join(app.getPath('userData'), 'desktop-mode.json')
  const manifest: unknown = JSON.parse(await readFile(join(app.getAppPath(), 'package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop policy: invalid application manifest')
  const serverConfig = resolveServerModeConfig({
    manifestValue: 'dshDesktopServerMode' in manifest ? manifest.dshDesktopServerMode : undefined,
    environmentValue: process.env.DSH_DESKTOP_SERVER_MODE,
    settingsFile: clientSettingsFile,
  })
  let mode: DesktopMode = startupDesktopMode(modeFile, { deploymentConfigured: serverConfig !== undefined })
  note(serverConfig === undefined
    ? `desktop mode: starting in ${mode} mode; no deployment is configured`
    : `desktop mode: starting in ${mode} mode for ${serverConfig.origin}`)
  // Local mode asks the deployment for its models, so the route has to exist
  // before the Host starts — otherwise the bundled application opens asking for an
  // API key that this machine does not have and should not need.
  const gateway = resolveDesktopGatewayConfig('dshDesktopGateway' in manifest ? manifest.dshDesktopGateway : undefined)
  if (gateway !== undefined) {
    const seed = seedDesktopGateway(dshHome, gateway)
    note(`desktop gateway: ${gateway.origin} (${gateway.models.join(', ')})`
      + `${seed.written.length === 0 ? '; this machine is already configured' : `; wrote ${seed.written.join(', ')}`}`)
  } else {
    note('desktop gateway: this build carries no model route; local mode needs client/provision-client.ps1')
  }
  let quitting = false
  let startup: Promise<void> | undefined
  let workspaceRecovery: Promise<void> | undefined
  let mainWindow: BrowserWindow | undefined
  let shellInstallerOwnsQuit = false
  let requireCleanStop = false
  let updateStoppedHost = false
  let updateStopFailure: DesktopHostUncleanExitError | undefined
  let updateState: DesktopUpdateState = { phase: 'idle' }
  let mandatoryPolicy: DesktopMandatoryUpdatePolicy | undefined
  let mandatoryUI: DesktopMandatoryUpdateWindow | undefined
  let policyAuth: DesktopPolicyTestAuth | undefined
  const isQuitting = (): boolean => quitting
  const currentMainWindow = (): BrowserWindow | undefined => mainWindow
  const ordinaryDialogs = new Set<AbortController>()
  const locale = resolveDesktopLocale(app.getLocale())
  const messages = locale.messages
  const updateDialog = new DesktopUpdateDialog(fileURLToPath(new URL('./preload-update-dialog.cjs', import.meta.url)), locale)
  const isMandatory = (): boolean => mandatoryPolicy?.state.blocking === true
  const ordinaryMessageBox = async (options: UpdateDialogOptions): Promise<Electron.MessageBoxReturnValue> => {
    const controller = new AbortController()
    ordinaryDialogs.add(controller)
    try {
      if (mainWindow === undefined) return { response: options.cancelId ?? 0, checkboxChecked: false }
      return await updateDialog.show(mainWindow, { ...options, signal: controller.signal })
    }
    finally { ordinaryDialogs.delete(controller) }
  }
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const applicationUrl = `${SCHEME}://app/`
  let hostUrl: string | undefined
  let hostCookie: string | undefined
  let injections: readonly unknown[] = []
  /** The document the window shows for the mode it is in. */
  const modeUrl = (): string => (mode === 'server' && serverConfig !== undefined ? serverConfig.origin : applicationUrl)
  /** What the shell tells a document about the mode its window is showing. */
  const modePresentation = (): DesktopModePresentation => ({
    mode,
    text: mode === 'server' ? messages.modeServerBanner : messages.modeLocal,
    switchText: messages.modeSwitchToLocal,
    canSwitch: serverConfig !== undefined,
    ...(serverConfig?.label === undefined ? {} : { label: serverConfig.label }),
    ...(serverConfig === undefined ? {} : { origin: serverConfig.origin }),
  })
  const publishMode = (): void => {
    mainWindow?.webContents.send(DESKTOP_IPC.mode, modePresentation())
  }
  /**
   * Give the window the chrome its mode owns.
   *
   * The caption colour is pushed by the page in local mode, because the Web UI
   * reads the active palette. Server mode shows a document this shell did not
   * author, and that document cannot know which deployment it is being shown
   * for, so the shell sets an unmistakable amber caption itself. The title
   * carries the same fact into the taskbar and Alt-Tab.
   */
  const applyModeChrome = (): void => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) return
    window.setTitle(mode === 'server'
      ? `DeepSeek Harness — ${messages.modeServer}${serverConfig?.label === undefined ? '' : ` · ${serverConfig.label}`}`
      : 'DeepSeek Harness')
    if (process.platform !== 'win32') return
    window.setTitleBarOverlay(mode === 'server'
      ? { color: '#f7c948', symbolColor: '#3b2600' }
      : {
          color: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb',
          symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115',
        })
  }
  const assertProductSender = (event: IpcMainInvokeEvent): void => {
    assertDesktopSender(event, ['app'])
    if (mainWindow === undefined || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame === null || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected IPC from an unowned renderer')
    }
  }
  let navigation: { window: BrowserWindow; url: string; promise: Promise<void> } | undefined
  const navigateMain = (url: string): Promise<void> => {
    const window = mainWindow
    if (quitting || window === undefined || window.isDestroyed()) return Promise.resolve()
    if (navigation?.window === window && navigation.url === url) return navigation.promise
    const next = { window, url, promise: Promise.resolve() }
    next.promise = window.loadURL(url).catch((error: unknown) => {
      if (quitting || shuttingDown || window.isDestroyed() || navigation !== next
        || (error instanceof Error && 'code' in error && error.code === 'ERR_ABORTED')) return
      navigation = undefined
      throw error
    })
    navigation = next
    return next.promise
  }
  const backend = new DesktopBackendController((onFailure) => {
    const hostInspectPort = developmentHostInspectPort(development)
    const host = new DesktopHostProcess(resources.node, resources.dsh, activeProject,
      hostInspectPort, process.env, onFailure,
      development ? join(app.getAppPath(), '.desktop-build', 'targets', `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`, 'runtime', 'primary-runtime')
        : join(process.resourcesPath, 'runtime', 'primary-runtime'),
      development ? 'link' : 'runtime', resources)
    return {
      start: async () => {
        const ready = await host.start()
        hostCookie = await authenticateWebHost(ready.url)
        hostUrl = ready.url
        if (ready.injections === undefined) throw new Error('Desktop Host did not provide boot injections')
        injections = ready.injections
      },
      stop: async () => {
        try { await host.stop(requireCleanStop) }
        catch (error) {
          if (!requireCleanStop || !(error instanceof DesktopHostUncleanExitError)) throw error
          // Backend cleanup succeeded; installation still rejects the unsuccessful task teardown.
          updateStopFailure = error
        }
      },
      updateTasks: (action: 'inspect' | 'lock' | 'unlock') => host.updateTasks(action),
    }
  }, (state) => {
    if (state.phase === 'error') reportFatal(new Error(state.message))
  })

  const updateErrors = new WeakMap<DesktopUpdateState, Promise<void>>()
  const showUpdateFailure = (state: DesktopUpdateState): Promise<void> => {
    if (state.phase !== 'error') return Promise.resolve()
    if (isMandatory()) { mandatoryUI?.sync(); return Promise.resolve() }
    let shown = updateErrors.get(state)
    if (shown === undefined) {
      shown = ordinaryMessageBox({ type: 'error', title: messages.updateFailedTitle,
        message: desktopUpdateErrorSummary(state, messages),
        technicalDetails: state.technicalDetails ?? state.message ?? '' }).then(() => {})
      updateErrors.set(state, shown)
    }
    return shown
  }
  const publishUpdate = (state: DesktopUpdateState): DesktopUpdateState => {
    updateJournal?.state(state)
    updateState = state
    mandatoryUI?.sync()
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.updatesPresentation, presentDesktopUpdate(state))
    }
    if (state.phase === 'error' && state.failedOperation !== 'check') {
      const restoreHost = state.failedOperation === 'install' && updateStoppedHost && !quitting
      shellInstallerOwnsQuit = false
      updateStoppedHost = false
      if (restoreHost) {
        // Only confirmed process exit permits replacement before another installation confirmation.
        const hostReady = backend.start(async () => {})
        startup = hostReady
        const recovery = hostReady.then(async () => {
          if (quitting) return
          // A replacement Host can have a new port, cookie, or boot injections even at the same URL.
          navigation = undefined
          await navigateMain(applicationUrl)
          if (backend.host !== undefined) updateJournal?.action('workspace-ready')
        })
        workspaceRecovery = recovery
        void recovery.catch(reportFatal).finally(() => {
          if (startup === hostReady) startup = undefined
          if (workspaceRecovery === recovery) workspaceRecovery = undefined
        })
      }
      void showUpdateFailure(state).catch((error: unknown) => { console.error(error) })
    }
    return state
  }

  stopForRecovery = () => backend.close()

  const reconcileBackend = (): Promise<void> => {
    // Server mode shows a deployment this shell does not run: it starts no Host
    // and writes no profile, so no local agent owns the session. Local mode
    // loads the packaged document first — the loading page accepts boot
    // injections whenever they arrive — and starts the Host behind it.
    if (mode === 'server') return navigateMain(modeUrl())
    startup ??= (async () => {
      await navigateMain(applicationUrl)
      await backend.start(async () => {
        await manager.applyRelease(app.isPackaged)
      })
      if (backend.host !== undefined) updateJournal?.action('workspace-ready')
      // The existing Web document resumes through the boot IPC response.
    })().catch((error: unknown) => {
      updateJournal?.action('workspace-failed')
      reportFatal(error)
      throw error
    }).finally(() => { startup = undefined })
    return startup
  }

  let switching = false
  /**
   * Show the other deployment in the same window.
   *
   * The window is never destroyed: replacing the document is enough, and
   * destroying the only window would quit the application. The local Host keeps
   * running underneath, so switching back is one page load rather than a cold
   * start, and nothing about the profile changes either way.
   * @param next - the mode to show.
   */
  const switchMode = async (next: DesktopMode): Promise<void> => {
    if (switching) {
      // Swallowing this silently is what made a stuck switch look like a dead
      // button, so the ignored request is written down where a report can find it.
      note(`desktop mode: ignoring a switch to ${next}; one is already running`)
      return
    }
    if (next === mode) return
    if (next === 'server' && serverConfig === undefined) {
      await ordinaryMessageBox({
        type: 'info', title: messages.modeUnavailableTitle, message: messages.modeUnavailableDetail,
      })
      return
    }
    switching = true
    note(`desktop mode: switching to ${next}`)
    try {
      mode = next
      const failure = writeDesktopMode(modeFile, mode)
      if (failure !== undefined) console.error('desktop server mode: could not store the selected mode', failure)
      // The memoised entry describes the document being replaced, so it must not
      // survive the switch even when the next URL happens to match it.
      navigation = undefined
      applyModeChrome()
      publishMode()
      await reconcileBackend()
      publishMode()
      note(`desktop mode: now showing ${next}`)
    } finally { switching = false }
  }
  const reportServerModeLoaded = (): void => {
    applyModeChrome()
    publishMode()
  }

  const updates = new DesktopUpdateCoordinator(
    publishUpdate,
    async () => {
      await workspaceRecovery
      await startup?.catch(() => undefined)
      const host = backend.host
      if (host === undefined) throw new DesktopUpdatePreparationError('tasks-unavailable', messages.updateTasksUnavailable)
      const active = await host.updateTasks('inspect')
      const confirmation: Electron.MessageBoxOptions = {
        type: active ? 'warning' : 'info', title: messages.updateTitle,
        message: active ? messages.updateActiveTasks : formatDesktopMessage(messages.updateDownloadedTitle, { version: updates.state.version ?? '' }),
        detail: active ? messages.updateActiveTasksDetail
          : messages.updateDownloadedDetail,
        buttons: active ? [messages.updateStopTasks, messages.updateLater] : [messages.installAndRestart],
        defaultId: 1, cancelId: 1,
      }
      if (isMandatory()) {
        if (!await mandatoryUI?.confirm(updates.state.version ?? '', active)) return false
      } else {
        if (mainWindow === undefined) return false
        const result = await updateDialog.show(mainWindow, confirmation)
        if (result.response !== 0 || isMandatory()) return false
      }
      if (backend.host !== host) throw new DesktopUpdatePreparationError('tasks-unavailable', messages.updateTasksUnavailable)
      try {
        const stillActive = await host.updateTasks('lock')
        if (stillActive && !active) throw new DesktopUpdatePreparationError('tasks-changed', messages.updateTasksChanged)
        mandatoryUI?.preparingRestart(stillActive)
        requireCleanStop = true
        updateStopFailure = undefined
        await backend.stop()
        updateStoppedHost = true
        // The backend's async cleanup callback can assign this after the reset above.
        const stopFailure = updateStopFailure as DesktopHostUncleanExitError | undefined
        if (stopFailure !== undefined) throw new DesktopUpdatePreparationError('stop-failed', messages.updateStopFailed, stopFailure.message)
        updateJournal?.action('install-confirmed')
        shellInstallerOwnsQuit = true
      } catch (error) {
        if (!updateStoppedHost) await host.updateTasks('unlock').catch((unlockError: unknown) => { console.error(unlockError) })
        throw error
      } finally {
        requireCleanStop = false
      }
      return true
    },
  )

  const updateSchedule = new DesktopUpdateSchedule(updates, resolveDesktopUpdateScheduleConfig(process.env))

  const downloadUpdate = async (version: string): Promise<DesktopUpdateState> => {
    updateJournal?.action('download-requested')
    const state = await updates.download(version)
    if (state.phase !== 'ready' || quitting) return state
    // Only a completed user-driven download opens this prompt; cancelling installation does not reopen it.
    return updates.install(version)
  }

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') return serveShellDocument(request)
    if (url.hostname === 'app') {
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/')
        || ['/favicon.svg', '/manifest.webmanifest'].includes(url.pathname)) {
        return serveWebDocument(request, join(resources.dsh, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'))
      }
      if (backend.host === undefined || hostUrl === undefined || hostCookie === undefined) {
        return Promise.resolve(new Response(null, { status: 503 }))
      }
      return forwardWebRequest(request, hostUrl, hostCookie)
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })

  installDesktopDirectoryPicker(() => mainWindow)

  // Accept the certificate a configured deployment presents, and only that
  // one: the decision is scoped to the configured origin and compares the
  // fingerprint itself, because Electron's own error is not a trust decision.
  app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
    if (serverConfig === undefined) return
    let fingerprint: string | undefined
    try {
      fingerprint = certificateFingerprint256(certificate.data ?? '')
    } catch {
      fingerprint = undefined
    }
    const decision = decideServerCertificate(serverConfig, url, fingerprint)
    note(`desktop server mode: ${decision.reason}`)
    if (!decision.accept) return
    event.preventDefault()
    callback(true)
  })

  // The banner's switch action arrives as a plain send from the preload, which
  // runs on the remote document too. It carries no authority of its own, so the
  // request is validated against the window's own top frame and nothing else.
  ipcMain.on(DESKTOP_IPC.modeSwitch, (event, requested: unknown) => {
    if (mainWindow === undefined || event.sender !== mainWindow.webContents
      || event.senderFrame === null || event.senderFrame !== mainWindow.webContents.mainFrame) return
    if (!isDesktopMode(requested)) return
    // A switch that fails has to say so: the banner's action is the only way back
    // to the bundled deployment from a document this shell does not control.
    void switchMode(requested).catch(async (error: unknown) => {
      log.error(`desktop mode: switching to ${requested} failed`, error)
      await ordinaryMessageBox({
        type: 'error',
        title: messages.switchFailedTitle,
        message: messages.switchFailedDetail,
        detail: error instanceof Error ? error.message : String(error),
      })
    })
  })

  ipcMain.handle(DESKTOP_IPC.boot, async (event) => {
    assertDesktopSender(event, ['app'])
    await startup
    if (backend.host === undefined || hostUrl === undefined) throw new Error('Desktop Host is unavailable')
    return { injections, streamBaseUrl: new URL(hostUrl).origin }
  })

  ipcMain.handle(DESKTOP_IPC.bootFailed, (event, message: unknown) => {
    assertDesktopSender(event, ['app'])
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('dsh desktop: rejected startup failure from a non-primary frame')
    }
    if (typeof message !== 'string') throw new Error('dsh desktop: startup failure must be text')
    reportFatal(new Error(message))
  })

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*'] }, (details, callback) => {
    if (hostUrl === undefined || hostCookie === undefined || details.webContentsId !== mainWindow?.webContents.id) {
      callback({})
      return
    }
    const target = new URL(hostUrl)
    const requested = new URL(details.url)
    if (requested.host !== target.host) { callback({}); return }
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
    if (headers.origin !== 'dsh-app://app') { callback({ cancel: true }); return }
    callback({ requestHeaders: { ...headers, origin: target.origin, cookie: hostCookie, 'sec-fetch-site': 'same-origin' } })
  })

  // Only the main window may synchronize its palette with the native material.
  ipcMain.on(DESKTOP_IPC.nativeThemeSet, (event, source: unknown) => {
    if (mainWindow === undefined || event.sender !== mainWindow.webContents) return
    if (source === 'light' || source === 'dark' || source === 'system') nativeTheme.themeSource = source
  })
  ipcMain.handle(DESKTOP_IPC.updatesStatus, (event) => {
    assertProductSender(event)
    return presentDesktopUpdate(updates.state)
  })
  ipcMain.handle(DESKTOP_IPC.updatesOpen, async (event) => {
    assertProductSender(event)
    await openUpdatePrompt()
  })

  let promptOperation: Promise<void> | undefined
  let policyAuthenticationQueued = false
  const openUpdatePrompt = (manual = false): Promise<void> => {
    if (authenticationOperation !== undefined) {
      policyAuth?.focus(); updateDialog.focus()
    }
    let failedOperation: 'check' | 'download' | 'install' = 'check'
    promptOperation ??= Promise.resolve().then(async () => {
      if (manual) updateJournal?.action('check-requested')
      const joinedPolicyAuthentication = authenticationOperation !== undefined
      if (joinedPolicyAuthentication) await authenticatePolicy()
      if (isMandatory()) {
        mandatoryUI?.focus()
        if (manual) await Promise.all([checkPolicyManually(), updateSchedule.check(true)])
        return
      }
      let state = updates.state
      if (manual || state.phase === 'idle' || (state.phase === 'error' && state.failedOperation === 'check')) {
        const controller = new AbortController()
        ordinaryDialogs.add(controller)
        const progress = mainWindow === undefined ? Promise.resolve() : updateDialog.show(mainWindow, { type: 'info', title: messages.updateCheckTitle,
          message: messages.updateChecking, buttons: [messages.later], cancelId: 0, signal: controller.signal })
        try {
          if (!joinedPolicyAuthentication) {
            void checkPolicyManually('deferred').catch((error: unknown) => { console.error(error) })
          }
          state = await updateSchedule.check(true)
        } finally { controller.abort(); ordinaryDialogs.delete(controller); await progress }
      }
      if (isMandatory()) { mandatoryUI?.focus(); return }
      if (state.phase === 'error' && state.failedOperation === 'check') { await showUpdateFailure(state); return }
      if (state.phase === 'idle') {
        await ordinaryMessageBox({ type: 'info', title: messages.updateCheckTitle,
          message: formatDesktopMessage(messages.updateCurrent, { version: app.getVersion() }) })
        return
      }
      if (state.phase === 'ready' || (state.phase === 'error' && state.failedOperation === 'install')) {
        if (state.version !== undefined) {
          failedOperation = 'install'
          await showUpdateFailure(await updates.install(state.version))
        }
        return
      }
      if (state.phase !== 'available' && !(state.phase === 'error' && state.failedOperation === 'download')) return
      if (manual) {
        const result = await ordinaryMessageBox({ title: messages.updateCheckTitle, message: messages.updateAvailable,
          detail: formatDesktopMessage(messages.updateDetail, { version: state.version ?? '' }),
          buttons: [messages.updateDownload], cancelId: 1 })
        if (result.response !== 0) return
      }
      if (!isMandatory() && state.version !== undefined) {
        failedOperation = 'download'
        await showUpdateFailure(await downloadUpdate(state.version))
      }
    }).catch((error: unknown) => showUpdateFailure({ phase: 'error', failedOperation,
      message: desktopErrorState(error).message }))
      .finally(() => { promptOperation = undefined; flushQueuedPolicyAuthentication() })
    return promptOperation
  }

  let authenticationOperation: Promise<DesktopPolicyState | undefined> | undefined
  const authenticatePolicy = () => {
    if (authenticationOperation !== undefined) { policyAuth?.focus(); updateDialog.focus() }
    authenticationOperation ??= runPolicyAuthentication().finally(() => { authenticationOperation = undefined })
    return authenticationOperation
  }
  const flushQueuedPolicyAuthentication = (): void => {
    if (!policyAuthenticationQueued || promptOperation !== undefined || authenticationOperation !== undefined
      || isMandatory() || quitting) return
    policyAuthenticationQueued = false
    void authenticatePolicy().catch((error: unknown) => { console.error(error) })
  }
  const queuePolicyAuthentication = (): void => {
    if (authenticationOperation !== undefined) {
      policyAuth?.focus(); updateDialog.focus()
      return
    }
    policyAuthenticationQueued = true
    flushQueuedPolicyAuthentication()
  }
  const runPolicyAuthentication = async () => {
    if (policyAuth === undefined || mandatoryPolicy === undefined || quitting) return undefined
    const parent = mandatoryUI?.confirmationWindow ?? mainWindow
    if (parent === undefined) return undefined
    const consent = await updateDialog.show(parent, { type: 'info', title: messages.policyLoginTitle,
      message: messages.policyLoginRequired, buttons: [messages.policyLogin, messages.later], cancelId: 1 })
    if (consent.response !== 0 || isQuitting()) return undefined
    const outcome = await policyAuth.login()
    if (isQuitting() || outcome === 'cancelled') return undefined
    if (outcome === 'failed') {
      await updateDialog.show(parent, { type: 'error', title: messages.policyLoginTitle,
        message: messages.policyLoginFailed, buttons: [messages.updateAcknowledge], cancelId: 0 })
      return undefined
    }
    // Drain a pre-login request before asking the server to evaluate the new cookies.
    await mandatoryPolicy.check('login-return')
    if (isQuitting()) return undefined
    return mandatoryPolicy.check('login-return', true)
  }

  const checkPolicyManually = async (authentication: 'immediate' | 'deferred' = 'immediate') => {
    if (authenticationOperation !== undefined) return authenticatePolicy()
    const policy = await mandatoryPolicy?.check('manual', true)
    if (policy?.error !== 'authentication-required') return policy
    if (authentication === 'immediate') return authenticatePolicy()
    queuePolicyAuthentication()
    return policy
  }

  const automaticCheck = (): void => {
    if (!quitting) void mandatoryPolicy?.check('foreground-or-resume').catch((error: unknown) => { console.error(error) })
    if (!quitting) void updateSchedule.check().catch((error: unknown) => { console.error(error) })
  }
  powerMonitor.on('resume', automaticCheck)
  app.on('will-quit', () => {
    updateSchedule.dispose()
    archive?.dispose()
    powerMonitor.off('resume', automaticCheck)
    updates.dispose()
  })

  app.setAboutPanelOptions({
    applicationName: 'DeepSeek Harness',
    applicationVersion: app.getVersion(),
    // The release has no separate build number; omit Electron's bundle version.
    version: '',
    copyright: '',
    iconPath: development ? join(app.getAppPath(), 'resources', 'icon-windows.png')
      : join(process.resourcesPath, 'icon.png'),
  })
  // A custom application menu replaces Electron's default menu, so macOS needs
  // its standard menus and application hide commands declared explicitly.
  const darwin = process.platform === 'darwin'
  const platformMenus: MenuItemConstructorOptions[] = darwin
    ? [{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]
    : [{ role: 'editMenu' }]
  const hideCommands: MenuItemConstructorOptions[] = darwin
    ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }]
    : []
  const modeItems = (): MenuItemConstructorOptions[] => [
    {
      label: currentDesktopLocale().messages.modeLocal,
      type: 'radio',
      checked: mode === 'local',
      click: () => { void switchMode('local') },
    },
    {
      label: currentDesktopLocale().messages.modeServer,
      type: 'radio',
      checked: mode === 'server',
      enabled: serverConfig !== undefined,
      click: () => { void switchMode('server') },
    },
  ]
  const applicationItems = (): MenuItemConstructorOptions[] => [
    { label: currentDesktopLocale().messages.aboutMenu, role: 'about' },
    { type: 'separator' },
    { label: currentDesktopLocale().messages.checkUpdatesMenu, click: () => { void openUpdatePrompt(true) } },
    // The schedule is invisible while it works, so the same command is offered
    // on demand; it shares the one in-flight guard with the timer.
    ...archive === undefined ? [] : [{
      label: currentDesktopLocale().messages.archiveNowMenu,
      click: () => { void runArchiveNow() },
    }],
    // Both modes are reachable from here, and the menu is rebuilt per popup, so
    // the radio marks the mode the window is showing right now.
    { label: currentDesktopLocale().messages.modeMenu, submenu: modeItems() },
    { type: 'separator' },
    ...hideCommands,
    { role: 'quit', ...(process.platform === 'win32' ? { label: currentDesktopLocale().messages.exitApplication } : {}) },
  ]
  Menu.setApplicationMenu(process.platform === 'win32' ? null : Menu.buildFromTemplate([{
    label: darwin ? app.name : currentDesktopLocale().messages.application,
    submenu: applicationItems(),
  }, ...platformMenus]))

  if (process.platform === 'win32') {
    ipcMain.handle(DESKTOP_IPC.windowsMenu, (event, name: unknown, x: unknown, y: unknown) => {
      // The caption menubar is shell UI drawn into whichever document the window
      // shows, so this one request is accepted from the main window's own top
      // frame rather than only from the bundled application: in server mode the
      // bar stands in a deployment's page, and it pops a menu the person still
      // has to click. The request itself carries no page-supplied authority — a
      // menu name and two coordinates — and every other handler keeps the origin
      // check.
      if (mainWindow === undefined || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('desktop menu: rejected sender')
      if ((name !== 'application' && name !== 'edit')
        || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
        || x < 0 || y < 0 || x > 100_000 || y > 100_000) throw new Error('desktop menu: invalid popup request')
      const window = mainWindow
      // Editor-owned history listens to key events rather than Chromium's native undo stack.
      const editItem = (label: string, keyCode: string, modifiers: Array<'control'>, accelerator?: string): MenuItemConstructorOptions => ({
        label,
        ...(accelerator === undefined ? {} : { accelerator }),
        click: () => {
          window.webContents.focus()
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
        },
      })
      const items: MenuItemConstructorOptions[] = name === 'application' ? applicationItems() : [
        editItem(currentDesktopLocale().messages.undo, 'Z', ['control'], 'Ctrl+Z'),
        editItem(currentDesktopLocale().messages.redo, 'Y', ['control'], 'Ctrl+Y'),
        { type: 'separator' },
        editItem(currentDesktopLocale().messages.cut, 'X', ['control'], 'Ctrl+X'),
        editItem(currentDesktopLocale().messages.copy, 'C', ['control'], 'Ctrl+C'),
        editItem(currentDesktopLocale().messages.paste, 'V', ['control'], 'Ctrl+V'),
        editItem(currentDesktopLocale().messages.delete, 'Delete', []),
        { type: 'separator' },
        editItem(currentDesktopLocale().messages.selectAll, 'A', ['control'], 'Ctrl+A'),
      ]
      const zoom = mainWindow.webContents.getZoomFactor()
      return new Promise<void>((resolve) => {
        Menu.buildFromTemplate(items).popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom), callback: resolve })
      })
    })
    ipcMain.on(DESKTOP_IPC.windowsAppearance, (event, language: unknown, color: unknown, symbolColor: unknown) => {
      if (mainWindow === undefined || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) return
      if (!event.senderFrame.url.startsWith(`${SCHEME}://app/`)) return
      if (typeof language === 'string' && /^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/u.test(language)) {
        windowsLanguage = language
      }
      // Empty colors precede client stylesheet installation; only CSS color values cross IPC.
      const validColor = (value: unknown): value is string => typeof value === 'string'
        && /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu.test(value)
      if (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
    })
  }

  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, true, true, url => serverNavigationAllowed(serverConfig, url))
    mainWindow = window
    window.on('focus', automaticCheck)
    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
    window.webContents.on('did-finish-load', () => {
      // The document is new after every switch and every reload, so the mode it
      // must show is re-published rather than assumed to have survived.
      reportServerModeLoaded()
    })
    window.on('page-title-updated', (event) => {
      // In local mode the document title is the session name and belongs to the
      // page. In server mode the title carries which deployment is on screen,
      // and the remote page's own <title> would replace it — the taskbar and
      // Alt-Tab are two of the few places the mode stays visible while the
      // document covers the rest of the frame.
      if (mode === 'server') event.preventDefault()
    })
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || quitting || window.isDestroyed()) return
      if (mode === 'server') {
        // Native recovery exists to repair the bundled runtime. A deployment
        // that is unreachable is not a damaged installation, so offer the two
        // actions that can actually help instead of the plugin-repair advice.
        void handleServerLoadFailure(url)
        return
      }
      reportFatal(new Error(`Desktop page failed to load: ${url} (${String(code)}: ${description})`))
    })
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || !input.alt) return
      const requested: DesktopMode | undefined = input.code === 'Digit1' ? 'server' : input.code === 'Digit2' ? 'local' : undefined
      if (requested === undefined) return
      event.preventDefault()
      void switchMode(requested)
    })
    window.webContents.on('preload-error', (_event, _path, error) => {
      if (!quitting && !window.isDestroyed()) reportFatal(error)
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      navigation = undefined
      if (!quitting && !window.isDestroyed() && details.reason !== 'clean-exit') {
        reportFatal(new Error(`Desktop renderer exited: ${details.reason}`))
      }
    })
    return window
  }
  /**
   * Offer retry or a return to local mode after the deployment failed to load.
   * @param url - the document that failed, quoted back to the user.
   */
  const handleServerLoadFailure = async (url: string): Promise<void> => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed() || quitting) return
    const origin = serverConfig?.origin ?? url
    const result = await updateDialog.show(window, {
      type: 'error',
      title: messages.serverUnreachableTitle,
      message: formatDesktopMessage(messages.serverUnreachableDetail, { origin }),
      buttons: [messages.serverRetry, messages.serverSwitchToLocal],
      cancelId: 0,
    })
    if (quitting) return
    if (result.response === 1) { await switchMode('local'); return }
    navigation = undefined
    await navigateMain(modeUrl()).catch((error: unknown) => { console.error(error) })
  }
  focusPrimaryWindow = () => {
    if (quitting) return
    if (isMandatory()) { mandatoryUI?.focus(); return }
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) {
      try { createMainWindow() } catch (error) { reportFatal(error); return }
      void navigateMain(modeUrl()).catch(reportFatal)
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusPrimaryWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    shuttingDown = true
    updateJournal?.action('quit-requested')
    if (shellInstallerOwnsQuit) {
      updateDialog.dispose()
      mandatoryUI?.dispose()
      return
    }
    if (quitting) return
    event.preventDefault()
    quitting = true
    mainWindow?.hide()
    updateSchedule.dispose()
    updateDialog.dispose()
    mandatoryUI?.dispose()
    void Promise.all([Promise.resolve(mandatoryPolicy?.dispose()).then(() => policyAuth?.dispose()), backend.close()])
      .catch((error: unknown) => { console.error(error) }).finally(() => { app.quit() })
  })

  mainWindow = createMainWindow()
  applyModeChrome()
  archive?.start()
  const developmentPolicy = app.isPackaged ? undefined : process.env.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG
  const policyInput: unknown = app.isPackaged
    ? ('dshMandatoryUpdatePolicy' in manifest ? manifest.dshMandatoryUpdatePolicy : undefined)
    : developmentPolicy === undefined ? undefined : JSON.parse(developmentPolicy) as unknown
  const policyConfig = resolveDesktopPolicyConfig(policyInput, !app.isPackaged)
  if (policyConfig !== undefined) {
    if (policyConfig.authentication === 'feishu-test') {
      policyAuth = new DesktopPolicyTestAuth(policyConfig.origin, locale, () => mandatoryUI?.confirmationWindow ?? mainWindow,
        (event) => { console.info(`desktop policy authentication: ${event}`); updateJournal?.action(`policy-login-${event}`) })
    }
    const bundleId = app.isPackaged
      ? ('dshDesktopAppId' in manifest ? manifest.dshDesktopAppId : undefined)
      : process.env.DSH_DESKTOP_APP_ID
    if (typeof bundleId !== 'string' || bundleId.trim() === '') throw new Error('desktop policy: missing application bundle ID')
    if (!['win32', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('desktop policy: unsupported platform')
    let wasBlocking = false
    mandatoryPolicy = new DesktopMandatoryUpdatePolicy(policyConfig, {
      platform: process.platform === 'win32' ? 'desktop-win' : 'desktop-mac', arch: process.arch as 'x64' | 'arm64',
      version: app.getVersion(), bundledDshVersion: app.isPackaged ? readDesktopRuntime(resources.dsh).release.version : app.getVersion(),
      bundleId, locale: locale.id,
    }, (state) => {
      if (state.error !== 'authentication-required') policyAuthenticationQueued = false
      if (state.blocking) {
        for (const controller of ordinaryDialogs) controller.abort()
        if (!wasBlocking) updateDialog.cancel()
      }
      mandatoryUI?.sync()
      if (state.blocking && !wasBlocking) void updateSchedule.check(false, true).catch((error: unknown) => { console.error(error) })
      wasBlocking = state.blocking
    }, policyAuth?.request)
    const policy = mandatoryPolicy
    mandatoryUI = new DesktopMandatoryUpdateWindow({
      preload: fileURLToPath(new URL('./preload-mandatory.cjs', import.meta.url)), locale,
      allowedPageOrigins: policyConfig.allowedPageOrigins, parent: () => mainWindow,
      policy: () => policy.state, update: () => updates.state,
      refresh: async () => { await Promise.all([checkPolicyManually(), updateSchedule.check(true)]) },
      download: downloadUpdate, install: version => updates.install(version),
    })
    void mandatoryPolicy.check('launch').then((state) => {
      if (app.isPackaged && state.error === 'authentication-required' && !isQuitting()) queuePolicyAuthentication()
    }).catch((error: unknown) => { console.error(error) })
  }
  automaticCheck()
  await reconcileBackend().catch(() => undefined)
  // Window lifecycle callbacks run while backend startup is pending.
  if (isQuitting()) return
  const window = currentMainWindow()
  if (window !== undefined && development && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
    window.webContents.openDevTools({ mode: 'detach' })
  }
  publishUpdate(updateState)
}

const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })

if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
  }
  reportFatal(error)
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
