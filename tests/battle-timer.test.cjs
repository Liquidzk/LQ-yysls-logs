const test = require('node:test'), assert = require('node:assert/strict')
const { BattleTimer } = require('../collector/tools/battle-timer.cjs')
const model = require('../vendor/kagerou/yanyun/model.js')
const time = s => new Date(Date.parse('2026-01-01T00:00:00Z') + s * 1000).toISOString()
const stat = (damage, duration = 0, npcNo = 148) => ({ npcNo, timeCostSeconds: duration,
  actors: [{ idHash: 'player', damage, heal: 0, absorbDmg: 0 }] })
const boundary = (active, initial = false) => ({ kind: 'boss-battle-state', active, initial,
  previousActive: initial ? null : !active, stateChanged: !initial, spaceHash: 'space' })
const live = (timer, snapshot, pulse, now, running = true) => model.live({ latest: {
  ...snapshot, battleTimer: timer.snapshot(), lastPacketObservedAt: time(pulse), observedAt: time(pulse),
  source: { sessionId: 'test', mode: 'live' }, health: { session: 'valid', stale: false }
} }, running, Date.parse(time(now)))

test('observed start ticks before first damage; stop awaits server calibration', () => {
  const timer = new BattleTimer('s'); timer.boundary(boundary(true), time(10))
  assert.equal(live(timer, stat(0), 11, 11.5).duration, 1.5)
  timer.statistic(stat(50), time(11)); timer.statistic(stat(0), time(12))
  assert.equal(timer.snapshot().basis, 'server-battle-state')
  assert.equal(timer.snapshot().startObservedAt, time(10))
  timer.statistic(stat(100), time(14)); timer.boundary(boundary(false), time(15))
  assert.equal(live(timer, stat(100), 20, 20).duration, 5)
  assert.equal(live(timer, stat(100), 20, 20).timer.label, '已结束 · 待结算')
  timer.statistic(stat(100, 4.75), time(16))
  assert.equal(timer.snapshot().correctionSeconds, -0.25)
  assert.equal(live(timer, stat(100), 20, 20).rows[0].dps, 100 / 4.75)
})

test('real observed zero-reset/settlement/idle pattern retains exact server seconds', () => {
  const timer = new BattleTimer('s')
  timer.statistic(stat(3462715.9362516636), time(0))
  assert.equal(live(timer, stat(3462715), 1, 1).duration, null)
  timer.statistic(stat(0), time(23.104))
  timer.statistic(stat(100), time(24.104))
  const final = stat(5951687.143407464, 64.77569580078125)
  timer.statistic(final, time(88.448))
  timer.boundary(boundary(false, true), time(89.441))
  timer.statistic(stat(final.actors[0].damage), time(96.701))
  const result = live(timer, stat(0), 96.701, 100)
  assert.equal(result.duration, 64.77569580078125)
  assert.equal(result.rows[0].damage, final.actors[0].damage)
  assert.equal(result.rows[0].dps, final.actors[0].damage / final.timeCostSeconds)
  assert.equal(result.timer.label, '服务器结算')
  assert.equal(model.formatTime(result.duration), '01:04.7')
})

test('same boss next pull resets timer and cannot inherit previous settlement', () => {
  const timer = new BattleTimer('s')
  timer.statistic(stat(600, 60), time(61)); const oldKey = timer.snapshot().key
  timer.statistic(stat(0), time(70)); timer.statistic(stat(50), time(71))
  assert.notEqual(timer.snapshot().key, oldKey)
  assert.equal(live(timer, stat(50), 71, 72).duration, 2)
  assert.equal(live(timer, stat(50), 71, 72).timer.estimated, true)
  timer.statistic(stat(600, 60), time(72))
  assert.equal(timer.snapshot().phase, 'active')
  assert.equal(timer.snapshot().durationSeconds, null)
})

test('binding during combat stays unknown; a zero observation can anchor first activity', () => {
  const timer = new BattleTimer('s'); timer.boundary(boundary(true, true), time(0))
  timer.statistic(stat(100), time(1)); timer.statistic(stat(200), time(10))
  assert.equal(live(timer, stat(200), 10, 11).duration, null)
  const fresh = new BattleTimer('f'); fresh.statistic(stat(0), time(0)); fresh.statistic(stat(0), time(100))
  fresh.statistic(stat(5), time(101))
  assert.equal(live(fresh, stat(5), 101, 102).duration, 2)
  assert.equal(fresh.snapshot().basis, 'counter-first-activity')
  const reset = new BattleTimer('reset'); reset.statistic(stat(100), time(0))
  reset.statistic(stat(0), time(1)); reset.statistic(stat(0), time(25))
  assert.equal(live(reset, stat(0), 25, 26).duration, null)
  reset.statistic(stat(10), time(26))
  assert.equal(live(reset, stat(10), 26, 27).duration, 2)
  reset.boundary(boundary(false), time(30)); reset.statistic(stat(10), time(31))
  assert.equal(reset.snapshot().phase, 'ended')
})

test('teammate departure and target change do not create a precise start', () => {
  const timer = new BattleTimer('s'), first = stat(100)
  first.actors.push({ idHash: 'leaving', damage: 500, heal: 0, absorbDmg: 0 })
  timer.statistic(first, time(0)); timer.statistic(stat(110), time(1))
  assert.equal(timer.snapshot().phase, 'unknown')
  timer.statistic(stat(120, 5), time(2)); timer.statistic(stat(12, 0, 99), time(3))
  assert.equal(timer.snapshot().phase, 'unknown')
  assert.equal(timer.snapshot().durationSeconds, null)
})

test('packet liveness keeps invulnerability phases ticking; stop and loss freeze', () => {
  const timer = new BattleTimer('s'); timer.boundary(boundary(true), time(0))
  const data = { latest: { ...stat(100), battleTimer: timer.snapshot(), observedAt: time(1),
    lastPacketObservedAt: time(20), source: { mode: 'live' }, health: { session: 'valid', stale: true } } }
  assert.equal(model.live(data, true, Date.parse(time(21))).duration, 21)
  assert.equal(model.live(data, true, Date.parse(time(21))).timer.state, 'active')
  assert.equal(model.live(data, false, Date.parse(time(30))).duration, 20)
  assert.equal(model.live(data, true, Date.parse(time(30))).duration, 23.5)
  assert.equal(model.live(data, true, Date.parse(time(40))).duration, 23.5)
  data.latest.health.gap = true
  assert.equal(model.live(data, true, Date.parse(time(30))).timer.state, 'paused')
  data.latest.source.mode = 'replay'
  assert.equal(model.live(data, true, Date.parse(time(30))).duration, 20)
})

test('timer formatting preserves unknown, zero and completed tenths', () => {
  assert.equal(model.formatTime(null), '—'); assert.equal(model.formatTime(0), '00:00.0')
  assert.equal(model.formatTime(59.99), '00:59.9'); assert.equal(model.formatTime(3600), '60:00.0')
})
