"""Names tied to explicit server entity IDs; never infer identity from ranking."""
from p1_encounter_identity import actor_hash, scalar
from property_preset import get_preset

class IdentityStream:
 def __init__(self):
  self.guids={};self.classes={};self.names={};self.preset=get_preset()
 def consume(self,msg):
  typ=msg.DESCRIPTOR.name
  if typ=='AoiGuid':
   for guid in list(msg.leave)+list(msg.remove):self.guids.pop(guid,None)
   return []
  if typ=='AreaCreateEntityMsg':
   self.guids.pop(msg.guid,None)
   if msg.id:
    actor=actor_hash(msg.id);self.guids[msg.guid]=actor;self.classes[actor]=msg.name
  out=[]

  def remember(raw_id,value,source,evidence):
   if not raw_id or not isinstance(value,bytes):return
   try:name=value.decode('utf8')
   except UnicodeDecodeError:return
   if not name.strip() or len(value)>256 or any(ord(x)<32 or ord(x)==127 for x in name):return
   actor=raw_id if isinstance(raw_id,str) else actor_hash(raw_id)
   if self.names.get(actor)==name:return
   self.names[actor]=name
   out.append({'idHash':actor,'name':name,'nameSource':source,
    'identityEvidence':{'preset':self.preset.id,'message':typ,**evidence}})

  def walk(m,path=(),actor=None,explicit_eid=False,depth=0):
   if depth>30:raise ValueError('Identity property nesting exceeds limit')
   fields=m.DESCRIPTOR.fields_by_name
   if 'guid' in fields and m.HasField('guid'):actor=self.guids.get(m.guid)
   if m.DESCRIPTOR.name=='PropItem':
    if m.eid:actor=actor_hash(m.eid);explicit_eid=True
    if m.path:path=tuple(self.preset.key(v) for v in m.path)
    if m.HasField('name'):path+=(self.preset.key(m.name),)
    if m.HasField('value'):
     value=scalar(m.value)
     # Own-client updates carry eid even when binding missed the AOI snapshot.
     if path==('base','nickname') and actor and self.classes.get(actor,b'Avatar')==b'Avatar':
      remember(actor,value,'wire.avatar.base.nickname',{
       'propertyIndexes':[self.preset.indexes[n] for n in ('base','nickname')],
       'actorIdBasis':'property.eid' if explicit_eid else 'avatar.guid'})
     # TeamProp.players_base is keyed by pid (avatar/team.lua).
     if len(path)==4 and path[:2]==('team','players_base') and isinstance(path[2],bytes) and path[3]=='nickname':
      remember(path[2],value,'wire.team.players_base.nickname',{
       'path':'team.players_base.[actorId].nickname','actorIdFromDictionaryKey':True})
     if (len(path)==5 and path[0]=='combat_stat' and
         path[2] in ('combat_stat_detail','own_skill_detail','own_combat_stat_detail',
                     'last_combat_stat_detail','total_combat_stat_detail') and
         isinstance(path[3],bytes) and path[4]=='name'):
      remember(path[3],value,'wire.combat_stat_detail.name',{
       'path':'combat_stat.*.'+path[2]+'.[actorId].name','actorIdFromDictionaryKey':True})
   for f,v in m.ListFields():
    if f.type==f.TYPE_MESSAGE:
     for child in (v if f.is_repeated else [v]):walk(child,path,actor,explicit_eid,depth+1)
  walk(msg)
  return out
