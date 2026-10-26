const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const root = path.join(__dirname, '../vendor/kagerou')
function load() {
  const context = vm.createContext({ window: {}, COLUMN_SORTABLE: ['deal.total'], COLUMN_INDEX: { deal: { total: 'damage' } },
    resolveDotIndex: (object, key) => key.split('.').reduce((v, k) => v[k], object),
    pFloat: parseFloat, sanitize: s => s.replace(/[^a-z]/gi, ''),
    config: { get: () => [], set: () => {}, save: () => {} } })
  vm.runInContext(fs.readFileSync(path.join(root, 'overlay/lib/listen.js'), 'utf8'), context)
  return context
}
function payload(id = 'a', damage = null) {
  return { yanyunObserved: true, isActive: 'false', Encounter: {
    hits: 0, title: '同一副本', CurrentZoneName: '同一副本', damage, DURATION: 10, duration: '00:10', yanyunReportKey: id
  }, Combatant: { a: { name: '记录者', damage } } }
}
test('Kagerou accepts no-hit observed snapshots without inventing zero damage', () => {
  const c = load(); const h = new c.window.History(); h.push(payload())
  assert.equal(h.current.data[0].damage, null)
  assert.equal(h.current.header.hits, 0)
})
test('ACT no-hit behavior is preserved outside Yanyun mode', () => {
  const c = load(); const h = new c.window.History(); const p = payload(); delete p.yanyunObserved; h.push(p)
  assert.equal(h.current, false)
})
test('Different reports of the same boss do not silently overwrite history', () => {
  const c = load(); const h = new c.window.History(); h.push(payload('first')); h.push(payload('second', 25))
  assert.equal(Object.keys(h.list).length, 1)
  assert.equal(h.current.header.yanyunReportKey, 'second')
})
test('Unknown values sort after measured zero and measured damage', () => {
  const c = load(); const p = payload()
  p.Combatant = { a: { name: '未知', damage: null }, b: { name: '零', damage: 0 }, c: { name: '已知', damage: 123 } }
  const d = new c.window.Data(p)
  assert.deepEqual(Array.from(d.get('deal.total', false)[0], x => x.name), ['已知', '零', '未知'])
})
test('Names are rendered as text, while numeric formatting is retained', () => {
  const context = vm.createContext({ window: { config: { get: () => [] }, YANYUN_MODE: true },
    document: { createElement: () => ({ textContent: '', innerHTML: '', setAttribute() {} }) },
    COLUMN_INDEX: { i: { name: { v: 'name' } } }, sanitize: s => s.replaceAll('.', '-'),
    resolveDotIndex: (object, key) => key.split('.').reduce((v, k) => v[k], object) })
  vm.runInContext(fs.readFileSync(path.join(root, 'overlay/lib/render.js'), 'utf8'), context)
  const part = context.window.Row.prototype.part.call({ _value: (field, data) => data[field] }, 'i.name', { name: '<img src=x onerror=alert(1)>' })
  assert.equal(part.innerHTML, '')
  assert.equal(part.textContent, '<img src=x onerror=alert(1)>')
})
