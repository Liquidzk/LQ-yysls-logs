'use strict'
const crypto = require('node:crypto')
const { decode, encode } = require('@msgpack/msgpack')
const { normalizeSyncEnvelopes } = require('./p1-rdps-damage-batch.cjs')
// common.RpcIndex.calculate_rpc_index(name, "sync"), checked against the
// existing BehitWithoutAnim decoder. Layout: sync/common/sync_skill.lua.
const syncId = name => crypto.createHash('md5').update(name + 'sync').digest().readUInt32BE(12) & 0x7fffffff
const schemas = new Map([['Skill','cast',10], ['SkillEnd','end',3], ['SkillNextSegment','segment',2]].map(([name,kind,length]) => [syncId(name),{kind,length}]))
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex').slice(0,16)
function actionEventsFromAreaSync(bytes, ownerHash, methodIndex) {
  const events = [], rejected = []
  let wrappers
  try { wrappers = normalizeSyncEnvelopes(bytes, methodIndex) }
  catch (error) { return { events, rejected: [{reason:error.message}] } }
  for (const wrapper of wrappers) {
    const schema = schemas.get(wrapper.syncId)
    if (!schema) continue
    try {
      if (!/^[a-f0-9]{16}$/.test(ownerHash || '')) throw Error('Action owner missing')
      const args = decode(wrapper.innerBytes, { rawStrings:true, useBigInt64:true })
      if (Array.isArray(args) && typeof args[0] === 'bigint' && args[0] > 0n && args[0] <= BigInt(Number.MAX_SAFE_INTEGER)) args[0] = Number(args[0])
      if (schema.kind === 'segment' && Array.isArray(args) && typeof args[1] === 'bigint' && args[1] >= 0n && args[1] <= BigInt(Number.MAX_SAFE_INTEGER)) args[1] = Number(args[1])
      if (!Array.isArray(args) || args.length !== schema.length || !Number.isSafeInteger(args[0]) || args[0] <= 0) throw Error('Unrecognized action layout: ' + (Array.isArray(args) ? args.length + ' fields, skill type ' + typeof args[0] : typeof args))
      if (schema.kind === 'segment' && (!Number.isSafeInteger(args[1]) || args[1] < 0)) throw Error('Invalid segment')
      // AreaMessage.id is the actor performing the sync, not a hit recipient.
      const target = schema.kind === 'cast' && args[5] instanceof Uint8Array && args[5].length ? hash(args[5]) : null
      const identifier = schema.kind === 'cast' && args[4] instanceof Uint8Array && args[4].length ? hash(args[4]) : null
      events.push({ actionKind:schema.kind, rawSkillId:args[0], sourceActorHash:ownerHash, targetActorHash:target,
        identifierHash:identifier, segment:schema.kind==='segment'?args[1]:null, syncId:wrapper.syncId,
        syncSubIndex:wrapper.batchIndex, envelopeMethod:methodIndex,
        timestampBasis:'packet_capture_completion', evidence:'server_skill_sync; not inferred from damage' })
    } catch (error) { rejected.push({syncId:wrapper.syncId, syncSubIndex:wrapper.batchIndex, reason:error.message}) }
  }
  return {events,rejected}
}
function actionEventFromProperty(row) {
  if (row.operation === 'visibility') {
    if (row.ownerHash != null && !/^[a-f0-9]{16}$/.test(row.ownerHash)) return {events:[],rejected:[{reason:'Invalid action visibility owner'}]}
    return {events:[{actionKind:'visibility',sourceActorHash:row.ownerHash || null,rawSkillId:null,
      endReason:row.boundaryReason,carrier:'sync_event_data',timestampBasis:'packet_capture_completion'}],rejected:[]}
  }
  const result = actionEventsFromAreaSync(encode([row.syncId, Buffer.from(row.args, 'base64')]), row.ownerHash, 1164740750)
  for (const event of result.events) {
    event.carrier = 'sync_event_data'
    event.initial = !!row.initial
    event.queue = row.queue || null
    if (event.actionKind === 'cast' && ['remove','boundary'].includes(row.operation)) {
      event.actionKind = row.operation === 'remove' ? 'end' : 'boundary'
      event.endConfirmed = row.operation === 'remove'
      event.endReason = row.boundaryReason
      event.evidence = 'server_skill_queue_lifetime; not client animation clock'
    } else if (row.initial && event.actionKind === 'cast') event.actionKind = 'snapshot'
  }
  return result
}
module.exports = { actionEventsFromAreaSync, actionEventFromProperty, syncId }
