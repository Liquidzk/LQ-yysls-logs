const test = require('node:test'), assert = require('node:assert/strict')
const { encode } = require('@msgpack/msgpack')
const { actionEventsFromAreaSync: parse, actionEventFromProperty, syncId } = require('../collector/tools/action-events.cjs')
const owner='aaaaaaaaaaaaaaaa', single=1164740750,batch=1000155338
const item=(name,args)=>[syncId(name),encode(args,{useBigInt64:true}),encode({})]
test('server action ownership, targets, ordering and simultaneous casts stay separate',()=>{
  assert.equal(syncId('BehitWithoutAnim'),1792714907)
  const args=[20801206,[0,0,0],0,null,Buffer.from('identifier'),Buffer.from('target'),null,null,false,0]
  const result=parse(encode([[item('Skill',args),item('Skill',args),item('SkillNextSegment',[20801206,2n]),item('SkillEnd',[20801206,null,null])]]),owner,batch)
  assert.equal(result.rejected.length,0);assert.deepEqual(result.events.map(x=>x.actionKind),['cast','cast','segment','end'])
  assert.equal(result.events[0].sourceActorHash,owner);assert.notEqual(result.events[0].targetActorHash,owner)
  assert.equal(result.events[1].syncSubIndex,1);assert.equal(result.events[2].segment,2)
})
test('unknown sync is ignored and malformed known actions cannot be invented',()=>{
  assert.equal(parse(encode(item('Skill',[123])),owner,single).rejected.length,1)
  assert.equal(parse(encode(item('Other',[123])),owner,single).events.length,0)
  assert.equal(parse(encode(item('SkillEnd',[123,null,null])),null,single).events.length,0)
})
test('property snapshot is not a cast and safe 64-bit skill IDs decode exactly',()=>{
  const row={ownerHash:owner,syncId:syncId('Skill'),args:Buffer.from(encode([123n,null,null,null,null,null,null,null,null,null],{useBigInt64:true})).toString('base64'),initial:true}
  const snapshot=actionEventFromProperty(row)
  assert.equal(snapshot.events[0].actionKind,'snapshot');assert.equal(snapshot.events[0].rawSkillId,123)
  assert.equal(actionEventFromProperty({...row,initial:false}).events[0].actionKind,'cast')
  assert.equal(parse(encode(item('SkillEnd',[9007199254740993n,null,null])),owner,single).events.length,0)
})
