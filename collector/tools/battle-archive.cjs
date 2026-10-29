'use strict'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
class BattleArchive {
  constructor(root, source) { this.root = root; this.source = source; this.previous = new Map(); this.lastSequence = new Map() }
  update(snapshot, names) {
    let clock = snapshot.encounterClock
    if (!clock?.startObservedAt || !snapshot.observedAt || Date.parse(snapshot.observedAt) < Date.parse(clock.startObservedAt)) return
    const timer = snapshot.battleTimer
    if (!clock.endObservedAt && timer?.startObservedAt === clock.startObservedAt &&
        timer.endObservedAt && ['ended', 'finalized', 'interrupted'].includes(timer.phase)) {
      clock = { ...clock, endObservedAt: timer.endObservedAt, endReason: timer.endReason || 'server-duration' }
    }
    if (!clock.endObservedAt && ['stopped', 'invalid'].includes(snapshot.health?.status)) {
      clock = { ...clock, endObservedAt: snapshot.lastPacketObservedAt || snapshot.observedAt, endReason: 'capture-stopped' }
    }
    const id = crypto.createHash('sha256').update(this.source.sessionId + ':' + clock.startObservedAt).digest('hex').slice(0, 20)
    const dir = path.join(this.root, 'battles', id); fs.mkdirSync(dir, { recursive: true })
    const record = { ...snapshot, encounterClock: clock, source: { ...snapshot.source, mode: 'replay' } }
    if (this.lastSequence.get(id) !== snapshot.sequence) {
      fs.appendFileSync(path.join(dir, 'statistics.jsonl'), JSON.stringify(record) + '\n'); this.lastSequence.set(id, snapshot.sequence)
    }
    const battle = { schemaVersion: 1, id, source: this.source, clock, statistics: record, identities: names,
      status: timer?.phase === 'interrupted' || clock.endReason === 'capture-stopped' ? 'interrupted' : clock.endObservedAt ? 'ended' : 'active',
      scope: 'Observed server messages; shared event ledgers in the session directory.' }
    const text = JSON.stringify(battle)
    if (this.previous.get(id) === text) return
    fs.writeFileSync(path.join(dir, 'battle.json.tmp'), text); fs.renameSync(path.join(dir, 'battle.json.tmp'), path.join(dir, 'battle.json'))
    this.previous.set(id, text)
  }
}
module.exports = { BattleArchive }
