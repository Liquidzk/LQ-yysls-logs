// Explicit process binding and owned helper lifecycle. Never binds on app startup.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawn, execFile } = require('node:child_process')
const run = (file, args, options = {}) => new Promise((resolve, reject) => execFile(file, args,
  { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, ...options },
  (error, stdout) => error ? reject(error) : resolve(stdout.replace(/^\uFEFF/, ''))))
class CaptureManager {
  constructor(resources, data) { this.resources = resources; this.data = data; this.child = null; this.stopping = null; this.starting = null; this.binding = null }
  save(state) {
    fs.mkdirSync(this.data, { recursive: true })
    fs.writeFileSync(path.join(this.data, 'control.json.tmp'), JSON.stringify({ ...state, at: new Date().toISOString(), binding: this.binding }))
    fs.renameSync(path.join(this.data, 'control.json.tmp'), path.join(this.data, 'control.json'))
  }
  async processes() {
    const text = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.resources, 'tools/list-game-processes.ps1')])
    const rows = JSON.parse(text || '[]')
    return (Array.isArray(rows) ? rows : [rows]).filter(r => r && Number.isInteger(r.pid))
  }
  async start(request) {
    if (this.starting || this.stopping) throw Error('正在启动或停止采集，请稍候')
    this.starting = this.startSelected(request)
    try { return await this.starting } finally { this.starting = null }
  }
  async startSelected(request) {
    if (this.child && this.child.exitCode === null) throw Error('请先停止当前采集，再选择新的进程')
    if (!request || !Number.isInteger(request.pid) || typeof request.startedAt !== 'string') throw Error('请先手动选择游戏进程')
    const selected = (await this.processes()).find(p => p.pid === request.pid && p.startedAt === request.startedAt)
    if (!selected?.accessible) throw Error('所选进程已退出或无读取权限。请刷新列表；权限不足时可手动以管理员身份启动本客户端。')
    for (const file of ['runtime/node.exe', 'runtime/python/python.exe', 'runtime/wireshark/tshark.exe', 'tools/p2-session-service.cjs']) {
      if (!fs.existsSync(path.join(this.resources, file))) throw Error('缺少采集组件：' + file)
    }
    const npcap = path.join(process.env.WINDIR || 'C:/Windows', 'System32/Npcap/wpcap.dll')
    if (!fs.existsSync(npcap)) throw Error('未检测到 Npcap。请先安装抓包驱动，再开始采集。')
    this.binding = { pid: selected.pid, startedAt: selected.startedAt, path: selected.path }
    this.save({ running: false, state: 'starting' })
    // A new explicit binding must never show a previous session as current data.
    fs.writeFileSync(path.join(this.data, 'service.json'), JSON.stringify({
      message: '正在绑定所选进程', detail: '', latestPath: null, binding: this.binding, at: new Date().toISOString()
    }))
    fs.writeFileSync(path.join(this.data, 'binding.private.json'), JSON.stringify(this.binding))
    const log = fs.openSync(path.join(this.data, 'collector.stderr.log'), 'a')
    const child = spawn(path.join(this.resources, 'runtime/node.exe'), [path.join(this.resources, 'tools/p2-session-service.cjs'),
      '--data', this.data, '--binding', path.join(this.data, 'binding.private.json')],
    { cwd: this.resources, windowsHide: true, stdio: ['pipe', 'ignore', log] })
    fs.closeSync(log); this.child = child
    child.stdin.on('error', () => {})
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    } catch (error) {
      this.child = null; this.save({ running: false, state: 'error', message: error.message }); throw error
    }
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
    child.once('exit', (code, signal) => {
      if (this.child === child) { this.child = null; this.save({ running: false, state: code === 0 ? 'stopped' : 'error', code, signal }) }
    })
    this.save({ running: true, state: 'running', collectorPid: child.pid })
    return { ok: true, binding: this.binding }
  }
  async stop() {
    if (this.starting) await this.starting.catch(() => {})
    if (this.stopping) return this.stopping
    const child = this.child
    if (!child || child.exitCode !== null) { this.save({ running: false, state: 'stopped' }); return { ok: true } }
    this.stopping = (async () => {
      this.save({ running: true, state: 'stopping' })
      fs.writeFileSync(path.join(this.data, 'stop'), '')
      child.stdin.end('stop\n')
      let timer
      const ended = new Promise(resolve => { child.once('exit', resolve); timer = setTimeout(resolve, 18000) })
      await ended; clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) {
        // Only this owned helper's tree is terminated after graceful shutdown fails.
        await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(() => {})
      }
      this.child = null; this.save({ running: false, state: 'stopped' })
      return { ok: true }
    })().finally(() => { this.stopping = null })
    return this.stopping
  }
}
module.exports = { CaptureManager }
