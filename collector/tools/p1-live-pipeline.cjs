// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted from YyslsLogs 0.2.1. Passive capture after a manually bound session.
// Cumulative server counters, notifications and buff observations stay separate.
'use strict'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { spawn } = require('node:child_process'), readline = require('node:readline')
const { OrderedCipher, BlockStream, statisticFromBytes } = require('./p1-live-core.cjs')
const { damageEventsFromAreaSync } = require('./p1-rdps-damage-batch.cjs')
const { actionEventsFromAreaSync, actionEventFromProperty } = require('./action-events.cjs')
const { namesFromMatchWrapper } = require('./p1-identity-names.cjs')
const { decodeStatisticPayload, settlementFromObject } = require('./p1-settlement-details.cjs')
const { connectionBoundary } = require('./p1-capture-flags.cjs')
const { LedgerWriter } = require('./p1-ledger-writer.cjs')
const { SnapshotPublisher } = require('./p1-snapshot-publisher.cjs')
const { BattleArchive } = require('./battle-archive.cjs')
const { BattleTimer } = require('./battle-timer.cjs')
const { validIdentity, labelEvent } = require('./event-names.cjs')
const args = process.argv.slice(2), opts = {}
for (let i = 0; i < args.length; i += 2) opts[args[i].replace(/^--/, '')] = args[i + 1]
if (!opts.config || !opts.out) throw Error('config and new output directory required')
const configPath = path.resolve(opts.config), c = JSON.parse(fs.readFileSync(configPath))
const out = path.resolve(opts.out), mode = opts.replay ? 'replay' : 'live'
if (fs.existsSync(out)) throw Error('Refusing to overwrite an existing capture')
fs.mkdirSync(out, { recursive: true })
const hash = b => crypto.createHash('sha256').update(b).digest('hex')
const state = require('./p1-cipher-anchor.cjs').loadCipherAnchor(c)
const sessionId = hash(Buffer.from(JSON.stringify([c.pid, c.processStartUtc, c.flow, c.serverEncryptedOrigin, c.initialStateSha256]))).slice(0, 24)
const source = { mode, sessionId }, ledger = new LedgerWriter(), publisher = new SnapshotPublisher()
const battleTimer = new BattleTimer(sessionId)
const archive = new BattleArchive(out, source), identities = new Map()
if (c.identityCacheFile && fs.existsSync(c.identityCacheFile) && fs.statSync(c.identityCacheFile).size <= 2 * 1024 * 1024) {
  try { for (const row of JSON.parse(fs.readFileSync(c.identityCacheFile)).names || []) if (validIdentity(row)) identities.set(row.idHash, { ...row, cached: true }) } catch {}
}
const write = (file, data) => publisher.write(path.join(out, file), data)
const append = (file, data) => ledger.append(path.join(out, file), JSON.stringify(data) + '\n')
// New sessions may receive no fresh name packet. Make verified cached names
// available to replay immediately, including hits and buffs without counters.
if (identities.size) write('identities.json', { source, names: [...identities.values()] })
const counters = { packets: 0, blocks: 0, statistics: 0, damageEvents: 0, buffEvents: 0, rejectedEvents: 0, settlements: 0 }
let latest = { schemaVersion: 1, source, observedAt: null, actors: [], sequence: 0, npcNo: null, timeCostSeconds: 0,
  health: { status: 'starting', stale: true, gap: false, session: mode === 'live' ? 'pending' : 'recorded' } }
let clock = null, buffCoverage = { complete: false, attributionReady: false }, lastStatisticWall = 0
let lastPacketObservedAt = null
let stopped = false, failing = false, capture, watcher, tick, pumpTimer, startTimer, lastBindWall = 0, binding = null
let rawFd = null, rawReadFd = null, rawOffset = 0, rawSize = 0, rawPending = '', nextJob = 0, lastPublish = 0, publishTimer = null
const pending = new Map()
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ schemaVersion: 1, source, startedAt: new Date().toISOString(),
  mode, sessionId, configSha256: hash(fs.readFileSync(configPath)), pid: c.pid, processStartUtc: c.processStartUtc,
  limits: ['Only messages delivered to this client are visible.', 'Notification times are packet reception times.',
    'Cumulative counters are not summed with per-hit notifications.', 'Complete teammate casts/private buffs and rDPS remain unverified.'] }, null, 2))
function publish(force = false) {
  latest.battleTimer = battleTimer.snapshot()
  latest.lastPacketObservedAt = lastPacketObservedAt
  // Archive boundaries and counter sequences before UI publication is coalesced.
  try { archive.update(latest, [...identities.values()]) } catch (error) { append('archive-errors.jsonl', { message: error.message }) }
  if (!force && Date.now() - lastPublish < 500) {
    if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; publish(true) }, 500)
    return
  }
  lastPublish = Date.now()
  latest.publishedAt = new Date().toISOString()
  latest.buffCoverage = { complete: false, attributionReady: false, events: counters.buffEvents }
  latest.coverage = { complete: false, knownAcquisitionGaps: c.knownAcquisitionGaps || [], rejectedEventCount: counters.rejectedEvents,
    startupDiscardedPrefixBytes: blocks.skipped, clock: 'packet-reception' }
  write('latest.json', latest)
  write('health.json', { ...latest.health, at: latest.publishedAt, ...counters, rawBacklogBytes: rawSize - rawOffset + Buffer.byteLength(rawPending), pendingProto: pending.size })
  write('buff-coverage.json', { ...buffCoverage, complete: false, attributionReady: false, source })
}
function identify(rows, job) {
  for (const row of rows) {
    if (!validIdentity(row)) continue
    const entry = { ...row, observedAt: job.observedAt, transportRecordOrdinal: job.recordOrdinal }
    identities.set(row.idHash, entry); append('identity-events.jsonl', { ...entry, source })
  }
  if (rows.length) {
    write('identities.json', { source, names: [...identities.values()] })
    if (c.identityCacheFile) publisher.write(c.identityCacheFile, { names: [...identities.values()].slice(-5000) })
    latest.actors = latest.actors.map(a => ({ ...a, ...(identities.get(a.idHash) || {}) }))
  }
}
function receive(m, job) {
  lastPacketObservedAt = job.observedAt
  const stamp = { source, observedAt: job.observedAt, transportRecordOrdinal: job.recordOrdinal }
  identify(m.identityRows || [], job)
  for (const wrapper of m.identities || []) {
    try { identify(namesFromMatchWrapper(Buffer.from(wrapper.data, 'base64'), wrapper.methodIndex), job) }
    catch (error) { append('rejected-identities.jsonl', { ...stamp, reason: error.message }) }
  }
  for (const e of m.buffEvents || []) append('buff-events.jsonl', { ...labelEvent(e, identities), ...stamp, sequence: ++counters.buffEvents })
  if (m.buffCoverage) buffCoverage = m.buffCoverage
  for (const row of m.actionSyncs || []) {
    const result = actionEventFromProperty(row)
    for (const action of result.events) append('action-events.jsonl', { ...labelEvent(action, identities), ...stamp, sequence: counters.actionEvents = (counters.actionEvents || 0) + 1 })
    for (const rejection of result.rejected) append('rejected-actions.jsonl', { ...rejection, ...stamp })
  }
  for (const wrapper of m.events || []) {
    const result = damageEventsFromAreaSync(Buffer.from(wrapper.data, 'base64'), wrapper.targetActorHash, wrapper.methodIndex)
    for (const e of result.events) append('damage-events.jsonl', { ...labelEvent(e, identities), ...stamp, sequence: ++counters.damageEvents })
    for (const rejection of result.rejected) { counters.rejectedEvents++; append('rejected-events.jsonl', { ...rejection, ...stamp }) }
    const actions = actionEventsFromAreaSync(Buffer.from(wrapper.data, 'base64'), wrapper.targetActorHash, wrapper.methodIndex)
    for (const action of actions.events) append('action-events.jsonl', { ...labelEvent(action, identities), ...stamp, sequence: counters.actionEvents = (counters.actionEvents || 0) + 1 })
    for (const rejection of actions.rejected) append('rejected-actions.jsonl', { ...rejection, ...stamp })
  }
  for (const e of m.encounterEvents || []) {
    append('encounter-events.jsonl', { ...labelEvent(e, identities), ...stamp })
    if (e.kind === 'boss-battle-state' || e.kind === 'dungeon-finish-state') {
      const before = battleTimer.snapshot()
      battleTimer.boundary(e, job.observedAt)
      if (e.kind === 'boss-battle-state' && e.initial) clock = null
      if (e.kind === 'boss-battle-state' && e.active && e.previousActive === false && e.stateChanged && !e.initial) {
        clock = { source: { sessionId }, spaceHash: e.spaceHash, startObservedAt: job.observedAt, endObservedAt: null,
          npcNo: null, timingBasis: e.timingBasis, identityContext: e.identityContext }
      }
      const after = battleTimer.snapshot()
      if (clock?.spaceHash === e.spaceHash && after.endObservedAt && !clock.endObservedAt) clock.endObservedAt = after.endObservedAt
      if (before.phase !== after.phase || before.key !== after.key) append('timer-events.jsonl', { ...stamp, trigger: e.kind, battleTimer: after })
      // Terminal signals must not wait for another counter or the 500 ms coalescer.
      latest.encounterClock = clock; publish(true)
    }
  }
  for (const encoded of m.statistics || []) {
    try {
      const bytes = Buffer.from(encoded, 'base64'), decoded = decodeStatisticPayload(bytes)
      if (decoded.stat_type === 2) {
        const detail = settlementFromObject(decoded)
        append('settlement-details.jsonl', { ...detail, ...stamp, sequence: ++counters.settlements,
          encounterContext: clock ? { ...clock, association: 'receive-order-context' } : null })
        if (battleTimer.settlement(detail, job.observedAt)) {
          append('timer-events.jsonl', { ...stamp, trigger: 'server-detailed-settlement', battleTimer: battleTimer.snapshot() })
          publish(true)
        }
        continue
      }
      const stat = statisticFromBytes(bytes)
      stat.actors = stat.actors.map(a => ({ ...a, ...(identities.get(a.idHash) || {}) }))
      battleTimer.statistic(stat, job.observedAt)
      if (clock && stat.npcNo) { clock.npcNo ??= stat.npcNo; if (clock.npcNo === stat.npcNo) stat.encounterClock = { ...clock } }
      latest = { schemaVersion: 1, ...stamp, ...stat, sequence: ++counters.statistics,
        battleTimer: battleTimer.snapshot(), lastPacketObservedAt,
        health: { status: 'healthy', gap: false, stale: false, session: mode === 'live' ? 'valid' : 'recorded' } }
      lastStatisticWall = Date.now(); append('statistics.jsonl', latest); publish()
    } catch (error) { counters.rejectedEvents++; append('rejected-statistics.jsonl', { ...stamp, reason: error.message }) }
  }
}
const py = spawn(c.python, [path.join(__dirname, 'p1-live-proto.py'), ...(c.clientBuildSha256 ? ['--client-build', c.clientBuildSha256] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
let readyResolve
const ready = new Promise(resolve => { readyResolve = resolve })
readline.createInterface({ input: py.stdout }).on('line', line => {
  if (stopped) return
  try {
    const m = JSON.parse(line)
    if (m.ready) { readyResolve(); return }
    const job = pending.get(m.id)
    if (!job || !m.ok) throw Error(m.error || 'Invalid decoder response')
    pending.delete(m.id); counters.blocks++; receive(m, job)
  } catch (e) { fail(e.message) }
})
py.stderr.on('data', b => ledger.append(path.join(out, 'decoder.stderr.txt'), b.toString()))
py.on('error', e => fail(e.message)); py.on('exit', () => { if (!stopped) fail('Decoder exited') })
py.stdin.on('error', () => { if (!stopped) fail('Decoder pipe closed') })
const blocks = new BlockStream((body, metadata) => {
  if (pending.size >= 65536) throw Error('Decoder queue exceeded capacity')
  const id = ++nextJob; pending.set(id, metadata)
  py.stdin.write(JSON.stringify({ id, body: body.toString('base64'), sessionId, recordOrdinal: metadata.recordOrdinal, observedAt: metadata.observedAt }) + '\n')
})
const ordered = new OrderedCipher(state, c.serverEncryptedOrigin, { onBytes: (b, m) => blocks.push(b, m), gapMs: c.gapTimeoutMs ?? 3000 })
const kcp = c.transport === 'kcp' ? new (require('./kcp-stream.cjs').KcpStream)({ ...c.kcp, gapMs: c.gapTimeoutMs ?? 3000,
  onBytes: (data, metadata) => { if (!data.length) return; ordered.push({ data, ...metadata }); ordered.start(); ordered.drain() } }) : null
function packet(line) {
  if (!line.trim()) return
  if (kcp) {
    const p = require('./kcp-stream.cjs').parseRow(line, c.kcp.remoteEndpoint), f = c.flow
    if (p.src !== f.serverAddress || p.sport !== f.serverPort || p.dst !== f.clientAddress || p.dport !== f.clientPort) return
    if (p.envelope !== c.kcp.envelope) throw Error('KCP envelope changed')
    counters.packets++
    for (const row of p.segments) kcp.push(row, { frame: p.frame, observedAt: new Date(p.time * 1000).toISOString() })
    return
  }
  const a = line.split('\t'); let p
  if (a.length === 8 && mode === 'replay') {
    p = { frame: +a[0], time: a[1], src: a[3], sport: +a[4], seq: +a[5], len: +a[6], hex: a[7] }
    if (String(c.replayInterfaceId) !== a[2]) throw Error('Unexpected replay interface')
  } else if (a.length === 13) {
    p = { frame: +a[0], time: a[1], src: a[3], sport: +a[4], dst: a[5], dport: +a[6], seq: +a[7], len: +a[8], syn: a[9], fin: a[10], rst: a[11], hex: a[12] }
    if (connectionBoundary(p)) throw Error('Connection changed; bind again')
    if (p.src !== c.flow.serverAddress || p.sport !== c.flow.serverPort) return
    if (p.dst !== c.flow.clientAddress || p.dport !== c.flow.clientPort) throw Error('Unexpected connection')
  } else throw Error('Invalid capture row')
  if (p.src !== c.flow.serverAddress || p.sport !== c.flow.serverPort) return
  const bytes = Buffer.from(p.hex, 'hex')
  if (bytes.length !== p.len) throw Error('Truncated packet')
  if (!bytes.length) return
  counters.packets++; ordered.push({ seq: p.seq, data: bytes, frame: p.frame, observedAt: new Date(Number(p.time) * 1000).toISOString() })
  if (ordered.next !== null) ordered.drain()
}
function pump() {
  if (stopped || pending.size > 512) return
  try {
    const began = Date.now()
    while (pending.size <= 512 && Date.now() - began < 4) {
      const nl = rawPending.indexOf('\n')
      if (nl >= 0) { const line = rawPending.slice(0, nl); rawPending = rawPending.slice(nl + 1); packet(line); continue }
      if (rawOffset >= rawSize) break
      const bytes = Buffer.alloc(Math.min(65536, rawSize - rawOffset)), n = fs.readSync(rawReadFd, bytes, 0, bytes.length, rawOffset)
      rawOffset += n; rawPending += bytes.subarray(0, n).toString('utf8')
      if (rawPending.length > 16 * 1024 * 1024) throw Error('Oversized capture row')
    }
  } catch (e) { fail(e.message) }
}
function fail(reason) { if (!stopped) { failing = true; latest.health = { status: 'invalid', stale: true, session: 'invalid', gap: /gap/i.test(reason), reason }; finish('invalid') } }
function finish(status = 'stopped') {
  if (stopped) return
  stopped = true
  for (const timer of [tick, pumpTimer, startTimer, publishTimer]) clearTimeout(timer)
  capture?.kill(); watcher?.kill(); py.kill()
  if (!failing) latest.health = { ...latest.health, status, stale: mode === 'live', session: mode === 'live' ? 'stopped' : 'recorded' }
  publish(true); ledger.close()
  if (rawFd !== null) fs.closeSync(rawFd)
  if (rawReadFd !== null) fs.closeSync(rawReadFd)
  write('completion.json', { at: new Date().toISOString(), status, failed: failing, ...counters, pendingMessages: pending.size,
    unparsedCaptureBytes: rawSize - rawOffset + Buffer.byteLength(rawPending), incompleteTailBytes: blocks.buf.length })
  publisher.close().then(() => { process.exitCode = failing ? 1 : 0 })
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
process.on('SIGINT', () => finish()); process.on('SIGTERM', () => finish())
;(async () => {
  await Promise.race([ready, new Promise((_, reject) => { const t = setTimeout(() => reject(Error('Decoder startup timeout')), 10000); t.unref() })])
  if (stopped) return
  publish(true)
  if (mode === 'replay') {
    fs.copyFileSync(opts.replay, path.join(out, 'transport.private.tsv'))
    const lines = readline.createInterface({ input: fs.createReadStream(opts.replay), crlfDelay: Infinity })
    for await (const line of lines) {
      packet(line); if (ordered.next === null && ordered.pending.length >= 8) ordered.start()
      while (pending.size > 512 && !stopped) await wait(10)
      if (stopped) return
    }
    ordered.start(); ordered.drain()
    if (ordered.pending.length || kcp?.pending.size) throw Error('Replay ends with a transport gap')
    while (pending.size && !stopped) await wait(10)
    finish('replay-complete'); return
  }
  watcher = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'p1-live-session-watch.ps1'), '-Config', configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  readline.createInterface({ input: watcher.stdout }).on('line', s => { try { binding = JSON.parse(s); lastBindWall = Date.now(); if (!binding.valid) fail(binding.reason) } catch { fail('Invalid process binding') } })
  watcher.on('error', e => fail(e.message)); watcher.on('exit', () => { if (!stopped) fail('Binding watcher stopped') })
  watcher.stderr.on('data', b => ledger.append(path.join(out, 'binding.stderr.txt'), b.toString()))
  for (let n = 0; n < 100 && !binding && !stopped; n++) await wait(100)
  if (stopped) return
  if (!binding?.valid) throw Error('Cannot verify selected process')
  const f = c.flow, filter = `tcp and host ${f.clientAddress} and host ${f.serverAddress} and port ${f.clientPort} and port ${f.serverPort}`
  const fields = ['frame.number', 'frame.time_epoch', 'frame.interface_id', 'ip.src', 'tcp.srcport', 'ip.dst', 'tcp.dstport', 'tcp.seq_raw', 'tcp.len', 'tcp.flags.syn', 'tcp.flags.fin', 'tcp.flags.reset', 'tcp.payload']
  rawFd = fs.openSync(path.join(out, 'transport.private.tsv'), 'a'); rawReadFd = fs.openSync(path.join(out, 'transport.private.tsv'), 'r')
  if (kcp) {
    process.stdin.on('end', () => { if (!stopped) fail('KCP capture handoff closed') })
    readline.createInterface({ input: process.stdin }).on('line', s => { if (!stopped) try { rawSize += fs.writeSync(rawFd, s + '\n') } catch (e) { fail(e.message) } })
  } else {
  capture = spawn(c.tshark, ['-l', '-n', '-i', c.captureInterface, '-f', filter, '-s', '0', '-T', 'fields', '-E', 'separator=/t', '-E', 'occurrence=f', ...fields.flatMap(x => ['-e', x])], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  capture.on('error', e => fail(e.message)); capture.on('exit', () => { if (!stopped) fail('Capture process stopped') })
  capture.stderr.on('data', b => ledger.append(path.join(out, 'capture.stderr.txt'), b.toString()))
  readline.createInterface({ input: capture.stdout }).on('line', s => { if (!stopped) try { rawSize += fs.writeSync(rawFd, s + '\n') } catch (e) { fail(e.message) } })
  }
  pumpTimer = setInterval(pump, 20)
  startTimer = setTimeout(() => { try { ordered.start() } catch (e) { fail(e.message) } }, 1000)
  const began = Date.now()
  tick = setInterval(() => {
    try {
      if (fs.existsSync(path.join(out, 'stop')) || Date.now() - began > 1000 * Number(opts.duration || 43200)) { finish(); return }
      if (Date.now() - lastBindWall > 8000) throw Error('Process binding verification stale')
      if (ordered.next === null) ordered.start()
      ordered.tick()
      kcp?.tick()
      latest.health = { status: lastStatisticWall ? 'healthy' : 'waiting', session: 'valid', stale: !lastStatisticWall || Date.now() - lastStatisticWall > 3500,
        gap: !!ordered.gapSince, reason: lastStatisticWall ? 'Waiting for next server counter' : 'Capture active; no server statistics yet' }
      publish()
    } catch (e) { fail(e.message) }
  }, 1000)
})().catch(e => fail(e.message))
