"""Server Avatar ID -> base.nickname only; never pet or social display names."""
from p1_encounter_identity import properties, actor_hash, scalar

class IdentityStream:
 def __init__(self): self.guids={}; self.names={}
 def consume(self,msg):
  typ=msg.DESCRIPTOR.name
  if typ=='SpaceData':return self.combat_names(msg)
  if typ=='AreaCreateEntityMsg':
   self.guids.pop(msg.guid,None)
   if msg.name!=b'Avatar':return []
   actor=actor_hash(msg.id);self.guids[msg.guid]=actor;items=msg.props.props
  elif typ=='AoiProp' and msg.guid in self.guids:
   actor=self.guids[msg.guid];items=msg.props
  elif typ=='AoiGuid':
   for guid in list(msg.leave)+list(msg.remove):self.guids.pop(guid,None)
   return []
  else:return []
  out=[]
  for path,value,op in properties(items):
   if path!=(1070,5982) or not isinstance(value,bytes):continue
   try:name=value.decode('utf8')
   except UnicodeDecodeError:continue
   if not name.strip() or len(value)>256 or any(ord(x)<32 or ord(x)==127 for x in name):continue
   if self.names.get(actor)==name:continue
   self.names[actor]=name
   out.append({'idHash':actor,'name':name,'nameSource':'wire.avatar.base.nickname','identityEvidence':{'preset':10012,'propertyIndexes':[1070,5982],'entityClass':'Avatar','message':typ}})
  return out
 def combat_names(self,msg):
  out=[]
  def walk(m,path=()):
   if m.DESCRIPTOR.name=='PropItem':
    if m.path:path=tuple(scalar(v) for v in m.path)
    if m.HasField('name'):path+=(scalar(m.name),)
    if len(path)==5 and path[0]==b'combat_stat' and path[2] in (b'combat_stat_detail',b'own_skill_detail') and isinstance(path[3],bytes) and path[4]==5889 and m.HasField('value'):
     value=scalar(m.value)
     if isinstance(value,bytes):
      try:name=value.decode('utf8')
      except UnicodeDecodeError:name=''
      actor=actor_hash(path[3])
      if name.strip() and len(value)<=256 and not any(ord(x)<32 or ord(x)==127 for x in name) and self.names.get(actor)!=name:
       self.names[actor]=name
       out.append({'idHash':actor,'name':name,'nameSource':'wire.combat_stat_detail.name','identityEvidence':{'preset':10012,'path':'combat_stat.*.'+path[2].decode()+'.[actorId].name','actorIdFromDictionaryKey':True}})
   for f,v in m.ListFields():
    if f.type==f.TYPE_MESSAGE:
     for x in (v if f.is_repeated else [v]):walk(x,path)
  walk(msg)
  return out
