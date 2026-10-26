"""Incremental public/own-client buff evidence, preset 10012; never attribution.

Reuses p1-buff-extract.py and p1-buff-normalize.py mappings. Unknown removal,
AOI and clock semantics are retained as uncertainty, not silently validated.
"""
import pathlib,json,hashlib,copy,collections
ROOT=pathlib.Path(__file__).resolve().parents[1]
INDEX=ROOT/'evidence/p1/encounter-retest/index-names.json'
INDEX_SHA='b274d7be7fecfdd1fa94532d818c07ccdba1d56d35f2e6bd9845a41fa9f052d6'
def hashed(value):return hashlib.sha256(value if isinstance(value,bytes) else str(value).encode()).hexdigest()[:16]

class BuffStream:
 def __init__(self):
  data=INDEX.read_bytes()
  if hashlib.sha256(data).hexdigest()!=INDEX_SHA:raise ValueError('Buff property preset evidence changed')
  self.names={r['index']:r['name'] for r in json.loads(data)['rows']}
  self.guids={};self.classes={};self.states={};self.counts=collections.Counter();self.actors={};self.invalidations=[];self.revision=0
 def value(self,v):
  for f,x in v.ListFields():
   if f.name=='sindex':return self.names.get(x,'sindex:'+str(x))
   if f.name=='svalue':return {'bytesHash':hashed(x),'length':len(x)}
   if f.name in ('ivalue','fvalue','dvalue','bvalue'):return x
  return None
 def _ids(self,m):
  fields=m.DESCRIPTOR.fields_by_name
  if m.DESCRIPTOR.name=='AoiGuid':
   for field in ('leave','remove'):
    for guid in getattr(m,field):self.invalidate('observed_aoi_'+field,self.guids.get(guid),clear=False)
  if 'guid' in fields and 'id' in fields and fields['id'].type==fields['id'].TYPE_BYTES and m.id:
   actor=hashed(m.id)
   if m.guid in self.guids and self.guids[m.guid]!=actor:self.invalidate('guid_rebound',self.guids[m.guid])
   self.guids[m.guid]=actor
   if m.DESCRIPTOR.name=='AreaCreateEntityMsg':self.classes[actor]=m.name.decode('ascii',errors='replace')
  for f,v in m.ListFields():
   if f.type==f.TYPE_MESSAGE:
    for sub in (v if f.is_repeated else [v]):self._ids(sub)
 def invalidate(self,reason,actor=None,clear=True):
  self.revision+=1
  self.counts['invalidation:'+reason]+=1
  self.invalidations.append({'reason':reason,'actorHash':actor})
  self.invalidations=self.invalidations[-100:]
  if clear:
   for k in list(self.states):
    if actor is None or k[0]==actor:self.states.pop(k)
 def consume(self,msg):
  self._ids(msg);rows=[];groups=[]
  def walk(m,path,actor,initial):
   fields=m.DESCRIPTOR.fields_by_name
   if 'guid' in fields and m.HasField('guid'):actor=self.guids.get(m.guid,actor)
   initial=initial or m.DESCRIPTOR.name=='AreaCreateEntityMsg'
   if m.DESCRIPTOR.name=='PropItem':
    if m.HasField('eid') and m.eid:actor=hashed(m.eid)
    if m.path:path=[self.value(x) for x in m.path]
    if m.HasField('name'):path=path+[self.value(m.name)]
    path=[x for x in path if x is not None]
    if len(path)>=2 and path[:2] in (['buffs_data','ac_buffs'],['buffs_data','oc_buffs']):
     r={'targetActorHash':actor,'targetClass':self.classes.get(actor),'initial':initial,'path':path,'oper':m.oper,'hasValue':m.HasField('value'),'hasDict':m.HasField('dict')}
     if r['hasValue']:r['value']=self.value(m.value)
     if len(path)==2 and not initial and not r['hasDict']:
      self.invalidate('unresolved_bag_operation_'+str(m.oper),actor)
     rows.append(r)
   for f,v in m.ListFields():
    if f.type==f.TYPE_MESSAGE:
     for sub in (v if f.is_repeated else [v]):walk(sub,path,actor,initial)
  walk(msg,[],None,False)
  def key(r):
   x=r['path'][2];return (r['targetActorHash'],r['path'][1],x.get('bytesHash') if isinstance(x,dict) else str(x))
  for r in rows:
   if len(r['path'])<3:continue
   if len(r['path'])==3:groups.append({'root':r,'children':[]})
   elif groups and key(r)==key(groups[-1]['root']):groups[-1]['children'].append(r)
   else:groups.append({'root':{**r,'path':r['path'][:3],'oper':None},'children':[r]})
  out=[]
  for group in groups:
   r=group['root'];k=key(r);op=r['oper'];before=copy.deepcopy(self.states.get(k,{}));s={} if op in (11,49) else copy.deepcopy(before);changes={}
   for child in group['children']:
    suffix=child['path'][3:]
    if child['hasValue'] and len(suffix)==1 and isinstance(suffix[0],str):s[suffix[0]]=child['value'];changes[suffix[0]]=child['value']
   kind={11:'apply_candidate',12:'update',49:'snapshot',4:'remove_candidate',None:'field_patch'}.get(op,'unknown_operation')
   self.counts[kind]+=1
   if not k[0]:self.counts['unknownTarget']+=1
   if kind=='unknown_operation':self.invalidate('unknown_instance_opcode_'+str(op),k[0])
   v=before if op==4 else s
   source=v.get('fromid');source=source.get('bytesHash') if isinstance(source,dict) and source.get('length') else None
   prior=before.get('fromid');prior=prior.get('bytesHash') if isinstance(prior,dict) and prior.get('length') else None
   raw=v.get('start_ts');duration=v.get('duration');start=raw*.1+1576080000 if isinstance(raw,(int,float)) else None;seconds=duration*.1 if isinstance(duration,(int,float)) else None
   e={key:r[key] for key in ('targetActorHash','targetClass','initial')}
   e.update(kind=kind,rawOperation=op,buffInstanceHash=k[2],bag=k[1],buffNo=v.get('No'),level=v.get('level'),charge_level=v.get('charge_level'),duration=duration,durationSeconds=seconds,rawStartTimestamp=raw,startTimestampSeconds=start,nominalExpirySeconds=start+seconds if start is not None and seconds is not None and seconds>=0 else None,skill_id=v.get('skill_id'),sourceActorHash=source,sourceIdPresent=source is not None,sourceEqualsTarget=source==k[0] if source else None,sourceChanged=prior is not None and prior!=source,previousSourceActorHash=prior,completeFields=all(n in s for n in ('No','fromid','duration','start_ts')),hadKnownState=bool(before),changes=changes,attributionReady=False,appliesOnlyToSource=None,visibility='ALL_CLIENTS projection' if k[1]=='ac_buffs' else 'OWN_CLIENT projection',timingBasis='packet reception and nominal buff clock; no validated hit execution clock',semanticEvidence='Preset fields and static getters validated; lifecycle opcode labels are candidates, not authoritative ownership')
   out.append(e)
   a=self.actors.setdefault(k[0],{'actorHash':k[0],'events':0,'sourcePresentEvents':0,'acEvents':0,'ocEvents':0,'hasInitialSnapshot':False})
   a['events']+=1;a['sourcePresentEvents']+=source is not None;a['acEvents' if k[1]=='ac_buffs' else 'ocEvents']+=1;a['hasInitialSnapshot']|=kind=='snapshot'
   if op==4:self.states.pop(k,None)
   elif kind!='unknown_operation':self.states[k]=s
  if out:self.revision+=1
  return out
 def coverage(self):
  return {'schemaVersion':1,'preset':10012,'events':sum(a['events'] for a in self.actors.values()),'kinds':dict(self.counts),'actors':list(self.actors.values()),'recentInvalidations':self.invalidations,'attributionReady':False,'complete':False,'timingValidated':False,'sourceOwnershipValidated':False,'snapshotValidated':False,'privateBuffCoverageComplete':False,'aoiClosureValidated':False,'lifecycleOpcodesValidated':False,'limits':['Public visibility does not prove complete teammate private state.','Removal/clear and AOI closure semantics remain unvalidated; absence is never zero gain.','Provider changes are observations; historical stack ownership remains unknown.','Nominal expiry is not authoritative execution time; never expire for attribution by receive clock.']}
