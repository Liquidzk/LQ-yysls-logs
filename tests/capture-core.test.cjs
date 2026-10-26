const test = require('node:test'), assert = require('node:assert/strict')
const { encode } = require('@msgpack/msgpack')
const { OrderedCipher, BlockStream, statisticFromBytes } = require('../collector/tools/p1-live-core.cjs')
const { init, crypt } = require('../collector/tools/rc4-state-offline.cjs')
const { CaptureManager } = require('../desktop/capture-manager.cjs')
const key = init(Buffer.from('synthetic test only')), plain = Buffer.from('abcdefghijklmnopqrstuvwxyz')
const cipher = crypt({ i: key.i, j: key.j, S: [...key.S] }, plain)
const packet = (seq, data) => ({ seq, data, frame: 1, observedAt: '2026-01-01T00:00:01Z' })
test('manual binding is mandatory and stale selections never launch a collector', async () => {
  const manager = new CaptureManager('unused', 'unused'); manager.processes = async () => []
  await assert.rejects(manager.start(), /手动选择/)
  await assert.rejects(manager.start({ pid: 123, startedAt: 'yesterday' }), /所选进程/)
  assert.equal(manager.child, null)
})
test('concurrent start requests cannot launch two collectors', async () => {
  const manager = new CaptureManager('unused', 'unused'); let release
  manager.processes = () => new Promise(resolve => { release = resolve })
  const first = manager.start({ pid: 123, startedAt: 'yesterday' })
  const rejected = assert.rejects(first, /所选进程/)
  await assert.rejects(manager.start({ pid: 123, startedAt: 'yesterday' }), /稍候/)
  release([]); await rejected; assert.equal(manager.starting, null); assert.equal(manager.child, null)
})
test('reordering and retransmission do not duplicate decoded bytes', () => {
  const got = [], s = new OrderedCipher(key, 100, { onBytes: b => got.push(b) })
  s.push(packet(100, cipher.subarray(0, 5))); s.start()
  s.push(packet(110, cipher.subarray(10))); s.drain()
  s.push(packet(105, cipher.subarray(5, 10))); s.drain()
  s.push(packet(103, cipher.subarray(3, 12))); s.drain()
  assert.deepEqual(Buffer.concat(got), plain)
})
test('unresolved packet gaps stop decoding rather than inventing bytes', () => {
  const s = new OrderedCipher(key, 100, { onBytes() {}, gapMs: 50 })
  s.push(packet(100, cipher.subarray(0, 5))); s.start(); s.push(packet(110, cipher.subarray(10))); s.drain(10)
  assert.throws(() => s.tick(61), /gap/)
})
test('counter parser retains measured zero and does not invent duration', () => {
  const result = statisticFromBytes(encode([{ npc_no: 1, stat_type: 1, time_cost: 0, statistic: { a: { damage: 0, heal: 2, absorb_dmg: 0 } } }]))
  assert.equal(result.actors[0].damage, 0); assert.equal(result.timeCostSeconds, 0)
})
