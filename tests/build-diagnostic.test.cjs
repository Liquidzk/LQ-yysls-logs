const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {spawnSync}=require('node:child_process')
function run(writable=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yanyun-code-diagnostic-'))
 const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'build-diagnostic-fixture.ps1'),'-DiagnosticScript',path.join(__dirname,'../collector/tools/collect-build-diagnostic.ps1'),'-FixtureDirectory',dir,...(writable?['-WritableSection']:[])],{encoding:'utf8',windowsHide:true,timeout:15000})
 return {dir,result}
}
test('Windows PowerShell diagnostic reads exact test-process ranges and writes verifiable metadata',{skip:process.platform!=='win32'},()=>{
 const {dir,result}=run();assert.equal(result.status,0,result.stderr)
 const output=path.join(dir,'output'),folder=path.join(output,fs.readdirSync(output)[0])
 const manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8').replace(/^\uFEFF/,''))
 assert.equal(manifest.sections.length,2)
 for(const section of manifest.sections){
  assert.equal(section.chunks.length,1);assert.equal(section.chunks[0].read,256);assert.equal(section.chunks[0].success,true)
  assert.deepEqual(fs.readFileSync(section.file),Buffer.from(Array.from({length:256},(_,i)=>i)))
 }
})
test('diagnostic rejects writable sections before process reads',{skip:process.platform!=='win32'},()=>{
 const {dir,result}=run(true);assert.notEqual(result.status,0);assert.match(result.stderr,/writable/)
 assert.equal(fs.existsSync(path.join(dir,'output')),false)
})
