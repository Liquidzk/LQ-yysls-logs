"""Server NPC HP snapshots, independent of damage counters and qi.

Attr.HP / HP_MAX / salt are ALL_CLIENTS properties. Never estimate maximum
health from damage. See docs/boss-health-evidence.txt for native conversion.
"""
import math, struct
from p1_buff_stream import BuffStream, hashed

def unsalt(value, salt):
 if value==0:return 0.0
 if type(value) is not int or type(salt) is not int:return None
 if not -(1<<63)<=value<(1<<64) or not -(1<<63)<=salt<(1<<64):return None
 return struct.unpack('<d',struct.pack('<Q',(value^salt)&((1<<64)-1)))[0]


class BossHealthStream(BuffStream):
 def __init__(self, preset=None):
  super().__init__(preset); self.hp={}; self.pending=[]
 def _ids(self, m):
  fields=m.DESCRIPTOR.fields_by_name
  if m.DESCRIPTOR.name=='AoiGuid':
   for field in ('leave','remove'):
    for guid in getattr(m,field):
     if guid in self.guids:self.invalidate('observed_aoi_'+field,self.guids[guid])
  if 'guid' in fields and 'id' in fields and fields['id'].type==fields['id'].TYPE_BYTES and m.id:
   actor=hashed(m.id)
   if m.guid in self.guids and self.guids[m.guid]!=actor:self.invalidate('guid_rebound',self.guids[m.guid])
   self.guids[m.guid]=actor
   if m.DESCRIPTOR.name=='AreaCreateEntityMsg':self.classes[actor]=m.name.decode('ascii',errors='replace')
  for f,v in m.ListFields():
   if f.type==f.TYPE_MESSAGE:
    for sub in (v if f.is_repeated else [v]):self._ids(sub)
 def invalidate(self, reason, actor=None, clear=True):
  super().invalidate(reason, actor, clear)
  for key in list(self.hp):
   if actor is None or actor==key:
    old=self.hp.pop(key)
    self.pending.append({'kind':'npc-health', 'actorHash':key, 'npcTemplateNo':old.get('npcTemplateNo'),
                         'available':False, 'reason':reason})
 def consume(self, msg):
  self.pending=[]; self._ids(msg); changed=set(); patches={}
  def walk(m, path=(), actor=None, initial=False):
   fields=m.DESCRIPTOR.fields_by_name
   if 'guid' in fields and m.HasField('guid'):actor=self.guids.get(m.guid,actor)
   if m.DESCRIPTOR.name=='AreaCreateEntityMsg':
    initial=True
    if self.classes.get(actor)=='Npc':
     self.hp[actor]={'salt':0};changed.add(actor)
    elif m.name==b'SpaceData':
     self.invalidate('space-snapshot')
    elif actor in self.hp:self.invalidate('entity-class-changed',actor)
   if m.DESCRIPTOR.name=='PropItem':
    if m.HasField('eid') and m.eid:actor=hashed(m.eid)
    if m.path:path=tuple(self.preset.key(x) for x in m.path)
    if m.HasField('name'):path+= (self.preset.key(m.name),)
    if actor in self.hp:
     key={('No',):'npcTemplateNo',('attr','HP'):'currentHp',('attr','HP_MAX'):'maxHp',('attr','salt'):'salt'}.get(path)
     if key:
      value=self.value(m.value) if m.HasField('value') and m.oper!=4 else None
      patches.setdefault(actor,{})[key]=value;changed.add(actor)
     elif path==('attr',) and not initial:
      # A replaced/removed attr container must not retain the old maximum.
      self.hp[actor]={k:v for k,v in self.hp[actor].items() if k=='npcTemplateNo'}
      changed.add(actor)
   for f,v in m.ListFields():
    if f.type==f.TYPE_MESSAGE:
     for sub in (v if f.is_repeated else [v]):walk(sub,path,actor,initial)
  walk(msg)
  for actor,patch in patches.items():
   if actor not in self.hp:continue
   row=self.hp[actor]
   if 'salt' in patch and patch['salt']!=row.get('salt'):
    # Different salt cannot decode a previous snapshot's HP bits. Apply a
    # message's fields together, independent of their protobuf order.
    for key in ('currentHp','maxHp'):
     if key not in patch:row.pop(key,None)
   row.update(patch)
  out=list(self.pending)
  for actor in sorted(changed):
   if actor not in self.hp:continue
   row=self.hp[actor]
   validated=self.preset.id=='cn-win64r-20261023'
   cur=unsalt(row.get('currentHp'),row.get('salt')) if validated else None
   maximum=unsalt(row.get('maxHp'),row.get('salt')) if validated else None
   valid=lambda n:isinstance(n,(int,float)) and not isinstance(n,bool) and math.isfinite(n)
   available=valid(cur) and cur>=0 and valid(maximum) and maximum>0
   out.append({'kind':'npc-health','actorHash':actor,'npcTemplateNo':row.get('npcTemplateNo'),
    'currentHp':cur if available else None,'maxHp':maximum if available else None,
    'available':available,'reason':None if available else 'unsupported-health-build' if not validated else 'incomplete-health-snapshot',
    'propertyPreset':self.preset.id})
  return out
