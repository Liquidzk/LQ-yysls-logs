const {crypt,step,validate}=require('./rc4-state-offline.cjs');
const {normalize}=require('./normalize-rpc-blocks.cjs');
const crypto=require('crypto');
const {decode}=require('@msgpack/msgpack');
const LIMIT=16*1024*1024;
class OrderedCipher {
 constructor(state,origin,{onBytes,gapMs=3000,maxSkip=128*1024*1024}={}){this.s=validate({i:state.i,j:state.j,S:[...state.S]});this.origin=origin;this.next=null;this.base=null;this.pending=[];this.history=Buffer.alloc(0);this.onBytes=onBytes;this.gapMs=gapMs;this.maxSkip=maxSkip;this.gapSince=null;this.overlaps=0;}
 push(packet){
  let seq=packet.seq;if(this.next!==null){while(seq<this.next-0x80000000)seq+=0x100000000;while(seq>this.next+0x80000000)seq-=0x100000000;}
  if(!Number.isSafeInteger(seq)||seq<this.origin)throw Error('Sequence precedes session cipher origin');
  this.pending.push({...packet,seq});if(this.pending.reduce((n,x)=>n+x.data.length,0)>4*1024*1024)throw Error('TCP pending buffer exceeds 4MiB');
 }
 start(){if(this.next!==null||!this.pending.length)return;this.pending.sort((a,b)=>a.seq-b.seq);this.next=this.base=this.pending[0].seq;const skip=this.base-this.origin;if(skip>this.maxSkip)throw Error('Session sequence distance exceeds configured RC4 seek budget');for(let n=0;n<skip;n++)step(this.s);this.drain();}
 drain(now=Date.now()){
  if(this.next===null)return;
  this.pending.sort((a,b)=>a.seq-b.seq);
  while(this.pending.length){const p=this.pending[0];if(p.seq>this.next){this.gapSince??=now;return;}
   this.pending.shift();let overlap=Math.min(p.data.length,this.next-p.seq);
   if(overlap){if(p.seq<this.base)throw Error('Late packet before initialized capture start');const prev=this.history.subarray(p.seq-this.base,p.seq-this.base+overlap);if(prev.length!==overlap||!prev.equals(p.data.subarray(0,overlap)))throw Error('Conflicting or unverifiable TCP retransmission');this.overlaps+=overlap;}
   const add=p.data.subarray(overlap);if(!add.length)continue;
   // Bounded retransmission window, independent of session lifetime. Cipher
   // state continues forward; old evidence is retained by the raw disk ledger.
   const start=this.next;this.history=Buffer.concat([this.history,add]);this.next+=add.length;
   if(this.history.length>1024*1024){const trim=this.history.length-1024*1024;this.history=this.history.subarray(trim);this.base+=trim;}
   this.onBytes(crypt(this.s,add),{seq:start,endSeq:this.next,observedAt:p.observedAt,frame:p.frame});
   this.gapSince=null;
  }
 }
 tick(now=Date.now()){this.drain(now);if(this.gapSince!==null&&now-this.gapSince>=this.gapMs)throw Error('Unresolved TCP gap; continuity invalid');}
}
class BlockStream {
 constructor(onBlock){this.buf=Buffer.alloc(0);this.aligned=false;this.onBlock=onBlock;this.wireSeq=null;this.skipped=0;this.records=0;this.fragments=[];}
 push(bytes,meta){if(this.wireSeq===null)this.wireSeq=meta.seq;this.fragments.push({start:meta.seq,end:meta.seq+bytes.length,meta});this.buf=Buffer.concat([this.buf,bytes]);if(this.buf.length>LIMIT)throw Error('Framing buffer exceeds16MiB');
  if(!this.aligned){for(let off=0;off<Math.min(65536,Math.max(0,this.buf.length-3));off++){
    try{const r=normalize(this.buf.subarray(off),{maxBodyBytes:LIMIT,allowIncompleteTail:true});if(r.records.length>=3&&r.records.every(x=>x.methodIndex<128)){this.skipped=off;this.buf=this.buf.subarray(off);this.wireSeq+=off;this.aligned=true;break;}}catch{}
   }if(!this.aligned){if(this.buf.length>256*1024)throw Error('No validated server block boundary within64KiB prefix');return;}}
  const r=normalize(this.buf,{maxBodyBytes:LIMIT,allowIncompleteTail:true});
  for(const b of r.records){const start=this.wireSeq+b.inputOffset,end=start+b.inputBytes,parts=this.fragments.filter(x=>x.end>start&&x.start<end);const completion=parts.reduce((a,x)=>!a||x.meta.observedAt>a.observedAt?x.meta:a,null);this.onBlock(r.output.subarray(b.outputOffset+4,b.outputOffset+4+b.bodyBytes),{...completion,wireSequence:start,wireBytes:b.inputBytes,compressed:b.compressed,recordOrdinal:this.records++});}
  this.buf=this.buf.subarray(r.consumedBytes);this.wireSeq+=r.consumedBytes;this.fragments=this.fragments.filter(x=>x.end>this.wireSeq);
 }
}
function statisticFromBytes(bytes){const args=decode(bytes,{useBigInt64:true});if(!Array.isArray(args)||args.length!==1||!args[0]||typeof args[0]!=='object')throw Error('Unexpected statistic arguments');const d=args[0];if(!Number.isFinite(d.time_cost)||d.time_cost<0||!Number.isInteger(d.npc_no)||!Number.isInteger(d.stat_type)||!d.statistic||typeof d.statistic!=='object')throw Error('Invalid statistic schema');const actors=Object.entries(d.statistic).map(([id,a])=>{for(const k of ['damage','heal','absorb_dmg'])if(!Number.isFinite(a[k])||a[k]<0||a[k]>Number.MAX_SAFE_INTEGER)throw Error('Invalid actor total '+JSON.stringify({field:k,type:typeof a[k],value:String(a[k]),finite:Number.isFinite(a[k])}));return {idHash:crypto.createHash('sha256').update(id).digest('hex').slice(0,16),damage:a.damage,heal:a.heal,absorbDmg:a.absorb_dmg};});return {npcNo:d.npc_no,statType:d.stat_type,timeCostSeconds:d.time_cost,actors};}
function rawEventValue(v){if(typeof v==='bigint')return v>=BigInt(Number.MIN_SAFE_INTEGER)&&v<=BigInt(Number.MAX_SAFE_INTEGER)?Number(v):{type:'integer64',value:v.toString()};if(v instanceof Uint8Array)return {type:'msgpack-string-bytes',base64:Buffer.from(v).toString('base64')};return v===undefined?null:v;}
function damageEventFromWrapper(bytes,targetActorHash){const a=decode(bytes,{rawStrings:true,useBigInt64:true});if(!Array.isArray(a)||a.length<2)throw Error('Invalid sync wrapper');if(a[0]!==1792714907)return null;if(!(a[1] instanceof Uint8Array))throw Error('Sync arguments must preserve binary string');const d=decode(a[1],{rawStrings:true,useBigInt64:true});if(!Array.isArray(d)||d.length!==17)throw Error('Unrecognized BehitWithoutAnim argument layout');for(const i of [0,1]){if(typeof d[i]==='bigint'&&d[i]>=0n&&d[i]<=BigInt(Number.MAX_SAFE_INTEGER))d[i]=Number(d[i]);if(!Number.isFinite(d[i])||d[i]<0||d[i]>Number.MAX_SAFE_INTEGER||([3,4].includes(i)&&!Number.isInteger(d[i])))throw Error('Unsupported numeric damage event field '+i);}if(!(d[2] instanceof Uint8Array)||!d[2].length)throw Error('Damage event source ID missing');return {eventKind:'server_behit_without_anim',syncId:a[0],sourceActorHash:crypto.createHash('sha256').update(d[2]).digest('hex').slice(0,16),targetActorHash,amount:d[0],hurt:d[1],rawSkillId:rawEventValue(d[3]),rawCalcpointId:rawEventValue(d[4]),strength:rawEventValue(d[8]),absorbedHeal:rawEventValue(d[11]),damageFlags:String(d[14]),behitParam:String(d[13]),serverTimestamp:null,timestampBasis:'packet_capture_completion; not server event time',semanticStatus:'static BEHIT_ARGS mapping and one solo sample conservation; completeness beyond sample unverified'};}
module.exports={OrderedCipher,BlockStream,statisticFromBytes,damageEventFromWrapper};
