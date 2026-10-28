'use strict'

const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0
const at = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
const total = stat => stat.actors.reduce((n, a) => n + a.damage + a.heal + a.absorbDmg, 0)

// Server time_cost is a completed duration, not a ticking clock. Retain it
// through subsequent zero-time idle updates. Never start at bind/window-open.
class BattleTimer {
  constructor(sessionId) {
    this.sessionId = sessionId; this.ordinal = 0; this.current = null
    this.previous = null; this.zeroAt = null
  }
  start(observedAt, basis, npcNo = null, spaceHash = null) {
    this.current = { key: this.sessionId + ':' + ++this.ordinal, phase: 'active',
      startObservedAt: observedAt, endObservedAt: null, basis, npcNo, spaceHash,
      durationSeconds: null, correctionSeconds: null, finalActors: null }
  }
  boundary(event, observedAt) {
    if (event.kind !== 'boss-battle-state' || at(observedAt) === null) return
    if (event.active && event.previousActive === false && event.stateChanged && !event.initial) {
      this.start(observedAt, 'server-battle-state', null, event.spaceHash)
      this.previous = null; this.zeroAt = null
    } else if (!event.active && this.current?.phase === 'active' &&
        (!this.current.spaceHash || this.current.spaceHash === event.spaceHash)) {
      this.current.phase = 'ended'; this.current.endObservedAt = observedAt
    } else if (event.initial && this.current?.phase === 'active' &&
        this.current.spaceHash && this.current.spaceHash !== event.spaceHash) {
      this.current.phase = 'interrupted'; this.current.endObservedAt = observedAt
      this.previous = null; this.zeroAt = null
    }
  }
  statistic(stat, observedAt) {
    if (at(observedAt) === null || !stat.actors.length) return
    let current = this.current
    if (current?.npcNo != null && current.npcNo !== stat.npcNo) {
      this.current = current = null; this.previous = null; this.zeroAt = null
    }
    const previous = this.previous, sum = total(stat)
    // Reset detection compares the same actors, so a teammate leaving cannot
    // masquerade as another pull. A full zero reset also handles roster changes.
    const old = new Map((previous?.actors || []).map(a => [a.idHash, a]))
    const decreased = previous?.npcNo === stat.npcNo && old.size === stat.actors.length &&
      stat.actors.every(a => old.has(a.idHash) && ['damage', 'heal', 'absorbDmg'].every(k => a[k] <= old.get(a.idHash)[k])) &&
      sum < total(previous)
    const reset = previous?.npcNo === stat.npcNo && total(previous) > 0 && (sum === 0 || decreased)
    const justStarted = current?.phase === 'active' && current.basis === 'server-battle-state' &&
      at(observedAt) - at(current.startObservedAt) < 5000
    if (!positive(stat.timeCostSeconds) && reset && !justStarted) {
      this.start(observedAt, 'counter-reset', stat.npcNo)
      current = this.current; this.zeroAt = sum === 0 ? observedAt : null
      // Some encounters reset counters well before combat actually starts.
      // Arm at zero, then use the last zero before the first positive update.
      if (sum === 0) Object.assign(current, { phase: 'armed', startObservedAt: null, resetObservedAt: observedAt })
    } else if (!positive(stat.timeCostSeconds) && sum > 0 && this.zeroAt &&
        (!current || ['armed', 'finalized', 'ended', 'interrupted', 'unknown'].includes(current.phase))) {
      if (current?.phase === 'armed') Object.assign(current, { phase: 'active', startObservedAt: this.zeroAt, basis: 'counter-first-activity' })
      else { this.start(this.zeroAt, 'counter-first-activity', stat.npcNo); current = this.current }
    }
    if (!current && sum > 0) {
      this.current = current = { key: this.sessionId + ':' + ++this.ordinal, phase: 'unknown',
        startObservedAt: null, endObservedAt: null, npcNo: stat.npcNo, basis: 'missing-start',
        durationSeconds: null, correctionSeconds: null, finalActors: null }
    }
    if (current) current.npcNo ??= stat.npcNo
    if (positive(stat.timeCostSeconds)) {
      const elapsed = current?.startObservedAt ? (at(observedAt) - at(current.startObservedAt)) / 1000 : null
      // A delayed settlement from the previous pull must not stop a newly
      // observed pull that is much shorter than that settlement.
      if (current?.phase === 'active' && elapsed !== null && stat.timeCostSeconds > elapsed + 5) return
      if (!current) {
        this.start(observedAt, 'server-duration', stat.npcNo)
        current = this.current; current.startObservedAt = null
      }
      const end = current.endObservedAt || observedAt
      const observedDuration = current.startObservedAt ? (at(end) - at(current.startObservedAt)) / 1000 : null
      Object.assign(current, { phase: 'finalized', endObservedAt: end,
        durationSeconds: stat.timeCostSeconds, settledAt: observedAt,
        correctionSeconds: observedDuration === null ? null : stat.timeCostSeconds - observedDuration,
        finalActors: stat.actors.map(a => ({ ...a })) })
      this.zeroAt = null
    } else this.zeroAt = sum === 0 ? observedAt : null
    this.previous = stat
  }
  snapshot() {
    return this.current ? { ...this.current } : { phase: 'waiting', durationSeconds: null }
  }
}

module.exports = { BattleTimer }
