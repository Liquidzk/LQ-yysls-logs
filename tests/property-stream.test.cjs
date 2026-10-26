const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path')
const {spawnSync}=require('node:child_process')
test('current real property indices decode names and buff lifecycle without mixing unresolved actors',()=>{
 const root=path.resolve(__dirname,'..'),profile=require('../collector/config/client-build.json').builds.find(p=>p.id==='cn-win64r-20261023')
 const r=spawnSync(path.join(root,'runtime/collector/runtime/python/python.exe'),[path.join(__dirname,'property-stream-fixture.py'),'--client-build',profile.imageSha256],{encoding:'utf8',windowsHide:true,timeout:15000})
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).passed,true)
})
