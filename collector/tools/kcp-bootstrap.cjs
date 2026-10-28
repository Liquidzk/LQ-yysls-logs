'use strict'
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawn } = require('child_process'), readline = require('readline')
const { parseRow, assemble } = require('./kcp-stream.cjs')
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const route = p => JSON.stringify([p.iface, p.src, p.sport, p.dst, p.dport, p.envelope, p.segments[0].conversation])
const sleep = ms => new Promise(r => setTimeout(r, ms))

function captureFilter(remote, m) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(remote?.address) || remote.address.split('.').some(n => +n > 255) || !Number.isInteger(remote.port) || remote.port < 1 || remote.port > 65535) throw Error('KCP remote endpoint unavailable')
  const ip = Buffer.from(remote.address.split('.').map(Number)).readUInt32BE().toString(16)
  const clauses = []
  const ports = [...new Set((m.udpEndpoints || []).map(e => e.clientPort))].filter(p => Number.isInteger(p) && p > 0 && p <= 65535)
  if (ports.length) clauses.push(`(src host ${remote.address} and src port ${remote.port} and (${ports.map(p => 'dst port ' + p).join(' or ')}))`)
  // UU's observed IPv4 relay envelope is 4 zero bytes + remote IP + port.
  // Filter to the exact game endpoint read from the manually bound process.
  const peers = new Set()
  for (const f of m.flows || []) if (f.loopback && /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(f.serverAddress) && Number.isInteger(f.serverPort)) peers.add(`(src host ${f.serverAddress} and src port ${f.serverPort} and udp[8:4] = 0 and udp[12:4] = 0x${ip} and udp[16:2] = ${remote.port})`)
  clauses.push(...peers)
  if (!clauses.length || !ports.length) throw Error('所选游戏没有可验证的 UDP 端点，请重新绑定')
  return 'udp and (' + clauses.join(' or ') + ')'
}

async function bootstrapKcp({ m, recovery, boot, interfaces, python, tshark, node, run, children, profile, data, closing }) {
  const remote = recovery.remoteEndpoint, filter = captureFilter(remote, m)
  const dir = path.join(boot, 'kcp'); fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(m))
  const evidence = fs.openSync(path.join(dir, 'capture.private.tsv'), 'a')
  const fields = ['frame.number', 'frame.time_epoch', 'frame.interface_id', 'ip.src', 'udp.srcport', 'ip.dst', 'udp.dstport', 'udp.payload']
  // Keep one capture alive through validation and handoff: KCP sequence numbers
  // count segments, so gaps cannot be skipped using TCP byte sequence arithmetic.
  const capture = spawn(tshark, ['-l', '-n', '-B', '16', '-f', filter, ...interfaces.flatMap(i => ['-i', i]), '-s', '0', '-T', 'fields', '-E', 'separator=/t', '-E', 'occurrence=f', ...fields.flatMap(f => ['-e', f])], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(capture); capture.once('close', () => children.delete(capture))
  let buffer = [], bufferedBytes = 0, selected = null, target = null, failed = null, stopped = false, evidenceOpen = true
  const stop = () => { if (stopped) return; stopped = true; capture.kill(); if (evidenceOpen) { fs.closeSync(evidence); evidenceOpen = false } }
  capture.on('error', e => { failed = e; target?.stdin.destroy(e) })
  capture.on('close', code => { if (!stopped) { failed = Error('KCP capture stopped: ' + code); target?.stdin.end() } })
  capture.stderr.on('data', b => fs.appendFileSync(path.join(dir, 'capture.stderr.txt'), b))
  const forward = line => {
    if (!target || target.stdin.destroyed) return
    if (!target.stdin.write(line + '\n')) capture.stdout.pause()
  }
  readline.createInterface({ input: capture.stdout }).on('line', line => {
    if (stopped) return
    try {
      const packet = parseRow(line, remote)
      if (selected && target) { if (route(packet) === selected) forward(line); return }
      bufferedBytes += Buffer.byteLength(line)
      if (bufferedBytes > 32 * 1024 * 1024) throw Error('KCP initialization buffer exceeded limit')
      fs.writeSync(evidence, line + '\n'); buffer.push({ line, packet })
    } catch (e) { failed = e; if (target) target.stdin.destroy(e) }
  })
  const check = () => { if (closing()) throw Error('采集已停止'); if (failed) throw failed }
  try {
    for (let i = 0; i < 30; i++) { await sleep(200); check() }
    await run(python, [path.join(__dirname, 'p2-read-state.py'), dir]); check()
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'rpc-state-recovery.json')))
    if (state.status !== 'snapshot-ready' || state.transportProtocol !== 'KCP' || JSON.stringify(state.remoteEndpoint) !== JSON.stringify(remote)) throw Error('初始化期间 KCP 连接改变')
    for (let i = 0; i < 30; i++) { await sleep(200); check() }
    const groups = new Map()
    for (const row of buffer) { const k = route(row.packet); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(row.packet) }
    const answers = []; let ordinal = 0
    for (const [key, packets] of groups) {
      try {
        const stream = assemble(packets), stamp = Date.parse(state.snapshotAtUtc) / 1000
        const before = stream.rows.filter(r => r.time < stamp - 3), after = stream.rows.filter(r => r.time <= stamp + 3)
        if (stream.rows.length < 3 || !after.length) continue
        const candidate = path.join(dir, 'candidate-' + ++ordinal); fs.mkdirSync(candidate)
        const cipherFile = path.join(candidate, 'cipher.private.bin'); fs.writeFileSync(cipherFile, stream.cipher)
        const first = packets[0], flow = { serverAddress: first.src, serverPort: first.sport, clientAddress: first.dst, clientPort: first.dport }
        const align = { stateFile: state.stateObject, expectedVtable: state.expectedVtable, cipherFile,
          minCursor: before.at(-1)?.end || 0, maxCursor: after.at(-1).end, maxPrefix: 4096, python,
          outDir: path.join(candidate, 'aligned'), metadata: { pid: m.pid, flow, transport: 'kcp', remoteEndpoint: remote,
            kcpConversation: stream.conversation, kcpFirstSequence: stream.firstSequence, gaps: 0, overlapsVerified: true, captureStartTcpSequence: 0 } }
        const file = path.join(candidate, 'align.private.json'); fs.writeFileSync(file, JSON.stringify(align))
        await run(node, [path.join(__dirname, 'align-rc4-late-state.cjs'), file], { timeout: 120000 }); check()
        const report = path.join(align.outDir, 'report.json'), r = JSON.parse(fs.readFileSync(report))
        if (!r.unique || !r.roundTrip) continue
        answers.push({ key, config: { identityCacheFile: path.join(data, 'identity-cache.json'), clientBuildSha256: profile.imageSha256,
          pid: m.pid, processStartUtc: m.processStartUtc, processPath: m.modulePath, transport: 'kcp',
          flow, captureInterface: interfaces[first.iface], python, tshark, serverEncryptedOrigin: 0,
          bindingUdpPorts: m.udpEndpoints.map(e => e.clientPort),
          kcp: { conversation: stream.conversation, firstSequence: stream.firstSequence, envelope: first.envelope, remoteEndpoint: remote },
          initialStateFile: path.join(align.outDir, r.anchor.stateFile), initialStateSha256: r.anchor.stateSha256,
          cipherStateKind: 'validated-midstream', cipherAnchorReport: report, cipherAnchorReportSha256: sha(fs.readFileSync(report)),
          gapTimeoutMs: 3000, knownAcquisitionGaps: [{ kind: 'joined-existing-session', note: 'Earlier combat is unavailable.' }] } })
      } catch (e) { fs.appendFileSync(path.join(dir, 'alignment-errors.log'), e.message + '\n') }
    }
    check()
    if (answers.length !== 1) throw Error(answers.length ? 'KCP 有多个协议校验结果，未选择连接' : 'KCP 尚未得到唯一通过协议校验的状态，记录已保留')
    const answer = answers[0]; selected = answer.key
    return { config: answer.config, stop, attach(child) {
      target = child; target.stdin.on('error', () => stop()); target.stdin.on('drain', () => capture.stdout.resume())
      child.once('exit', stop)
      const initial = buffer.filter(r => route(r.packet) === selected).map(r => r.line).join('\n') + '\n'
      buffer = []; bufferedBytes = 0
      if (evidenceOpen) { fs.closeSync(evidence); evidenceOpen = false }
      if (!target.stdin.write(initial)) capture.stdout.pause()
    } }
  } catch (e) { stop(); throw e }
}
module.exports = { bootstrapKcp, captureFilter }
