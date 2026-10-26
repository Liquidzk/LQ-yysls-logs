'use strict';
// Offline only. A snapshot may be anywhere in an already-running RC4 stream.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawnSync}=require('child_process');
const rc4=require('./rc4-state-offline.cjs'),{normalize}=require('./normalize-rpc-blocks.cjs');
const clone=s=>({i:s.i,j:s.j,S:[...s.S]}),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function candidates(snapshot,cipher,{minCursor,maxCursor,maxPrefix=256,maxBodyBytes=16*1024*1024,minRecords=6,maxCandidates=32,maxProbePairs=300000000}={}){
 rc4.validate(snapshot);
 for(const v of [minCursor,maxCursor,maxPrefix,minRecords])if(!Number.isSafeInteger(v)||v<0)throw Error('Nonnegative integer search bounds required');
 if(maxCursor<minCursor||maxCursor>64*1024*1024||cipher.length>32*1024*1024||minRecords<3)throw Error('Search exceeds explicit memory/safety bounds');
 const prefix=Math.min(maxPrefix,Math.max(0,cipher.length-10));
 if((maxCursor-minCursor+1)*(prefix+1)>maxProbePairs)throw Error('Probe budget exceeded; narrow snapshot byte bounds or prefix range');
 // K[-1] is the last byte consumed by snapshot; K[0] is its next byte.
 const forward=Math.max(0,cipher.length-minCursor),key=Buffer.alloc(maxCursor+forward);
 let s=clone(snapshot);for(let n=maxCursor-1;n>=0;n--)key[n]=rc4.backstep(s);
 s=clone(snapshot);for(let n=maxCursor;n<key.length;n++)key[n]=rc4.step(s);
 const result=[];let probes=0,headerMatches=0;
 for(let cursor=minCursor;cursor<=maxCursor;cursor++){
  const shift=maxCursor-cursor;
  for(let off=0;off<=prefix;off++){
   probes++;const at=shift+off;
   const word=((cipher[off]^key[at])|((cipher[off+1]^key[at+1])<<8)|((cipher[off+2]^key[at+2])<<16)|((cipher[off+3]^key[at+3])<<24))>>>0;
   const n=word&0x7fffffff,compressed=!!(word&0x80000000);
   if(n<2||n>maxBodyBytes||n>cipher.length-off-4)continue;
   if(compressed){
    if(n<9||((cipher[off+8]^key[at+8])!==0x28)||((cipher[off+9]^key[at+9])!==0xb5)||((cipher[off+10]^key[at+10])!==0x2f)||((cipher[off+11]^key[at+11])!==0xfd))continue;
   }else if(((cipher[off+4]^key[at+4])|((cipher[off+5]^key[at+5])<<8))>=128)continue;
   headerMatches++;
   const plain=Buffer.alloc(cipher.length-off);for(let i=off;i<cipher.length;i++)plain[i-off]=cipher[i]^key[shift+i];
   try{
    const normalized=normalize(plain,{allowIncompleteTail:true,maxBodyBytes});
    if(normalized.records.length<minRecords||normalized.records.some(r=>r.methodIndex>=128))continue;
    result.push({cursor,discardedPrefixBytes:off,plain,normalized});
    if(result.length>maxCandidates)throw Error('Too many framing candidates; require tighter bounds');
    break; // The earliest fully validated framing prefix suffices for this cursor.
   }catch(e){if(e.message.startsWith('Too many'))throw e;}
  }
 }
 return {candidates:result,probes,headerMatches};
}
function main(){
 const [configFile]=process.argv.slice(2);if(!configFile)throw Error('Usage: node align-rc4-late-state.cjs OFFLINE_CONFIG_JSON');
 const c=JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
 if(!c.outDir||fs.existsSync(c.outDir))throw Error('A new output directory is required');
 if(!c.python)throw Error('Explicit Python executable required for descriptor validation');
 const object=fs.readFileSync(c.stateFile),cipher=fs.readFileSync(c.cipherFile);
 const snapshot=c.stateFormat==='json'?rc4.validate(JSON.parse(object.toString('utf8'))):rc4.stateFromObject(object,c.expectedVtable?BigInt(c.expectedVtable):undefined);
 const found=candidates(snapshot,cipher,c),answers=[];
 for(const candidate of found.candidates){
  const bodies=candidate.normalized.records.map(r=>candidate.normalized.output.subarray(r.outputOffset+4,r.outputOffset+4+r.bodyBytes).toString('base64'));
  const p=spawnSync(c.python,[path.join(__dirname,'verify-rpc-bodies-offline.py')],{input:JSON.stringify({bodies,minRecords:c.minRecords??6}),encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
  if(p.error)throw p.error;if(p.status!==0)throw Error('Schema verification worker failed: '+p.stderr.slice(0,500));
  const verification=JSON.parse(p.stdout);if(verification.valid)answers.push({...candidate,verification});
 }
 fs.mkdirSync(c.outDir,{recursive:true});
 const report={schemaVersion:1,scope:'Offline midstream state alignment; no KSA or login assumption',stateSha256:hash(object),cipherSha256:hash(cipher),code:['align-rc4-late-state.cjs','verify-rpc-bodies-offline.py','rc4-state-offline.cjs','normalize-rpc-blocks.cjs'].map(file=>({file,sha256:hash(fs.readFileSync(path.join(__dirname,file)))})),search:{minCursor:c.minCursor,maxCursor:c.maxCursor,maxPrefix:c.maxPrefix??256},probes:found.probes,headerMatches:found.headerMatches,framingCandidates:found.candidates.length,validatedCandidates:answers.map(x=>({cursor:x.cursor,discardedPrefixBytes:x.discardedPrefixBytes,records:x.normalized.records.length,tailBytes:x.normalized.tailBytes,schema:x.verification})),unique:answers.length===1,metadata:c.metadata??null,limits:['Snapshot must be the same connection and inbound RC4 instance, captured consistently.','Input ciphertext must be contiguous ordered server bytes with verified overlaps; this tool does not establish packet provenance.','Cursor is bytes processed after ciphertext start at snapshot, not bytes since login.','A bounded negative result does not establish encryption change; preserve search bounds.','Protocol validation establishes a decode anchor, not combat completeness, event timing or rDPS attribution.']};
 if(answers.length===1){
  const a=answers[0],stateAtStart=clone(snapshot);rc4.rewind(stateAtStart,a.cursor);
  const round=clone(stateAtStart);for(let i=0;i<a.cursor;i++)rc4.step(round);
  report.roundTrip=round.i===snapshot.i&&round.j===snapshot.j&&round.S.every((v,i)=>v===snapshot.S[i]);if(!report.roundTrip)throw Error('State reversal roundtrip failed');
  fs.writeFileSync(path.join(c.outDir,'state-at-capture-start.private.json'),JSON.stringify(stateAtStart));
  fs.writeFileSync(path.join(c.outDir,'server-framed-decrypted.private.bin'),a.plain);
  fs.writeFileSync(path.join(c.outDir,'server-normalized.private.bin'),a.normalized.output);
  report.anchor={cursorAtSnapshot:a.cursor,captureStartTcpSequence:c.metadata?.captureStartTcpSequence??null,stateFile:'state-at-capture-start.private.json',stateSha256:hash(Buffer.from(JSON.stringify(stateAtStart))),discardedPrefixBytes:a.discardedPrefixBytes,records:a.normalized.records.length,normalizedSha256:hash(a.normalized.output),tailBytes:a.normalized.tailBytes};
 }
 fs.writeFileSync(path.join(c.outDir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({unique:report.unique,framingCandidates:found.candidates.length,validatedCandidates:answers.length,report:path.join(c.outDir,'report.json'),anchor:report.anchor}));
 if(!report.unique)process.exitCode=2;
}
module.exports={candidates};if(require.main===module)main();
