'use strict'

const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0
const at = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
const total = stat => stat.actors.reduce((n, a) => n + a.damage + a.heal + a.absorbDmg, 0)

// Server time_cost is a completed duration, not a ticking clock. Retain it
// through subsequent zero-time idle updates. Never start at bind/window-open.
class BattleTimer {
  constructor(sessionId) {
    this.sessionId = sessionId; this.ordinal = 0; this.current = null
    this.previous = null; this.zeroAt = null; this.spaceHash = null
    this.stateKnown = false; this.pendingStart = null
  }
  start(observedAt, basis, npcNo = null, spaceHash = null) {
    this.current = { key: this.sessionId + ':' + ++this.ordinal, phase: 'active',
      startObservedAt: observedAt, endObservedAt: null, basis, npcNo, spaceHash,
      durationSeconds: null, correctionSeconds: null, finalActors: null }
    this.current.spaceHash ??= this.spaceHash
  }
  boundary(event, observedAt) {
    if (event.kind === 'dungeon-finish-state') {
      // The game raises E_DUNGEON_FINISH from this property before requesting
      // the settlement. A completed scene snapshot is not a new victory.
      if (at(observedAt) !== null && !event.initial && event.finished === true &&
          this.current?.phase === 'active' && this.current.spaceHash === event.spaceHash &&
          at(observedAt) >= at(this.current.startObservedAt)) {
        Object.assign(this.current, { phase: 'ended', endObservedAt: observedAt,
          endReason: 'server-dungeon-finish' })
        this.zeroAt = null
      }
      return
    }
    if (event.kind !== 'boss-battle-state' || at(observedAt) === null) return
    this.stateKnown = true
    if (event.initial && this.spaceHash !== event.spaceHash) this.pendingStart = null
    if (!event.active) this.pendingStart = null
    if (event.initial || event.active) this.spaceHash = event.spaceHash
    if (event.active && event.previousActive === false && event.stateChanged && !event.initial) {
      // Leaving/reopening a completed dungeon can briefly raise the old scene's
      // flag again. Keep the result until reset counters confirm another pull.
      if (this.current?.spaceHash === event.spaceHash && ['ended', 'finalized', 'interrupted'].includes(this.current.phase)) {
        this.pendingStart = { observedAt, spaceHash: event.spaceHash, sawZero: false }
        return
      }
      this.start(observedAt, 'server-battle-state', null, event.spaceHash)
      this.previous = null; this.zeroAt = null
    } else if (!event.active && this.current?.phase === 'active' &&
        (!this.current.spaceHash || this.current.spaceHash === event.spaceHash)) {
      this.current.phase = 'ended'; this.current.endObservedAt = observedAt
      this.current.endReason = 'server-battle-state'
      this.pendingStart = null
    } else if (event.initial && this.current?.phase === 'active' &&
        this.current.spaceHash && this.current.spaceHash !== event.spaceHash) {
      this.current.phase = 'interrupted'; this.current.endObservedAt = observedAt
      this.previous = null; this.zeroAt = null
    }
  }
  settlement(detail, observedAt) {
    const current = this.current, previous = this.previous
    // STAT_JIESUAN is sent before the next periodic counter. It has no attempt
    // ID, so only associate an immediate response with an observed ended pull
    // and exactly the same roster. Keep incomplete/late replies in the ledger.
    const delay = at(observedAt) - at(current?.endObservedAt)
    if (current?.phase !== 'ended' || !current.startObservedAt || !previous ||
        !positive(detail.timeCostSeconds) || !Number.isFinite(delay) || delay < 0 || delay > 5000 ||
        detail.timeCostSeconds > (at(observedAt) - at(current.startObservedAt)) / 1000 + 5) return false
    const old = new Map(previous.actors.map(a => [a.idHash, a]))
    if (detail.actors.length !== old.size || new Set(detail.actors.map(a => a.actorHash)).size !== old.size ||
        detail.actors.some(a => !old.has(a.actorHash))) return false
    const actors = detail.actors.map(a => ({ ...old.get(a.actorHash),
      damage: a.totals.damage, heal: a.totals.heal, absorbDmg: a.totals.absorb_dmg }))
    this.statistic({ npcNo: current.npcNo, timeCostSeconds: detail.timeCostSeconds, actors }, observedAt)
    return this.current?.phase === 'finalized'
  }
  statistic(stat, observedAt) {
    if (at(observedAt) === null || !stat.actors.length) return
    let current = this.current
    if (current?.npcNo != null && current.npcNo !== stat.npcNo) {
      this.current = current = null; this.previous = null; this.zeroAt = null; this.pendingStart = null
    }
    const previous = this.previous, sum = total(stat)
    const damage = stat.actors.reduce((n, a) => n + a.damage, 0)
    if (this.pendingStart && !positive(stat.timeCostSeconds)) {
      if (sum === 0) this.pendingStart.sawZero = true
      else if (damage > 0 && this.pendingStart.sawZero) {
        const pending = this.pendingStart; this.pendingStart = null
        this.start(pending.observedAt, 'server-battle-state', stat.npcNo, pending.spaceHash)
        current = this.current; this.zeroAt = null
      }
    }
    // Partial corrections (including tiny floating-point changes after a
    // settlement) are not resets. Use counters only without scene-state support.
    const reset = previous?.npcNo === stat.npcNo && total(previous) > 0 && sum === 0
    const justStarted = current?.phase === 'active' && current.basis === 'server-battle-state' &&
      at(observedAt) - at(current.startObservedAt) < 5000
    if (!this.stateKnown && !positive(stat.timeCostSeconds) && reset && !justStarted) {
      this.start(observedAt, 'counter-reset', stat.npcNo)
      current = this.current; this.zeroAt = sum === 0 ? observedAt : null
      // Some encounters reset counters well before combat actually starts.
      // Arm at zero, then use the last zero before the first positive update.
      if (sum === 0) Object.assign(current, { phase: 'armed', startObservedAt: null, resetObservedAt: observedAt })
    } else if (!this.stateKnown && !positive(stat.timeCostSeconds) && damage > 0 && this.zeroAt &&
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
