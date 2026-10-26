"""Target qi state for conditional buffs only; never per-player qi output."""
import math
from p1_buff_stream import BuffStream, hashed

class TargetResourceStream(BuffStream):
 def __init__(self):
  super().__init__(); self.positive=set()
 def invalidate(self,reason,actor=None,clear=True):
  super().invalidate(reason,actor,clear)
  if actor is None:self.positive.clear()
  else:self.positive.discard(actor)
 def key(self,v):
  if v.HasField('svalue') and v.svalue==b'2':return '2'
  return super().key(v)
 def consume(self,msg):
  old=set(self.positive); self._ids(msg);out=[]
  for actor in old-self.positive:out.append({'targetActorHash':actor,'kind':'target-qi-state','weak':None,'reason':'identity-invalidated'})
  initial=msg.DESCRIPTOR.name=='AreaCreateEntityMsg'
  def walk(m,path,actor=None):
   fields=m.DESCRIPTOR.fields_by_name
   if 'guid' in fields and m.HasField('guid'):actor=self.guids.get(m.guid,actor)
   if m.DESCRIPTOR.name=='PropItem':
    if m.HasField('eid') and m.eid:actor=hashed(m.eid)
    if m.path:path=[self.key(x) for x in m.path]
    if m.HasField('name'):path=path+[self.key(m.name)]
    if len(path)==3 and path[:2]==['attr','dynamic_attr'] and path[2] in ('2',2) and m.HasField('value') and self.classes.get(actor)=='Npc':
     val=self.value(m.value)
     if initial:self.positive.discard(actor)
     if isinstance(val,(float,int)) and not isinstance(val,bool) and math.isfinite(val) and val>=0:
      if val>0:self.positive.add(actor)
      weak=False if val>0 else True if actor in self.positive else None
      out.append({'kind':'target-qi-state','targetActorHash':actor,'currentQi':val,'weak':weak,'initial':initial,'operation':m.oper,'basis':'received resource2 state; prior positive value establishes nonzero capacity; no attacker output inferred'})
   for f,v in m.ListFields():
    if f.type==f.TYPE_MESSAGE:
     for sub in (v if f.is_repeated else [v]):walk(sub,path,actor)
  walk(msg,[])
  return out
