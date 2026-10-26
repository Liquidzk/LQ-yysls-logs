'use strict';
// Normalizes the two observed AreaMessage sync envelopes. Does not deduplicate
// equal-looking gameplay events: original transport order and batch ordinal matter.
const {decode,encode}=require('@msgpack/msgpack');
const {damageEventFromWrapper}=require('./p1-live-core.cjs');
const SINGLE_SYNC_METHOD=1164740750,BATCH_SYNC_METHOD=1000155338;
function normalizeSyncEnvelopes(bytes,methodIndex){
 if(![SINGLE_SYNC_METHOD,BATCH_SYNC_METHOD].includes(methodIndex))return [];
 const args=decode(bytes,{rawStrings:true,useBigInt64:true});
 let items;
 if(methodIndex===SINGLE_SYNC_METHOD)items=[args];
 else{
  if(!Array.isArray(args)||args.length!==1||!Array.isArray(args[0]))throw Error('Invalid batch sync envelope');
  if(args[0].length>4096)throw Error('Batch sync size limit exceeded');
  items=args[0];
 }
 return items.map((item,index)=>{
  if(!Array.isArray(item)||item.length<2||item.length>3||!Number.isSafeInteger(item[0])||!(item[1] instanceof Uint8Array))throw Error('Invalid sync item at batch index '+index);
  if(methodIndex===BATCH_SYNC_METHOD&&(item.length!==3||!(item[2] instanceof Uint8Array)))throw Error('Invalid batch extra payload at index '+index);
  // Inner MessagePack bytes are preserved byte-for-byte; re-encoding only the
  // outer wrapper lets the existing strict BEHIT decoder process either carrier.
  return {syncId:item[0],batchIndex:methodIndex===BATCH_SYNC_METHOD?index:null,envelopeMethod:methodIndex,
   normalizedWrapper:Buffer.from(encode(item)),innerBytes:Buffer.from(item[1]),extraBytes:item[2]?Buffer.from(item[2]):null};
 });
}
function damageEventsFromAreaSync(bytes,targetActorHash,methodIndex=SINGLE_SYNC_METHOD){
 if(![SINGLE_SYNC_METHOD,BATCH_SYNC_METHOD].includes(methodIndex))return {events:[],rejected:[]};
 let args;
 try{args=decode(bytes,{rawStrings:true,useBigInt64:true});}catch(e){return {events:[],rejected:[{syncSubIndex:null,reason:'Invalid outer MessagePack: '+e.message}]};}
 let items;
 if(methodIndex===SINGLE_SYNC_METHOD)items=[args];
 else if(!Array.isArray(args)||args.length!==1||!Array.isArray(args[0])||args[0].length>4096)return {events:[],rejected:[{syncSubIndex:null,reason:'Invalid or oversized batch envelope'}]};
 else items=args[0];
 const events=[],rejected=[];
 for(let i=0;i<items.length;i++){
  const item=items[i],syncSubIndex=methodIndex===BATCH_SYNC_METHOD?i:null;
  try{
   if(!Array.isArray(item)||item.length<2||item.length>3||!Number.isSafeInteger(item[0])||!(item[1] instanceof Uint8Array))throw Error('Invalid sync item');
   if(methodIndex===BATCH_SYNC_METHOD&&(item.length!==3||!(item[2] instanceof Uint8Array)))throw Error('Invalid batch extra payload');
   const event=damageEventFromWrapper(Buffer.from(encode(item)),targetActorHash);
   if(event)events.push({...event,syncSubIndex,envelopeMethod:methodIndex});
  }catch(e){rejected.push({syncSubIndex,reason:e.message});}
 }
 return {events,rejected};
}
module.exports={SINGLE_SYNC_METHOD,BATCH_SYNC_METHOD,normalizeSyncEnvelopes,damageEventsFromAreaSync};
