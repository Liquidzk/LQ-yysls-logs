const test = require('node:test'), assert = require('node:assert/strict')
const model = require('../vendor/kagerou/yanyun/model.js')
test('new overlay preserves unknown versus measured zero', () => {
  assert.deepEqual(model.ranked([{ damage: null }, { damage: 0 }, { damage: 10 }], 'damage').map(r => r.damage), [10, 0, null])
  assert.equal(model.number(null), '—'); assert.equal(model.number(0), '0')
})
test('missing duration never manufactures live DPS', () => {
  const v = model.live({ latest: { actors: [{ idHash: 'abc', damage: 100 }], timeCostSeconds: 0 } }, true)
  assert.equal(v.rows[0].dps, null)
})
test('stopped capture freezes duration instead of advancing through offline time', () => {
  const latest = { source: { sessionId: 'a' }, observedAt: '2026-01-01T00:00:10Z', npcNo: 1,
    encounterClock: { npcNo: 1, startObservedAt: '2026-01-01T00:00:00Z' }, health: { session: 'valid', stale: false }, actors: [{ idHash: 'a', damage: 100 }] }
  const v = model.live({ latest }, false, Date.parse('2026-01-01T00:05:00Z'))
  assert.equal(v.duration, 10); assert.equal(v.rows[0].dps, 10); assert.equal(v.fresh, false)
})
test('separate reports retain separate history', () => {
  const h = new model.History(); h.push({ key: 'first' }); h.push({ key: 'second' }); assert.equal(h.entries.get('first').key, 'first')
})
test('replay cannot claim to be live even with recent healthy metadata', () => {
  const v = model.live({ latest: { source: { mode: 'replay' }, observedAt: new Date().toISOString(), health: { session: 'valid' } } }, true)
  assert.equal(v.fresh, false); assert.match(v.status, /离线回放/)
})
