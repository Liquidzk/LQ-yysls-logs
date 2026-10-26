const test=require('node:test'),assert=require('node:assert/strict')
const {selectProfile}=require('../collector/tools/client-profile.cjs')
const config=require('../collector/config/client-build.json')
test('each known image selects its own offsets; an unknown or duplicate hash never falls back',()=>{
 assert.equal(selectProfile(config,config.builds[0].imageSha256).offsets.luaRootRva,'0x836b748')
 assert.equal(selectProfile(config,config.builds[1].imageSha256).offsets.luaRootRva,'0x83754b8')
 assert.equal(selectProfile(config,'0'.repeat(64)),null)
 assert.equal(selectProfile({builds:[config.builds[0],config.builds[0]]},config.builds[0].imageSha256),null)
})
