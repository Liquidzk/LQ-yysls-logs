const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), zlib = require('node:zlib')
const { LedgerWriter, encodeFrame } = require('../collector/tools/p1-ledger-writer.cjs')
function decoded(file) {
  const data = fs.readFileSync(file), frames = []; let offset = 0
  while (offset < data.length) {
    assert.equal(data.toString('ascii', offset, offset + 4), 'YLZ1')
    const length = data.readUInt32LE(offset + 4), size = data.readUInt32LE(offset + 8)
    const frame = zlib.inflateSync(data.subarray(offset + 12, offset + 12 + length))
    assert.equal(frame.length, size); frames.push(frame); offset += 12 + length
  }
  return Buffer.concat(frames).toString('utf8')
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yl-ledger-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
test('append-only frames preserve duplicate observations, Unicode and all fields', t => {
  const dir = fixture(t), file = path.join(dir, 'buff-events.jsonl')
  const writer = new LedgerWriter({ blockBytes: 128 })
  const line = JSON.stringify({ buffNo: 10245331, sourceActorName: '角色甲', kind: 'update', stack: 2 }) + '\n'
  for (let i = 0; i < 30; i++) writer.append(file, line)
  writer.close(); writer.close()
  assert.equal(decoded(file + '.ylz'), line.repeat(30))
  assert.equal(fs.existsSync(file), false)
})
test('short live tail is flushed automatically and close flushes the final event', async t => {
  const dir = fixture(t), file = path.join(dir, 'actions.jsonl')
  const writer = new LedgerWriter({ interval: 20 })
  t.after(() => writer.close())
  writer.append(file, '{"n":1}\n')
  await new Promise(resolve => setTimeout(resolve, 60))
  const first = fs.readFileSync(file + '.ylz')
  assert.equal(decoded(file + '.ylz'), '{"n":1}\n')
  writer.append(file, '{"n":2}\n'); writer.close()
  assert.deepEqual(fs.readFileSync(file + '.ylz').subarray(0, first.length), first)
  assert.equal(decoded(file + '.ylz'), '{"n":1}\n{"n":2}\n')
})
test('refuses existing evidence and keeps diagnostic text readable', t => {
  const dir = fixture(t), file = path.join(dir, 'events.jsonl')
  const writer = new LedgerWriter(); t.after(() => writer.close())
  fs.writeFileSync(file, 'original')
  assert.throws(() => writer.append(file, '{}\n'), /already exists/)
  const log = path.join(dir, 'decoder.stderr.txt'); writer.append(log, 'diagnosis'); writer.close()
  assert.equal(fs.readFileSync(file, 'utf8'), 'original'); assert.equal(fs.readFileSync(log, 'utf8'), 'diagnosis')
  assert.throws(() => encodeFrame(Buffer.alloc(0)), /size/)
})
