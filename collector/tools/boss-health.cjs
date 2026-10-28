'use strict'
const catalog = require('../config/boss-entities.json')
class BossHealth {
  constructor(config = catalog) { this.config = config; this.entities = new Map(); this.revision = 0 }
  consume(event, observedAt) {
    if (event.kind !== 'npc-health') return false
    const id = String(event.npcTemplateNo), meta = this.config.entities[id]
    if (!event.actorHash) return false
    if (!meta) return this.entities.delete(event.actorHash)
    if (event.reason?.startsWith('observed_aoi_') || ['guid_rebound', 'space-snapshot', 'entity-class-changed'].includes(event.reason)) {
      this.entities.delete(event.actorHash)
    } else {
      this.entities.set(event.actorHash, { actorHash: event.actorHash, npcTemplateNo: event.npcTemplateNo,
        currentHp: event.currentHp, maxHp: event.maxHp, available: !!event.available,
        group: meta.group || null, role: meta.role || null, observedAt })
    }
    this.revision++; return true
  }
  snapshot() {
    const rows = [...this.entities.values()], groups = new Set(rows.map(r => r.group).filter(Boolean))
    for (const group of groups) for (const id of Object.keys(this.config.groups[group].members)) {
      if (!rows.some(r => r.group === group && String(r.npcTemplateNo) === id)) {
        rows.push({ actorHash: group + ':' + id, npcTemplateNo: Number(id), group,
          role: this.config.entities[id].role, available: false, currentHp: null, maxHp: null, observedAt: null })
      }
    }
    rows.sort((a,b) => String(a.group || a.npcTemplateNo).localeCompare(String(b.group || b.npcTemplateNo)) ||
      (a.role === 'body' ? -1 : b.role === 'body' ? 1 : a.actorHash.localeCompare(b.actorHash)))
    return { schemaVersion: 1, revision: this.revision, rows }
  }
}
module.exports = { BossHealth }
