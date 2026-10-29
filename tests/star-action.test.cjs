const { test } = require('node:test'), assert = require('node:assert/strict')
const { createStarAction } = require('../desktop/star-action.cjs')
test('shortcut requires a visible live overlay and reports saved record without changing focus', async () => {
  let visible = false, source = 'live', saves = 0
  const feedback = [], changes = []
  const action = createStarAction({ isVisible: () => visible, source: () => source,
    save: async () => { saves++; return { ok: true, key: 'finished', starred: true } },
    changed: r => changes.push(r), feedback: r => feedback.push(r) })
  await action(); assert.equal(saves, 0)
  visible = true; source = 'review'; await action(); assert.equal(saves, 0); assert.equal(feedback.at(-1).ok, false)
  source = 'live'; await action(); assert.equal(saves, 1); assert.equal(changes[0].key, 'finished'); assert.equal(feedback.at(-1).starred, true)
})
test('held shortcut cannot submit concurrently, and failed writes never claim success', async () => {
  let finish, saves = 0; const results = []
  const action = createStarAction({ isVisible: () => true, source: () => 'live',
    save: () => { saves++; return new Promise((resolve,reject) => { finish = reject }) },
    changed: () => assert.fail('must not notify success'), feedback: r => results.push(r) })
  const first = action(); await action(); assert.equal(saves, 1)
  finish(Error('still saving')); await first; assert.equal(results[0].error, 'still saving')
})
