const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {BattleArchive}=require('../collector/tools/battle-archive.cjs')
test('periodic settlement closes the archive even without a finish flag',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yanyun-archive-'))
 try {
  const archive=new BattleArchive(root,{sessionId:'test'}),start='2026-01-01T00:00:00Z',end='2026-01-01T00:00:10Z'
  const snapshot={sequence:1,observedAt:end,source:{sessionId:'test'},encounterClock:{startObservedAt:start},
   battleTimer:{phase:'finalized',startObservedAt:start,endObservedAt:end,durationSeconds:9.8}}
  archive.update(snapshot,[])
  const folder=path.join(root,'battles',fs.readdirSync(path.join(root,'battles'))[0])
  const b=JSON.parse(fs.readFileSync(path.join(folder,'battle.json')))
  assert.equal(b.status,'ended');assert.equal(b.clock.endObservedAt,end)
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'statistics.jsonl'))).encounterClock.endObservedAt,end)
  assert.equal(snapshot.encounterClock.endObservedAt,undefined)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
