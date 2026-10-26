const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawn } = require('node:child_process')
const wait = ms => new Promise(r => setTimeout(r, ms))
test('supervisor exits on parent EOF during retry without selecting another process', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanyun-lifecycle-'))
  const scripts = path.join(root, 'tools'), data = path.join(root, 'data'); fs.mkdirSync(scripts); fs.mkdirSync(data)
  for (const file of ['p2-session-service.cjs', 'p1-snapshot-publisher.cjs']) fs.copyFileSync(path.join(__dirname, '../collector/tools', file), path.join(scripts, file))
  // A fake discovery result only. Never opens or enumerates real game processes.
  fs.writeFileSync(path.join(scripts, 'p2-discover.ps1'), `param([int]$GameProcessId,[string]$ExpectedStart)\n@{status='running';pid=$GameProcessId;processStartUtc=$ExpectedStart;flows=@()} | ConvertTo-Json -Compress\n`)
  const binding = { pid: 2147483647, startedAt: '2026-01-01T00:00:00Z' }, bindingFile = path.join(data, 'binding.private.json')
  fs.writeFileSync(bindingFile, JSON.stringify(binding))
  const child = spawn(process.execPath, [path.join(scripts, 'p2-session-service.cjs'), '--data', data, '--binding', bindingFile], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''; child.stderr.on('data', b => { stderr += b })
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  try {
    let status
    for (let n = 0; n < 100; n++) {
      try { status = JSON.parse(fs.readFileSync(path.join(data, 'service.json'))) } catch {}
      if (status?.message === '等待采集恢复') break
      await wait(100)
    }
    assert.equal(status?.message, '等待采集恢复', stderr)
    assert.equal(status.binding.pid, binding.pid); assert.equal(status.latestPath, null)
    child.stdin.end()
    let timer
    const code = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Collector did not stop on parent EOF')), 5000) })]).finally(() => clearTimeout(timer))
    assert.equal(code, 0, stderr)
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'service.json'))).message, '采集已停止')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited.catch(() => {})
  }
})
