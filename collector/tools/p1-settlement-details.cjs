'use strict';
const crypto=require('crypto'),{decode}=require('@msgpack/msgpack');
const hash=id=>crypto.createHash('sha256').update(id).digest('hex').slice(0,16);
const object=x=>x&&typeof x==='object'&&!Array.isArray(x)&&!(x instanceof Uint8Array);
const amount=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=Number.MAX_SAFE_INTEGER;
function decodeStatisticPayload(bytes){
 const args=decode(bytes,{useBigInt64:true,mapKeyConverter:k=>{if(typeof k==='string')return k;if(typeof k==='bigint')return k.toString();if(typeof k==='number'&&Number.isSafeInteger(k))return String(k);throw Error('Unsupported statistic dictionary key');}});
 if(!Array.isArray(args)||args.length!==1||!object(args[0]))throw Error('Invalid statistic arguments');return args[0];
}
function parseTotals(d){if(!object(d))throw Error('Missing actor totals');const out={};for(const k of ['damage','heal','absorb_dmg']){if(!amount(d[k]))throw Error('Invalid settlement total '+k);out[k]=d[k];}return out;}
function parseCategory(d){
 if(!object(d))throw Error('Invalid target category');const skills=[],breakdown={};
 for(const [key,value]of Object.entries(d)){if(!amount(value))throw Error('Invalid settlement category amount');if(/^\d+$/.test(key))skills.push({skillId:key,amount:value});else breakdown[key]=value;}
 const skillTotal=skills.reduce((n,s)=>n+s.amount,0);if(!amount(skillTotal))throw Error('Settlement skill total overflow');
 return {skills,skillTotal,breakdown,breakdownPolicy:'Alternative breakdown of the same output; never added to skillTotal'};
}
function parseOwnSkillDetails(details,counters){
 const targets=[],skillCounters=[];
 if(details!==undefined){
  if(!object(details))throw Error('Invalid own skill details');
  for(const [target,d]of Object.entries(details)){
   if(!object(d))throw Error('Invalid own skill detail target');const categories={};
   for(const kind of ['damage','heal','absorb_dmg'])if(d[kind]!==undefined){
    if(!object(d[kind]))throw Error('Invalid own skill detail category');const skills=[];
    for(const [skillId,v]of Object.entries(d[kind])){
     if(!/^\d+$/.test(skillId)||!object(v)||!Number.isSafeInteger(v.count)||v.count<0||!amount(v.min)||!amount(v.max)||v.min>v.max)throw Error('Invalid own skill min/max/count');
     skills.push({skillId,count:v.count,min:v.min,max:v.max});
    }
    categories[kind]=skills;
   }
   targets.push({targetActorHash:hash(target),categories});
  }
 }
 if(counters!==undefined){
  if(!object(counters))throw Error('Invalid own skill counters');
  for(const [skillId,count]of Object.entries(counters)){
   if(!/^\d+$/.test(skillId)||!Number.isSafeInteger(count)||count<0)throw Error('Invalid own skill counter');
   skillCounters.push({skillId,count});
  }
 }
 return {targets,skillCounters,perHit:false,meaning:'Server per-skill min/max/count summary; counters retain server naming, not inferred casts or execution timestamps.'};
}
function settlementFromObject(d){
 if(d.stat_type!==2||!amount(d.time_cost)||!object(d.combat_stat))throw Error('Invalid detailed settlement schema');
 const actors=[];
 for(const [id,a]of Object.entries(d.combat_stat)){
  if(!id||!object(a)||!object(a.combat_stat_detail))throw Error('Invalid settlement actor');
  const totals=parseTotals(a.combat_stat),targets=[];
  for(const [target,t]of Object.entries(a.combat_stat_detail)){
   if(!target||!object(t))throw Error('Invalid settlement target');const categories={};
   for(const kind of ['damage','heal','absorb_dmg'])if(Object.hasOwn(t,kind))categories[kind]=parseCategory(t[kind]);
   targets.push({targetActorHash:hash(target),categories});
  }
  const residuals={};for(const kind of ['damage','heal','absorb_dmg'])residuals[kind]=totals[kind]-targets.reduce((n,t)=>n+(t.categories[kind]?.skillTotal||0),0);
  actors.push({actorHash:hash(id),totals,targets,targetSumResiduals:residuals,ownSkillDetails:parseOwnSkillDetails(a.own_skill_detail,a.own_skill_counter)});
 }
 if(!actors.length)throw Error('Empty detailed settlement');
 return {schemaVersion:1,kind:'server-detailed-settlement',statType:2,timeCostSeconds:d.time_cost,actors,resource:'HP-statistic-categories',perHit:false,limits:['End settlement has no per-hit timestamp or buff snapshot.','Numeric skill totals and hit-result breakdowns are alternative views, not additive.','Damage totals may include self/friendly damage; target hostility must be established separately.','absorb_dmg retains server naming; not treated as qi output.','Boss identity is contextual unless explicitly present in the payload.']};
}
function auditSettlement(detail,events,{enemyIds,targetIds,startRecord,endRecord,eventsComplete=true}={}){
 const enemies=new Set(targetIds||enemyIds||[]),hasWindow=Number.isInteger(startRecord)&&Number.isInteger(endRecord)&&endRecord>=startRecord;
 if(!hasWindow||!enemies.size)return {status:'unavailable',reason:'Missing observed encounter boundary or enemy identities',rdpsReady:false};
 const pairs=new Map();for(const e of events){if(e.transportRecordOrdinal<startRecord||e.transportRecordOrdinal>endRecord)continue;const key=JSON.stringify([e.sourceActorHash,e.targetActorHash]);const p=pairs.get(key)||{amount:0,count:0};p.amount+=e.amount;p.count++;pairs.set(key,p);}
 const actors=detail.actors.map(a=>{
  let expected=0,observed=0,selfExcluded=0,unknownExcluded=0,ambiguous=false;const targets=[];
  for(const t of a.targets){const d=t.categories.damage;if(!d)continue;
   if(t.targetActorHash===a.actorHash){selfExcluded+=d.skillTotal;continue;}
   if(!enemies.has(t.targetActorHash)){unknownExcluded+=d.skillTotal;continue;}
   const p=pairs.get(JSON.stringify([a.actorHash,t.targetActorHash]))||{amount:0,count:0};const mixed=(t.categories.heal?.skillTotal||0)>0;ambiguous||=mixed;expected+=d.skillTotal;observed+=p.amount;
   targets.push({targetActorHash:t.targetActorHash,expectedDamage:d.skillTotal,observedNotificationAmount:p.amount,residual:d.skillTotal-p.amount,notifications:p.count,mixedDamageAndHealing:mixed});
  }
  const residual=expected-observed;
  return {actorHash:a.actorHash,expectedScopedDamage:expected,observedScopedAmount:observed,residual,selfExcluded,unknownExcluded,amountConserved:eventsComplete&&!ambiguous&&unknownExcluded===0&&Math.abs(residual)<1e-5,targets};
 });
 return {schemaVersion:1,status:'audited',rdpsReady:false,window:{startRecord,endRecord,basis:'Observed server battle-state message ordering'},timeCostSeconds:detail.timeCostSeconds,eventsComplete,damageEventsComplete:false,actors,conservedActors:actors.filter(a=>a.amountConserved).length,totalActors:actors.length,limits:['eventsComplete covers retained accepted notifications only; it does not claim all game damage was transmitted.','Amount conservation alone does not validate execution-time buff eligibility or counterfactual attribution.','Pairs mixing damage and healing are ambiguous and never declared conserved.','Only supplied target identities are included; NPC identity alone does not prove hostility. Self damage is excluded.','Battle-state receipt order can exclude opening attacks received before the active flag; residuals do not alone prove lost capture.']};
}
class SettlementAuditBuffer{
 constructor(limit=20000){if(!Number.isInteger(limit)||limit<1)throw Error('Invalid audit buffer limit');this.limit=limit;this.events=[];this.head=0;this.droppedThrough=-1;this.lastRejectedRecord=-1;this.clock=null;this.npcs=new Set();this.observedAttempts=0;}
 observeDamage(e,record){this.events.push({sourceActorHash:e.sourceActorHash,targetActorHash:e.targetActorHash,amount:e.amount,transportRecordOrdinal:record});if(this.events.length-this.head>this.limit){this.droppedThrough=this.events[this.head++].transportRecordOrdinal;}if(this.head>=this.limit){this.events=this.events.slice(this.head);this.head=0;}}
 reject(record){this.lastRejectedRecord=record;}
 observeEncounter(e,record){
  if(e.kind==='boss-battle-state'){
   if(e.initial){this.clock=null;this.npcs.clear();}
   if(e.active&&e.previousActive===false&&e.stateChanged&&!e.initial){this.observedAttempts++;this.clock={spaceHash:e.spaceHash,startRecord:record,endRecord:null};this.npcs=new Set((e.identityContext?.npcs||[]).map(n=>n.actorHash));}
   if(!e.active&&this.clock?.spaceHash===e.spaceHash&&this.clock.endRecord===null)this.clock.endRecord=record;
  }
  if(e.kind==='encounter-identity'&&this.clock?.spaceHash===e.spaceHash&&this.clock.endRecord===null)for(const n of e.npcs||[])this.npcs.add(n.actorHash);
 }
 audit(detail){
  // This detailed response has no attempt token. Do not silently associate a
  // delayed response with a later attempt, even when duration/totals coincide.
  if(this.observedAttempts>1)return {status:'unavailable',reason:'Multiple observed attempts; detailed response lacks an attempt identifier',observedAttempts:this.observedAttempts,rdpsReady:false};
  const c=this.clock,r=auditSettlement(detail,this.events.slice(this.head),{targetIds:[...this.npcs],startRecord:c?.startRecord,endRecord:c?.endRecord,eventsComplete:!!c&&this.droppedThrough<c.startRecord&&this.lastRejectedRecord<c.startRecord});
  if(r.status!=='audited')return r;
  return {...r,status:'candidate-comparison',windowAssociation:'unverified-receive-order-context',associationValidated:false,reason:'Only one attempt observed, but the response itself does not prove attempt identity',candidateAmountMatches:r.conservedActors,conservedActors:0,actors:r.actors.map(a=>({...a,amountMatches:a.amountConserved,amountConserved:false}))};
 }
}
module.exports={decodeStatisticPayload,settlementFromObject,auditSettlement,SettlementAuditBuffer};
