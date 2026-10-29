// The renderer receives narrow actions, never a Node or filesystem handle.
const { contextBridge, ipcRenderer } = require('electron')
const keys = ['yanyun-last-review', 'yanyun-review-view', 'yanyun-overlay-v2', 'yanyun-timeline-layout-v1']
try {
  const saved = ipcRenderer.sendSync('preferences:read')
  for (const key of keys) if (typeof saved[key] === 'string' && localStorage.getItem(key) === null) localStorage.setItem(key, saved[key])
} catch {}
function save() {
  const state = {}
  for (const key of keys) { const value = localStorage.getItem(key); if (value !== null) state[key] = value }
  ipcRenderer.send('preferences:save', state)
}
window.addEventListener('DOMContentLoaded', () => { setInterval(save, 2000) })
window.addEventListener('beforeunload', save)
contextBridge.exposeInMainWorld('yanyunDesktop', {
  showKagerou: (source = 'review') => ipcRenderer.invoke('overlay:show', source),
  listProcesses: () => ipcRenderer.invoke('capture:processes'),
  startCapture: request => ipcRenderer.invoke('capture:start', request),
  stopCapture: () => ipcRenderer.invoke('capture:stop'),
  importCapture: () => ipcRenderer.invoke('capture:import'),
  openCaptureFolder: () => ipcRenderer.invoke('capture:folder'),
  starLatest: () => ipcRenderer.invoke('capture:star-latest'),
  onStarResult: callback => ipcRenderer.on('star:result', (_, result) => callback(result)),
  onRecordsChanged: callback => ipcRenderer.on('records:changed', (_, result) => callback(result)),
  overlayState: () => ipcRenderer.invoke('overlay:state'),
  overlayCommand: action => ipcRenderer.send('overlay:command', action),
  onOverlayState: callback => ipcRenderer.on('overlay:state', (_, state) => callback(state)),
  onOverlaySettings: callback => ipcRenderer.on('overlay:settings', callback),
  selectActor: id => ipcRenderer.send('review:actor', id),
  onSelectActor: callback => ipcRenderer.on('review:actor', (_, id) => callback(id))
})
