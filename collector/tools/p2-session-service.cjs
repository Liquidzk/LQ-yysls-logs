'use strict';
// Local-only orchestration: read-only state snapshot + passive capture + unique
// framing/schema alignment. No injected code, game writes or replay-as-live.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process');
const root=path.resolve(__dirname,'..'),data=path.resolve(process.argv[process.argv.indexOf('--data')+1]);
const wait=ms=>new Promise(r=>setTimeout(r,ms)),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function backoff(ms){for(let left=ms;left>0&&!closing;left-=200)await wait(Math.min(left,200));}
fs.mkdirSync(data,{recursive:true});const stopFile=path.join(data,'stop');if(fs.existsSync(stopFile))fs.unlinkSync(stopFile);
const python=fs.existsSync(path.join(root,'runtime/python/python.exe'))?path.join(root,'runtime/python/python.exe'):'python.exe';
const tshark=fs.existsSync(path.join(root,'runtime/wireshark/tshark.exe'))?path.join(root,'runtime/wireshark/tshark.exe'):'C:/Program Files/Wireshark/tshark.exe';
const publisher=new (require('./p1-snapshot-publisher.cjs').SnapshotPublisher)();
const node=process.execPath;let current=null,latestPath=null;
const bindingFile=process.argv[process.argv.indexOf('--binding')+1];
const binding=JSON.parse(fs.readFileSync(bindingFile,'utf8'));
if(!Number.isInteger(binding.pid)||!binding.startedAt)throw Error('请手动选择游戏进程');
const children=new Set(); let closing=false;
function killOwned(p){if(!p.pid||p.exitCode!==null||p.signalCode!==null)return;const killer=spawn('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>p.kill());}
function stop(){if(closing)return;closing=true;fs.writeFileSync(path.join(data,'stop'),'');for(const p of children)killOwned(p);if(current)fs.writeFileSync(path.join(current.out,'stop'),'');}
process.stdin.on('data',stop);process.stdin.on('end',stop);process.stdin.resume();
process.on('SIGTERM',stop);process.on('SIGINT',stop);

function status(message,detail=''){const value={at:new Date().toISOString(),message,detail,latestPath,binding:{pid:binding.pid,startedAt:binding.startedAt}};const f=path.join(data,'service.json');publisher.write(f,value);}
function run(exe,args,{input=null,timeout=60000}={}){return new Promise((resolve,reject)=>{let stdout='',stderr='';const p=spawn(exe,args,{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});children.add(p);p.once('close',()=>children.delete(p));const timer=setTimeout(()=>p.kill(),timeout);p.stdout.on('data',b=>{stdout+=b;if(stdout.length>16*1024*1024)p.kill();});p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(stderr.slice(-1500)||'子进程退出 '+code));else resolve(stdout);});p.stdin.end(input);});}
async function discover(){return JSON.parse((await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'p2-discover.ps1'),'-GameProcessId',String(binding.pid),'-ExpectedStart',binding.startedAt])).replace(/^\uFEFF/,''));}
const key=m=>JSON.stringify([m.pid,m.processStartUtc,m.flows]);
async function bootstrap(m){
 if(closing)throw Error('采集已停止');if(!m.flows?.length)throw Error(m.connectionCounts?.ipv6?'所选进程当前仅有 IPv6 连接，当前解析链尚不支持该连接类型':'所选进程暂未发现已建立的 TCP 连接；请确认所选实例仍在运行');
 const profiles=JSON.parse(fs.readFileSync(path.join(root,'config/client-build.json')));
 const imageHash=sha(fs.readFileSync(m.modulePath));
 const profile=require('./client-profile.cjs').selectProfile(profiles,imageHash);
 if(!profile){
  // Keep the build mismatch distinct from routing: an accelerator connection
  // has already been discovered, but unknown offsets must never be applied.
  const variant=path.basename(path.dirname(m.modulePath));
  const routing=m.flows.some(f=>f.loopback)?'（经过本地加速器/转发）':'';
  const report={at:new Date().toISOString(),pid:m.pid,processStartUtc:m.processStartUtc,modulePath:m.modulePath,imageSha256:imageHash,supportedBuilds:(profiles.builds||[profiles]).map(p=>p.id),connectionCounts:m.connectionCounts};
  publisher.write(path.join(data,'unsupported-build.json'),report);
  throw Error(`已发现游戏连接${routing}；当前 ${variant} 游戏版本尚未适配，实时解析未启动。无需重新进入角色。可运行“检查当前游戏版本”生成本机适配资料。`);
 }
 const session=path.join(data,'sessions',new Date().toISOString().replace(/[:.]/g,'-')+'-'+m.pid),boot=path.join(session,'initialization');fs.mkdirSync(boot,{recursive:true});fs.writeFileSync(path.join(boot,'module.json'),JSON.stringify(m));
 status('正在初始化当前登录会话','正在采集连接并校验解码状态；此时请勿开始战斗。');
 const list=await run(tshark,['-D']);const available=list.split(/\r?\n/).map(l=>l.match(/^\d+\. (\\Device\\NPF_\S+)/)?.[1]).filter(Boolean);
 const interfaces=m.interfaces.filter(i=>available.some(a=>a.toLowerCase()===i.toLowerCase()));
 if(m.flows.some(f=>f.loopback)&&!interfaces.some(i=>i.toLowerCase()==='\\device\\npf_loopback'))throw Error('已识别游戏的本地转发连接，但 Npcap 没有提供回环采集接口');
 if(!interfaces.length)throw Error('没有可用抓包网卡，请检查 Npcap');
 const filter='tcp and ('+m.flows.map(f=>`(src host ${f.serverAddress} and src port ${f.serverPort} and dst host ${f.clientAddress} and dst port ${f.clientPort})`).join(' or ')+')';
 const fields=['frame.number','frame.time_epoch','frame.interface_id','ip.src','tcp.srcport','ip.dst','tcp.dstport','tcp.seq_raw','tcp.len','tcp.flags.syn','tcp.flags.fin','tcp.flags.reset','tcp.payload'];
 const log=path.join(boot,'capture.private.tsv'),stream=fs.createWriteStream(log);
 const capture=spawn(tshark,['-l','-n',...interfaces.flatMap(i=>['-i',i]),'-f',filter,'-a','duration:18','-s','0','-T','fields','-E','separator=/t','-E','occurrence=f',...fields.flatMap(f=>['-e',f])],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 children.add(capture);capture.once('close',()=>children.delete(capture));let err='';capture.stdout.pipe(stream);capture.stderr.on('data',b=>{err+=b;});
 const done=new Promise((res,rej)=>{capture.once('error',rej);capture.once('close',code=>stream.end(()=>code===0?res():rej(Error(err.slice(-1000)||'Capture failed'))));});done.catch(()=>{});
 try{await wait(6000);if(fs.existsSync(stopFile))throw Error('用户已关闭程序');await run(python,[path.join(__dirname,'p2-read-state.py'),boot]);await done;}catch(e){capture.kill();await done.catch(()=>{});throw e;}
 const recovery=JSON.parse(fs.readFileSync(path.join(boot,'rpc-state-recovery.json')));if(recovery.status!=='snapshot-ready')throw Error('解码状态尚未准备好：'+recovery.reason);
 const rows=fs.readFileSync(log,'utf8').trim().split(/\r?\n/).filter(Boolean).map(l=>{const a=l.split('\t');return{time:+a[1],iface:+a[2],src:a[3],sport:+a[4],dst:a[5],dport:+a[6],seq:+a[7],len:+a[8],data:Buffer.from(a[12]||'','hex')};}).filter(r=>r.len&&r.data.length===r.len);
 const groups=new Map();for(const r of rows){const k=JSON.stringify([r.iface,r.src,r.sport,r.dst,r.dport]);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
 let config=null,attempt=0;
 for(const group of groups.values()){
  try{
   group.sort((a,b)=>a.seq-b.seq||a.time-b.time);const first=group[0],origin=first.seq;let end=origin,bytes=Buffer.alloc(0),duplicates=0;
   for(const r of group){if(r.seq>end)throw Error('TCP gap');const overlap=Math.min(end-r.seq,r.data.length);if(overlap&&!bytes.subarray(r.seq-origin,r.seq-origin+overlap).equals(r.data.subarray(0,overlap)))throw Error('Conflicting overlap');duplicates+=overlap;bytes=Buffer.concat([bytes,r.data.subarray(overlap)]);end+=r.data.length-overlap;}
   if(bytes.length<64)continue;const at=Date.parse(recovery.snapshotAtUtc)/1000;const before=group.filter(r=>r.time<at-3),after=group.filter(r=>r.time<=at+3);if(!after.length)continue;
   const minCursor=before.length?Math.max(...before.map(r=>r.seq+r.data.length))-origin:0,maxCursor=Math.max(...after.map(r=>r.seq+r.data.length))-origin;
   const dir=path.join(boot,'candidate-'+(++attempt));fs.mkdirSync(dir);const cipherFile=path.join(dir,'cipher.private.bin');fs.writeFileSync(cipherFile,bytes);
   const flow={serverAddress:first.src,serverPort:first.sport,clientAddress:first.dst,clientPort:first.dport};const align={stateFile:recovery.stateObject,expectedVtable:recovery.expectedVtable,cipherFile,minCursor,maxCursor,maxPrefix:256,python,outDir:path.join(dir,'aligned'),metadata:{pid:m.pid,flow,gaps:0,overlapsVerified:true,captureStartTcpSequence:origin,duplicateBytes:duplicates,sourceTsvSha256:sha(fs.readFileSync(log)),snapshotAtUtc:recovery.snapshotAtUtc,interface:interfaces[first.iface]}};
   const alignFile=path.join(dir,'align.private.json');fs.writeFileSync(alignFile,JSON.stringify(align));await run(node,[path.join(__dirname,'align-rc4-late-state.cjs'),alignFile],{timeout:120000});
   const report=path.join(align.outDir,'report.json'),r=JSON.parse(fs.readFileSync(report));if(!r.unique||!r.roundTrip)continue;
   config={identityCacheFile:path.join(data,'identity-cache.json'),clientBuildSha256:profile.imageSha256,pid:m.pid,processStartUtc:m.processStartUtc,processPath:m.modulePath,flow,captureInterface:interfaces[first.iface],python,tshark,serverEncryptedOrigin:origin,initialStateFile:path.join(align.outDir,r.anchor.stateFile),initialStateSha256:r.anchor.stateSha256,cipherStateKind:'validated-midstream',cipherAnchorReport:report,cipherAnchorReportSha256:sha(fs.readFileSync(report)),gapTimeoutMs:3000,knownAcquisitionGaps:[{kind:'joined-existing-session',note:'Initialization is not a claim that earlier combat was captured.'}]};break;
  }catch(e){fs.appendFileSync(path.join(boot,'alignment-errors.log'),e.message+'\n');}
 }
 if(!config)throw Error('未找到唯一通过协议校验的解码状态，证据已保留');
 const now=await discover();if(now.pid!==m.pid||now.processStartUtc!==m.processStartUtc||!now.flows?.some(f=>['serverAddress','serverPort','clientAddress','clientPort'].every(k=>f[k]===config.flow[k])))throw Error('初始化期间游戏连接改变');
 const configFile=path.join(session,'session.private.json');fs.writeFileSync(configFile,JSON.stringify(config));const out=path.join(session,'capture');
 const child=spawn(node,[path.join(__dirname,'p1-live-pipeline.cjs'),'--config',configFile,'--out',out,'--duration','43200'],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>fs.appendFileSync(path.join(session,'pipeline-errors.log'),b));child.on('error',e=>status('采集启动失败',e.message));
 try{require('os').setPriority(child.pid,require('os').constants.priority.PRIORITY_BELOW_NORMAL);}catch{}current={child,out,key:key(m)};latestPath=path.join(out,'latest.json');status('采集启动中','已验证当前会话解码状态。');
}
(async()=>{
 status('正在绑定所选进程','PID '+binding.pid+'；进入角色后初始化。');
 while(!closing&&!fs.existsSync(stopFile)){
  try{
   if(current){if(current.child.exitCode!==null||current.child.signalCode!==null){status('正在恢复采集','采集进程已退出；历史数据保留');current=null;await wait(1000);continue;}const complete=path.join(current.out,'completion.json');if(fs.existsSync(complete)){const c=JSON.parse(fs.readFileSync(complete));status('正在恢复采集',c.status);current=null;await wait(10000);continue;}
    const health=path.join(current.out,'health.json');if(fs.existsSync(health)){const h=JSON.parse(fs.readFileSync(health));status(h.session==='valid'?'采集已就绪':'正在校验会话',h.reason||'');}await wait(2000);continue;}
   const m=await discover();if(m.status==='waiting-game'){status('所选游戏已退出，请重新绑定');break;}if(m.status!=='running'){status('绑定不可用，请重新选择进程',m.error||m.status);break;}await bootstrap(m);
  }catch(e){status('等待采集恢复',e.message);fs.appendFileSync(path.join(data,'service-errors.log'),new Date().toISOString()+' '+e.stack+'\n');await backoff(15000);}
 }
 if(current){fs.writeFileSync(path.join(current.out,'stop'),'');for(let i=0;i<40&&current.child.exitCode===null&&current.child.signalCode===null;i++)await wait(200);killOwned(current.child);}
 status('采集已停止','本地记录已保留。');await publisher.close();process.stdin.pause();
})().catch(async e=>{stop();if(current)killOwned(current.child);status('采集服务错误',e.message);await publisher.close();process.stdin.pause();process.exitCode=1;});
