// Evidence-backed match roster decoder. Never infers identities from damage totals.
const {decode}=require('@msgpack/msgpack');
const crypto=require('crypto');
const MATCH_ROSTER_METHOD=1376711304;
function namesFromMatchWrapper(bytes,methodIndex=MATCH_ROSTER_METHOD){
 if(methodIndex!==MATCH_ROSTER_METHOD)return [];
 const a=decode(bytes,{useBigInt64:true});
 if(!Array.isArray(a)||a.length!==3||a[0]!==3||a[1]!==0)return [];
 const players=a[2]?.players_data;
 if(!players||Array.isArray(players)||typeof players!=='object')return [];
 const rows=[];
 for(const [id,p] of Object.entries(players)){
  if(!p||typeof p!=='object'||typeof p.pid!=='string'||p.pid!==id||!id.length)continue;
  if(typeof p.nickname!=='string'||!p.nickname.trim()||Buffer.byteLength(p.nickname,'utf8')>256||/[\u0000-\u001f\u007f]/u.test(p.nickname))continue;
  rows.push({idHash:crypto.createHash('sha256').update(id,'utf8').digest('hex').slice(0,16),name:p.nickname,nameSource:'wire.match.players_data.nickname',identityEvidence:{methodIndex:MATCH_ROSTER_METHOD,argumentPath:'args[2].players_data[pid].nickname',pidEqualsDictionaryKey:true}});
 }
 return rows;
}
module.exports={MATCH_ROSTER_METHOD,namesFromMatchWrapper};
