const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawn } = require('node:child_process')
const wait = ms => new Promise(r => setTimeout(r, ms))
test('connected unsupported builds report compatibility separately and never start state reads', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yanyun-unknown-build-'))
  const scripts = path.join(root, 'tools'), data = path.join(root, 'data'), config = path.join(root, 'config')
  for (const dir of [scripts, data, config, path.join(root, 'Win64r')]) fs.mkdirSync(dir)
  for (const file of ['p2-session-service.cjs', 'p1-snapshot-publisher.cjs', 'client-profile.cjs']) fs.copyFileSync(path.join(__dirname, '../collector/tools', file), path.join(scripts, file))
  const modulePath = path.join(root, 'Win64r/yysls.exe')
  fs.writeFileSync(modulePath, 'fixture; not executable')
  fs.writeFileSync(path.join(config, 'client-build.json'), JSON.stringify({ id: 'fixture-supported', imageSha256: '0'.repeat(64) }))
  // Deliberately omit state reader and TShark: reaching either must fail this test.
  fs.writeFileSync(path.join(scripts, 'p2-discover.ps1'), `param([int]$GameProcessId,[string]$ExpectedStart)\n@{status='running';pid=$GameProcessId;processStartUtc=$ExpectedStart;modulePath='${modulePath.replaceAll("'", "''")}';flows=@(@{loopback=$true});connectionCounts=@{established=1;loopback=1}} | ConvertTo-Json -Depth 4 -Compress\n`)
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
    assert.match(status.detail, /已发现游戏连接（经过本地加速器\/转发）/)
    assert.match(status.detail, /Win64r 游戏版本尚未适配/)
    const report = JSON.parse(fs.readFileSync(path.join(data, 'unsupported-build.json')))
    assert.equal(report.pid, binding.pid); assert.equal(report.imageSha256.length, 64)
    assert.equal(fs.existsSync(path.join(data, 'sessions')), false)
    child.stdin.end()
    assert.equal(await exited, 0, stderr)
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited.catch(() => {}) }
})
