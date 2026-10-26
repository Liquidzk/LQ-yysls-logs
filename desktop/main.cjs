// SPDX-License-Identifier: GPL-3.0-or-later
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, session, globalShortcut } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const { CaptureManager } = require('./capture-manager.cjs')
const ROOT = path.resolve(__dirname, '..')
app.setName('LQ 燕云 Logs')
const qaIndex = process.argv.indexOf('--validation-data')
const qaRoot = qaIndex > 0 && process.argv[qaIndex + 1] ? path.resolve(process.argv[qaIndex + 1]) : null
if (qaRoot) { fs.mkdirSync(path.join(qaRoot, 'preferences'), { recursive: true }); app.setPath('userData', path.join(qaRoot, 'preferences')) }
let main, overlay, tray, engine, captureManager, origin, quitting = false, settings, preferenceFile
let overlaySource = 'live', overlayLocked = false
const preferenceKeys = ['yanyun-last-review', 'yanyun-review-view', 'yanyun-overlay-v2']
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback } }
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file) }
if (!app.requestSingleInstanceLock()) { app.quit() } else {
  app.on('second-instance', () => { if (main) { main.restore(); main.show(); main.focus() } })
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('燕云 Logs 启动失败', error.message)
    if (engine) engine.stdin.end('stop\n')
    app.quit()
  })
}
function trusted(event) {
  try { return new URL(event.senderFrame.url).origin === origin } catch { return false }
}
function prefs() { return readJson(preferenceFile, {}) }
function secureWindow(options) {
  const win = new BrowserWindow({ backgroundColor: '#10171c', show: false,
    ...options, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin + '/kagerou/config')) openConfig()
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== origin) e.preventDefault() })
  win.webContents.on('render-process-gone', (_, detail) => {
    if (!quitting) dialog.showMessageBox(win, { type: 'error', message: '界面已停止，可从菜单重新加载。', detail: detail.reason })
  })
  win.once('ready-to-show', () => win.show())
  return win
}
async function openOverlay(source) {
  if (['live', 'review'].includes(source)) overlaySource = source
  if (overlay && !overlay.isDestroyed()) { overlay.show(); overlay.webContents.send('overlay:state', { source: overlaySource, locked: overlayLocked }); return }
  const bounds = readJson(path.join(app.getPath('userData'), 'overlay-window.json'), {})
  overlay = secureWindow({ width: 600, height: 440, minWidth: 380, minHeight: 220, frame: false, transparent: true, backgroundColor: '#00000000',
    ...bounds, title: '燕云 Logs · 实时统计', alwaysOnTop: true })
  overlay.setMenuBarVisibility(false)
  overlay.on('close', () => writeJson(path.join(app.getPath('userData'), 'overlay-window.json'), overlay.getBounds()))
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setIgnoreMouseEvents(overlayLocked, { forward: true })
  await overlay.loadURL(origin + '/kagerou/yanyun/')
}
async function openConfig() { await openOverlay(); overlay.webContents.send('overlay:settings') }
function toggleLock() {
  overlayLocked = !overlayLocked
  if (overlay && !overlay.isDestroyed()) { overlay.setIgnoreMouseEvents(overlayLocked, { forward: true }); overlay.webContents.send('overlay:state', { source: overlaySource, locked: overlayLocked }) }
}

async function start() {
  const localFile = path.join(app.isPackaged ? path.dirname(process.execPath) : ROOT, 'desktop.local.json')
  settings = { ...readJson(localFile, {}), ...readJson(path.join(app.getPath('userData'), 'paths.json'), {}) }
  settings.dataDir = settings.dataDir || path.join(app.getPath('userData'), 'data')
  settings.logRoot = settings.logRoot || path.join(app.getPath('userData'), 'game-logs')
  if (qaRoot) { settings.dataDir = path.join(qaRoot, 'data'); settings.logRoot = path.join(qaRoot, 'game-logs') }
  preferenceFile = path.join(app.getPath('userData'), 'review-preferences.json')
  const resources = app.isPackaged ? process.resourcesPath : ROOT
  const binary = path.join(resources, app.isPackaged ? 'engine' : 'runtime/engine', 'yanyun-engine.exe')
  const kagerou = path.join(resources, app.isPackaged ? 'kagerou' : 'vendor/kagerou')
  const assets = path.join(resources, app.isPackaged ? 'assets' : 'desktop/assets')
  const captureRoot = path.join(settings.dataDir, 'captures')
  captureManager = new CaptureManager(path.join(resources, app.isPackaged ? 'collector' : 'runtime/collector'), captureRoot)
  captureManager.save({ running: false, state: 'unbound' })
  if (!fs.existsSync(binary)) throw new Error('缺少解析引擎。请先运行构建脚本，或使用完整客户端目录。')
  fs.mkdirSync(settings.dataDir, { recursive: true })
  const logs = fs.openSync(path.join(settings.dataDir, 'desktop-engine.log'), 'a')
  engine = spawn(binary, ['--data-dir', settings.dataDir, '--log-root', settings.logRoot,
    '--kagerou-root', kagerou, '--assets-root', assets, '--capture-root', captureRoot, '--no-watch'], { windowsHide: true, stdio: ['pipe', 'pipe', logs] })
  fs.closeSync(logs)
  const port = await new Promise((resolve, reject) => {
    let ready = false
    const timeout = setTimeout(() => reject(new Error('解析引擎未能在 30 秒内启动，请查看归档目录的 desktop-engine.log。')), 30000)
    engine.once('error', e => { clearTimeout(timeout); reject(e) })
    engine.once('exit', code => { clearTimeout(timeout); if (!ready) reject(new Error('解析引擎启动失败，退出码：' + code)) })
    readline.createInterface({ input: engine.stdout }).on('line', line => {
      try { const value = JSON.parse(line); if (value.ready && Number.isInteger(value.port)) { ready = true; clearTimeout(timeout); resolve(value.port) } } catch {}
    })
  })
  origin = 'http://127.0.0.1:' + port
  session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onBeforeRequest((detail, callback) => {
    callback({ cancel: !detail.url.startsWith(origin + '/') && !detail.url.startsWith('data:') && !detail.url.startsWith('blob:' + origin) })
  })
  session.defaultSession.webRequest.onHeadersReceived((detail, callback) => {
    callback({ responseHeaders: { ...detail.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'"] } })
  })
  ipcMain.on('preferences:read', event => { event.returnValue = trusted(event) ? prefs() : {} })
  ipcMain.on('preferences:save', (event, value) => {
    if (!trusted(event) || !value || typeof value !== 'object') return
    const next = prefs()
    for (const key of preferenceKeys) if (typeof value[key] === 'string' && value[key].length < 100000) next[key] = value[key]
    writeJson(preferenceFile, next)
  })
  ipcMain.handle('overlay:show', (event, source) => { if (trusted(event)) return openOverlay(source || 'review') })
  ipcMain.handle('capture:processes', event => { if (trusted(event)) return captureManager.processes() })
  ipcMain.handle('capture:start', (event, request) => { if (trusted(event)) return captureManager.start(request) })
  ipcMain.handle('capture:stop', event => { if (trusted(event)) return captureManager.stop() })
  ipcMain.handle('capture:import', async event => {
    if (!trusted(event)) return
    const result = await dialog.showOpenDialog(main, { title: '选择 capture 或包含 sessions 的捕获记录目录', properties: ['openDirectory'] })
    if (result.canceled) return { canceled: true }
    const response = await fetch(origin + '/api/capture/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Yanyun-Local': '1' }, body: JSON.stringify({ path: result.filePaths[0] }) })
    const data = await response.json(); if (!response.ok) throw Error(data.error); return data
  })
  ipcMain.handle('capture:folder', event => { if (trusted(event)) return shell.openPath(captureRoot) })
  ipcMain.handle('overlay:state', event => trusted(event) ? { source: overlaySource, locked: overlayLocked } : {})
  ipcMain.on('overlay:command', (event, action) => {
    if (!trusted(event)) return
    if (action === 'lock') toggleLock()
    if (action === 'hide') overlay?.hide()
    if (action === 'review') { main.show(); main.focus() }
  })
  ipcMain.on('review:actor', (event, id) => {
    if (trusted(event) && /^a_[a-f0-9]{20}$/.test(id)) { main.show(); main.focus(); main.webContents.send('review:actor', id) }
  })
  const showMain = () => { main.restore(); main.show(); main.focus() }
  const menu = [
    { label: '燕云 Logs', submenu: [
      { label: '战斗复盘', click: showMain }, { label: '实时悬浮窗', click: () => openOverlay('live') },
      { label: '悬浮窗外观', click: openConfig }, { label: '本地 CLv2 复盘', click: () => main.loadURL(origin + '/review') }, { label: '实时采集与捕获记录', click: () => main.loadURL(origin + '/') }, { type: 'separator' },
      { label: '打开战斗归档', click: () => shell.openPath(settings.dataDir) },
      { label: '选择游戏日志目录…', click: async () => {
        const chosen = await dialog.showOpenDialog(main, { title: '选择 ClientLocalLog 文件夹', properties: ['openDirectory'] })
        if (!chosen.canceled) { writeJson(path.join(app.getPath('userData'), 'paths.json'), { ...settings, logRoot: chosen.filePaths[0] });
          dialog.showMessageBox(main, { message: '已保存日志目录，重启客户端后生效。' }) }
      } }, { type: 'separator' }, { label: '退出', role: 'quit' }
    ] },
    { label: '窗口', submenu: [
      { label: '重新加载', role: 'reload' }, { label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' }, { label: '原始比例', role: 'resetZoom' },
      { label: '悬浮窗鼠标穿透', click: toggleLock }
    ] },
    { label: '帮助', submenu: [{ label: '关于与数据范围', click: () => dialog.showMessageBox(main, { title: '燕云 Logs 0.4', message: '燕云 Logs · 实时采集与战斗复盘',
      detail: '手动选择进程后采集服务器消息，也可解析本地 CLv2。\n网络事件按接收时间记录，完整队友动作及私有 Buff 尚未验证，未启用 rDPS。\n悬浮界面源于 Kagerou，保留 GPL-3.0-or-later 与第三方声明。' }) }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu))
  const bounds = readJson(path.join(app.getPath('userData'), 'main-window.json'), {})
  main = secureWindow({ width: 1360, height: 900, minWidth: 1000, minHeight: 700, ...bounds, title: '燕云 Logs · 战斗复盘' })
  main.on('close', event => {
    writeJson(path.join(app.getPath('userData'), 'main-window.json'), main.getBounds())
    if (!quitting) { event.preventDefault(); app.quit() }
  })
  const pixels = Buffer.alloc(16 * 16 * 4)
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 180; pixels[i + 1] = 205; pixels[i + 2] = 94; pixels[i + 3] = 255 }
  tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }))
  tray.setToolTip('燕云 Logs · 本机战斗复盘')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '战斗复盘', click: showMain }, { label: '实时悬浮窗', click: () => openOverlay('live') }, { label: '退出', role: 'quit' }]))
  tray.on('double-click', showMain)
  engine.on('exit', () => { if (!quitting) dialog.showMessageBox(main, { type: 'error', message: '归档引擎已停止。请重启客户端；已有日志保留。' }) })
  globalShortcut.register('CommandOrControl+Shift+F8', toggleLock)
  globalShortcut.register('CommandOrControl+Shift+F9', () => { if (overlay && !overlay.isDestroyed() && overlay.isVisible()) overlay.hide(); else openOverlay() })
  await main.loadURL(origin + '/')
}
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault(); quitting = true
  globalShortcut.unregisterAll()
  ;(async () => {
    await captureManager?.stop().catch(() => {})
    if (engine && engine.exitCode === null) {
      engine.stdin.end('stop\n')
      await new Promise(resolve => {
        const timer = setTimeout(() => { engine.kill(); resolve() }, 6000)
        engine.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
    app.quit()
  })()
})
app.on('window-all-closed', () => app.quit())
