'use strict'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
class BattleArchive {
  constructor(root, source) { this.root = root; this.source = source; this.previous = new Map(); this.lastSequence = new Map() }
  update(snapshot, names) {
    const clock = snapshot.encounterClock
    if (!clock?.startObservedAt || !snapshot.observedAt || Date.parse(snapshot.observedAt) < Date.parse(clock.startObservedAt)) return
    const id = crypto.createHash('sha256').update(this.source.sessionId + ':' + clock.startObservedAt).digest('hex').slice(0, 20)
    const dir = path.join(this.root, 'battles', id); fs.mkdirSync(dir, { recursive: true })
    const record = { ...snapshot, source: { ...snapshot.source, mode: 'replay' } }
    if (this.lastSequence.get(id) !== snapshot.sequence) {
      fs.appendFileSync(path.join(dir, 'statistics.jsonl'), JSON.stringify(record) + '\n'); this.lastSequence.set(id, snapshot.sequence)
    }
    const battle = { schemaVersion: 1, id, source: this.source, clock, statistics: snapshot, identities: names,
      status: clock.endObservedAt ? 'ended' : ['stopped', 'invalid'].includes(snapshot.health?.status) ? 'interrupted' : 'active',
      scope: 'Observed server messages; shared event ledgers in the session directory.' }
    const text = JSON.stringify(battle)
    if (this.previous.get(id) === text) return
    fs.writeFileSync(path.join(dir, 'battle.json.tmp'), text); fs.renameSync(path.join(dir, 'battle.json.tmp'), path.join(dir, 'battle.json'))
    this.previous.set(id, text)
  }
}
module.exports = { BattleArchive }
