const test = require('node:test'), assert = require('node:assert/strict'), dgram = require('node:dgram')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), readline = require('node:readline')
const { execFileSync, spawn } = require('node:child_process')

test('KCP binding verifies the selected process UDP endpoint and stops when it closes', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const socket = dgram.createSocket('udp4'); await new Promise(r => socket.bind(0, '127.0.0.1', r))
  let socketOpen = true, child
  try {
    const startedAt = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true }).trim()
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'yanyun-kcp-watch-')), config = path.join(folder, 'config.json')
    fs.writeFileSync(config, JSON.stringify({ pid: process.pid, processStartUtc: startedAt, processPath: process.execPath, transport: 'kcp', bindingUdpPorts: [socket.address().port] }))
    child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../collector/tools/p1-live-session-watch.ps1'), '-Config', config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', b => { stderr += b })
    const rows = [], exited = new Promise(r => child.once('exit', r))
    readline.createInterface({ input: child.stdout }).on('line', line => {
      rows.push(JSON.parse(line)); if (rows.length === 1) { socket.close(); socketOpen = false }
    })
    assert.equal(await exited, 0, stderr)
    assert.equal(rows[0]?.valid, true, stderr); assert.equal(rows.at(-1)?.valid, false)
  } finally { if (socketOpen) socket.close(); if (child?.exitCode === null) child.kill() }
})
