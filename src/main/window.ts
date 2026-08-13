import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'

export function createMainWindow(
  onCreated?: (window: BrowserWindow) => void,
  onFatalError?: () => void,
  options: { readonly alwaysOnTop?: boolean } = {},
): BrowserWindow {
  let fatalErrorReported = false
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    show: false,
    alwaysOnTop: options.alwaysOnTop ?? false,
    title: 'QAing',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b1020',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      // Sandboxed preloads run in Electron's restricted CommonJS context. The
      // build pins this exact filename and format in electron.vite.config.ts.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  })
  const showLoadFailure = (): void => {
    if (fatalErrorReported || window.isDestroyed()) return
    fatalErrorReported = true
    onFatalError?.()
    if (!window.isDestroyed()) window.show()
    dialog.showErrorBox(
      'QAing 界面加载失败',
      '应用核心已经安全停止，已有本地资料不会丢失。请重新启动 QAing。',
    )
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) showLoadFailure()
  })
  window.webContents.on('preload-error', () => showLoadFailure())
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') showLoadFailure()
  })
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)

  onCreated?.(window)
  window.once('ready-to-show', () => window.show())
  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL']).catch(() => showLoadFailure())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html')).catch(() => showLoadFailure())
  }
  return window
}
