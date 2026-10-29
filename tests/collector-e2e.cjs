// End-to-end synthetic capture -> decryption -> actual schema worker -> archives.
// Does not open a game process or a network interface.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto')
const { spawnSync } = require('node:child_process'), { encode } = require('@msgpack/msgpack')
const { init, crypt } = require('../collector/tools/rc4-state-offline.cjs')
const { syncId } = require('../collector/tools/action-events.cjs')
const root = path.resolve(__dirname, '..'), local = path.join(root, '.local/collector-e2e', Date.now() + '-' + crypto.randomUUID())
fs.mkdirSync(local, { recursive: true })
const python = path.join(root, 'runtime/collector/runtime/python/python.exe')
const b64 = b => Buffer.from(b).toString('base64')
const currentBuild = process.argv.includes('--current-build')
const cachedOnly = process.argv.includes('--cached-only')
const kcpMode = process.argv.includes('--kcp')
const build = require('../collector/config/client-build.json').builds.find(p => p.id === 'cn-win64r-20261023')
const currentNames = require('../collector/config/presets/cn-win64r-20261023.json').names
const bytes = s => ({ svalue: b64(s) }), index = n => ({ sindex: currentBuild ? currentNames.indexOf(mapping.rows.find(r => r.index === n)?.name) : n }), integer = n => ({ ivalue: n })
const prop = (name, value) => ({ name: index(name), value })
const clock = active => ({ name: index(2817), dict: { item: [prop(4662, { bvalue: active })] } })
const mapping = JSON.parse(fs.readFileSync(path.join(root, 'runtime/collector/evidence/p1/encounter-retest/index-names.json')))
const field = name => { const row = mapping.rows.find(r => r.name === name); if (!row) throw Error('Missing property ' + name); return row.index }
const finish = done => ({ name: index(2817), dict: { item: [prop(field('dungeon_finish'), { bvalue: done })] } })
const buff = { name: index(field('buffs_data')), dict: { item: [{ name: index(field('ac_buffs')), dict: { item: [{ name: bytes('synthetic-buff'), oper: 49, dict: { item: [
  prop(field('No'), integer(123)), prop(field('fromid'), bytes('actor-b')), prop(field('duration'), integer(100)), prop(field('start_ts'), integer(1000)), prop(field('charge_level'), integer(2))
] } }] } }] } }
const area = (method, data) => ({ methodIndex: 11, message: { id: b64('target'), method: { index: method }, smsgpack: b64(encode(data)) } })
const counters = (amount, seconds = 0) => area(0x2e77db68, [{ npc_no: 7, stat_type: 1, time_cost: seconds,
  statistic: { 'actor-a': { damage: amount, heal: 0, absorb_dmg: 20 }, 'actor-b': { damage: 0, heal: 50, absorb_dmg: 0 } } }])
const inner = [100, 100, Buffer.from('actor-a'), 456, 789, null, null, null, 1, null, null, 0, null, 0, 1, null, null]
const messages = [
  { methodIndex: 12, message: { name: b64('Avatar'), id: b64('actor-b'), guid: '3', props: { props: [{ name: index(1070), dict: { item: [prop(5982, bytes('队友示例'))] } }] } } },
  { methodIndex: 12, message: { name: b64('SpaceData'), id: b64('space'), guid: '2', props: { props: [clock(false), finish(false)] } } },
  { methodIndex: 10, message: { guid: '2', props: [clock(true)] } },
  { methodIndex: 12, message: { name: b64('Avatar'), id: b64('actor-a'), guid: '1', props: { props: [{ name: index(1070), dict: { item: [prop(5982, bytes('离线验证角色'))] } }, buff] } } },
  counters(0),
  area(1164740750, [1792714907, Buffer.from(encode(inner))]),
  counters(100),
  { methodIndex: 10, message: { guid: '2', props: [finish(true)] } },
  counters(100),
  { methodIndex: 10, message: { guid: '2', props: [clock(false)] } },
  area(0x2e77db68, [{ stat_type: 2, time_cost: 5, combat_stat: { 'actor-a': { combat_stat: { damage: 100, heal: 0, absorb_dmg: 20 },
    combat_stat_detail: { target: { damage: { '456': 100 }, heal: {}, absorb_dmg: {} } } },
    'actor-b': { combat_stat: { damage: 0, heal: 50, absorb_dmg: 0 }, combat_stat_detail: {} } } }]),
  counters(100, 5),
  counters(100, 0)
]
// The skill start carrier is a property queue, not a damage notification.
const actionQueue = (operation) => ({ name:index(field('sync_event_data')), dict:{item:[{name:bytes('skill'),oper:operation,dict:{item:[
  prop(field('event'),integer(syncId('Skill'))),prop(field('args'),bytes(encode([456n,[0,0,0],0,null,Buffer.from('cast-id'),Buffer.from('target'),null,null,false,0],{useBigInt64:true})))
]}}]} })
messages[3].message.props.props.push(actionQueue(49))
messages.push({ methodIndex:10, message:{guid:'1',props:[actionQueue(11)]} })
messages.push({methodIndex:10,message:{guid:'1',props:[{path:[index(field('sync_event_data'))],name:bytes('skill'),oper:4}]}})
if (currentBuild) {
  const salt = 0x76543210fedcba98n
  const hp = n => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return integer(BigInt.asIntN(64,b.readBigUInt64LE() ^ salt).toString()) }
  // A Boss from the preceding world must leave on the engine space snapshot,
  // even when no AoiGuid.leave is sent during the transfer.
  messages.push({methodIndex:12,message:{name:b64('Npc'),id:b64('previous-world-boss'),guid:'9',props:{props:[
    prop(field('No'),integer(92000001)),{name:index(field('attr')),dict:{item:[
      prop(field('salt'),integer(salt.toString())),prop(field('HP'),hp(300)),prop(field('HP_MAX'),hp(400))
    ]}}
  ]}}})
  messages.push({methodIndex:14,message:{dict:{}}})
  for (const [id, guid, no, current, maximum] of [['body','10',22800004,500,1000], ['soul','11',22800007,800,2000]]) {
    messages.push({ methodIndex:12, message:{ name:b64('Npc'), id:b64(id), guid, props:{props:[
      prop(field('No'),integer(no)), {name:index(field('attr')),dict:{item:[
        prop(field('salt'),integer(salt.toString())),prop(field('HP'),hp(current)),prop(field('HP_MAX'),hp(maximum))
      ]}}
    ]}}})
  }
  // Observed party entry order: Boss creation precedes the SpaceData entity.
  // This entity snapshot must not delete either body or its independent max.
  messages.push({methodIndex:12,message:{name:b64('SpaceData'),id:b64('new-space'),guid:'12'}})
  messages.push({methodIndex:14,message:{key:{value:bytes('preload_entities')},value:{value:integer(1)}}})
  messages.push({methodIndex:10,message:{guid:'10',props:[{path:[index(field('attr'))],name:index(field('HP')),value:hp(0)}]}})
}
if (cachedOnly) for (const packet of messages) {
  if (packet.message.name === b64('Avatar')) packet.message.props.props = packet.message.props.props.filter(p => p.name.sindex !== index(1070).sindex)
}
const encoded = spawnSync(python, [path.join(__dirname, 'encode-proto-fixture.py')], { cwd: root, input: JSON.stringify(messages), encoding: 'utf8', windowsHide: true })
assert.equal(encoded.status, 0, encoded.stderr)
const bodies = JSON.parse(encoded.stdout).map(x => Buffer.from(x, 'base64'))
const state = init(Buffer.from('synthetic-e2e-key-only'))
const stateFile = path.join(local, 'state.json'); fs.writeFileSync(stateFile, JSON.stringify(state))
const cipherState = { ...state, S: [...state.S] }; let seq = 10000
const lines = bodies.map((body, i) => {
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length)
  const encrypted = crypt(cipherState, Buffer.concat([header, body])), start = seq; seq += encrypted.length
  if (kcpMode) {
    const k = Buffer.alloc(24); k.writeUInt32LE(123); k[4] = 81; k.writeUInt32LE(900 + i, 12); k.writeUInt32LE(encrypted.length, 20)
    return [i + 1, 1767225600 + i, 0, '192.0.2.1', 2345, '192.0.2.2', 4567, Buffer.concat([k, encrypted]).toString('hex')].join('\t')
  }
  return [i + 1, 1767225600 + i, 0, '192.0.2.1', 2345, '192.0.2.2', 4567, start, encrypted.length, 'False', 'False', 'False', encrypted.toString('hex')].join('\t')
})
const packets = path.join(local, 'synthetic.tsv'); fs.writeFileSync(packets, lines.join('\n') + '\n')
const config = path.join(local, 'config.json')
const identityCacheFile = path.join(local, 'identity-cache.json')
if (cachedOnly) fs.writeFileSync(identityCacheFile, JSON.stringify({ names: [
  ['actor-a', '离线验证角色'], ['actor-b', '队友示例']
].map(([id, name]) => ({ idHash: crypto.createHash('sha256').update(id).digest('hex').slice(0, 16), name, nameSource: 'wire.avatar.base.nickname' })) }))
fs.writeFileSync(config, JSON.stringify({ pid: 1, processStartUtc: '2026-01-01T00:00:00Z', serverEncryptedOrigin: 10000,
  ...(kcpMode ? { transport: 'kcp', serverEncryptedOrigin: 0, kcp: { conversation: 123, firstSequence: 900, envelope: 'direct', remoteEndpoint: { address: '192.0.2.1', port: 2345 } } } : {}),
  ...(currentBuild ? { clientBuildSha256: build.imageSha256 } : {}),
  ...(cachedOnly ? { identityCacheFile } : {}),
  initialStateFile: stateFile, initialStateSha256: crypto.createHash('sha256').update(fs.readFileSync(stateFile)).digest('hex'), python,
  flow: { serverAddress: '192.0.2.1', serverPort: 2345, clientAddress: '192.0.2.2', clientPort: 4567 } }))
const output = path.join(local, 'capture')
const result = spawnSync(process.execPath, [path.join(root, 'runtime/collector/tools/p1-live-pipeline.cjs'), '--config', config, '--out', output, '--replay', packets], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
assert.equal(result.status, 0, result.stderr)
const rows = name => {
  const data = fs.readFileSync(path.join(output, name + '.ylz')), blocks = []
  for (let offset = 0; offset < data.length;) {
    assert.equal(data.toString('ascii', offset, offset + 4), 'YLZ1')
    const size = data.readUInt32LE(offset + 4)
    const raw = require('node:zlib').inflateSync(data.subarray(offset + 12, offset + 12 + size))
    assert.equal(raw.length, data.readUInt32LE(offset + 8)); blocks.push(raw); offset += 12 + size
  }
  return Buffer.concat(blocks).toString('utf8').trim().split('\n').map(JSON.parse)
}
const stats = rows('statistics.jsonl'), hits = rows('damage-events.jsonl'), buffs = rows('buff-events.jsonl'), settlement = rows('settlement-details.jsonl')
const actions = rows('action-events.jsonl')
assert.deepEqual(actions.filter(a=>a.actionKind!=='visibility').map(a=>a.actionKind),['snapshot','boundary','cast','end'])
const cast=actions.find(a=>a.actionKind==='cast'), actionEnd=actions.find(a=>a.actionKind==='end')
assert.equal(cast.sourceActorName,'离线验证角色');assert.equal(cast.rawSkillId,456)
assert.equal(actionEnd.identifierHash,cast.identifierHash);assert.equal(actionEnd.endReason,'queue-removed')
assert.equal(stats.length, 5); assert.equal(stats.at(-1).actors[0].damage, 100); assert.equal(stats.at(-1).actors[0].name, '离线验证角色')
assert.equal(stats[2].battleTimer.phase, 'ended'); assert.equal(stats[2].battleTimer.endReason, 'server-dungeon-finish')
assert.equal(stats[2].battleTimer.endObservedAt, '2026-01-01T00:00:07.000Z')
const calibrated = rows('timer-events.jsonl').find(e => e.trigger === 'server-detailed-settlement')
assert.equal(calibrated.battleTimer.durationSeconds, 5)
assert.equal(calibrated.battleTimer.endObservedAt, '2026-01-01T00:00:07.000Z')
assert.equal(stats.at(-1).timeCostSeconds, 0)
assert.equal(stats.at(-1).battleTimer.phase, 'finalized'); assert.equal(stats.at(-1).battleTimer.durationSeconds, 5)
assert.equal(hits.length, 1); assert.equal(hits[0].amount, 100); assert.equal(hits[0].rawSkillId, 456)
assert.equal(hits[0].sourceActorName, '离线验证角色')
if (cachedOnly) {
  assert.equal(fs.existsSync(path.join(output, 'identity-events.jsonl.ylz')), false)
  const names = JSON.parse(fs.readFileSync(path.join(output, 'identities.json'))).names
  assert.equal(names.length, 2); assert.equal(names.every(n => n.cached === true), true)
}
assert.equal(buffs.length, 1); assert.equal(buffs[0].buffNo, 123); assert.equal(buffs[0].charge_level, 2)
assert.equal(buffs[0].sourceActorName, '队友示例'); assert.equal(buffs[0].targetActorName, '离线验证角色')
assert.equal(buffs[0].propertyPreset, currentBuild ? build.id : 'cn-win64rh-20261013')
assert.equal(settlement[0].actors[0].targets[0].categories.damage.skills[0].amount, 100)
assert.equal(fs.readdirSync(path.join(output, 'battles')).length, 1)
assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'completion.json'))).status, 'replay-complete')
assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'latest.json'))).source.mode, 'replay')
if (currentBuild) {
  const hp=JSON.parse(fs.readFileSync(path.join(output,'latest.json'))).bossHealth.rows
  assert.equal(hp.length,2); assert.equal(hp[0].role,'body'); assert.equal(hp[0].currentHp,0)
  assert.equal(hp[0].maxHp,1000); assert.equal(hp[1].currentHp,800); assert.equal(hp[1].maxHp,2000)
  const healthEvents=rows('encounter-events.jsonl').filter(e=>e.kind==='npc-health')
  assert.equal(healthEvents.filter(e=>e.available).length,4)
  assert.equal(healthEvents.filter(e=>e.reason==='space-data-reset').length,1)
}
fs.writeFileSync(path.join(root, '.local/last-e2e.json'), JSON.stringify({ path: output, verified: true, synthetic: true }))
console.log(JSON.stringify({ passed: true, synthetic: true, output, statistics: stats.length, hits: hits.length, buffs: buffs.length, settlements: settlement.length }))
