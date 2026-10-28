const fs=require('fs'),crypto=require('crypto');
const {validate}=require('./rc4-state-offline.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function loadCipherAnchor(c){
 const bytes=fs.readFileSync(c.initialStateFile);
 if(hash(bytes)!==c.initialStateSha256)throw Error('Cipher state hash mismatch');
 const state=validate(JSON.parse(bytes));
 if(!c.cipherStateKind||c.cipherStateKind==='login-initial'){
  if(state.i!==0||state.j!==0)throw Error('Expected independently validated initial RC4 state');
  return state;
 }
 if(c.cipherStateKind!=='validated-midstream')throw Error('Unsupported cipher anchor kind');
 const reportBytes=fs.readFileSync(c.cipherAnchorReport);
 if(hash(reportBytes)!==c.cipherAnchorReportSha256)throw Error('Cipher anchor report hash mismatch');
 const r=JSON.parse(reportBytes),a=r.anchor,m=r.metadata;
 if(r.unique!==true||r.roundTrip!==true||r.validatedCandidates?.length!==1||!a||a.records<6||!r.validatedCandidates[0].schema?.valid)throw Error('Cipher anchor lacks unique schema validation');
 if(a.stateSha256!==c.initialStateSha256||a.captureStartTcpSequence!==c.serverEncryptedOrigin)throw Error('Cipher anchor state or TCP origin mismatch');
 if(m?.pid!==c.pid||m.gaps!==0||m.overlapsVerified!==true)throw Error('Cipher anchor process or continuity mismatch');
 for(const key of ['serverAddress','serverPort','clientAddress','clientPort'])if(m.flow?.[key]!==c.flow?.[key])throw Error('Cipher anchor flow mismatch');
 if(c.transport==='kcp'&&(m.transport!=='kcp'||m.kcpConversation!==c.kcp?.conversation||m.kcpFirstSequence!==c.kcp?.firstSequence||m.remoteEndpoint?.address!==c.kcp?.remoteEndpoint?.address||m.remoteEndpoint?.port!==c.kcp?.remoteEndpoint?.port))throw Error('KCP anchor identity mismatch');
 return state;
}
module.exports={loadCipherAnchor};
