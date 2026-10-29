/* Selection and order are independent of chart filtering and fresh data. */
;(function (root) {
  const defaults = new Set(['1058032', '98752', '10245332'])
  const validId = id => typeof id === 'string' && /^(player-buff|boss-buff|action):[^:]{1,100}:[^:]{0,60}$/.test(id)
  const unique = rows => [...new Set(Array.isArray(rows) ? rows.filter(validId).slice(0, 5000) : [])]
  const id = (type, actor, buff = '') => `${type}:${actor}:${buff}`
  class Layout {
    constructor(saved = {}) {
      if (!saved || saved.version !== 1) saved = {}
      this.order = unique(saved.order)
      this.excluded = new Set(unique(saved.excluded))
      this.defaults = saved.defaults !== false
      this.detailPlayers = Array.isArray(saved.detailPlayers) ? [...new Set(saved.detailPlayers.filter(x => typeof x === 'string' && x.length <= 100))] : null
    }
    reconcile(candidates) {
      let changed = false
      if (this.defaults) for (const row of candidates) {
        if ((row.type === 'action' || row.type === 'player-buff' && defaults.has(row.buffId)) &&
            !this.excluded.has(row.id) && !this.order.includes(row.id)) {
          this.order.push(row.id); changed = true
        }
      }
      return changed
    }
    selected(candidates) {
      const available = new Map(candidates.map(row => [row.id, row]))
      return this.order.filter(key => available.has(key)).map(key => available.get(key))
    }
    set(key, checked) {
      if (!validId(key)) return
      if (checked) { this.excluded.delete(key); if (!this.order.includes(key)) this.order.push(key) }
      else { this.order = this.order.filter(x => x !== key); this.excluded.add(key) }
    }
    move(key, target, after = false) {
      if (key === target || !this.order.includes(key) || !this.order.includes(target)) return false
      const previous = this.order.join('|')
      const rows = this.order.filter(x => x !== key)
      rows.splice(rows.indexOf(target) + Number(after), 0, key); this.order = rows
      return previous !== rows.join('|')
    }
    clear() { this.order = []; this.excluded.clear(); this.defaults = false }
    reset(candidates) { this.order = []; this.excluded.clear(); this.defaults = true; this.reconcile(candidates) }
    snapshot() { return { version: 1, order: this.order, excluded: [...this.excluded], defaults: this.defaults, detailPlayers: this.detailPlayers } }
  }
  const api = { Layout, id }
  if (typeof module !== 'undefined') module.exports = api
  else root.TimelineLayout = api
})(typeof window === 'undefined' ? globalThis : window)
