"""Server-derived identity context; no guessed or hardcoded Chinese labels."""
import hashlib
from property_preset import get_preset
def actor_hash(value):return hashlib.sha256(value).hexdigest()[:16]
def scalar(v):
 for name in ('sindex','ivalue','fvalue','dvalue','bvalue','svalue'):
  if v.HasField(name):return getattr(v,name)
 return None
def properties(items,parent=(),preset=None):
 decode=preset.key if preset else scalar
 for item in items:
  path=tuple(decode(v) for v in item.path) if item.path else parent
  if item.HasField('name'):path+= (decode(item.name),)
  path=tuple(x for x in path if x is not None)
  if item.HasField('value'):yield path,scalar(item.value),item.oper
  if item.HasField('dict'):yield from properties(item.dict.item,path,preset)

class EncounterIdentity:
 def __init__(self):self.preset=get_preset();self.npcs={};self.spaces={};self.guid_spaces={};self.emitted={}
 def consume(self,msg):
  typ=msg.DESCRIPTOR.name
  if typ=='AreaCreateEntityMsg' and msg.name==b'Npc':
   row={'actorHash':actor_hash(msg.id),'entityClass':'Npc'}
   mapping={'No':'npcTemplateNo','custom_value_id':'customValueId','serial_id':'serialId'}
   for path,v,op in properties(msg.props.props,preset=self.preset):
    if len(path)==1 and path[0] in mapping and isinstance(v,int):row[mapping[path[0]]]=v
   self.npcs[row['actorHash']]=row
   return self.contexts()
  if typ=='AreaCreateEntityMsg' and msg.name==b'SpaceData':
   sh=actor_hash(msg.id);self.guid_spaces[msg.guid]=sh;self.spaces[sh]={'spaceHash':sh,'npcSerials':{}};items=msg.props.props
  elif typ=='AoiProp' and msg.guid in self.guid_spaces:
   sh=self.guid_spaces[msg.guid];items=msg.props
  else:return []
  state=self.spaces[sh];changed=False
  for path,v,op in properties(items,preset=self.preset):
   key={('dungeon_sid',):'dungeonSid',('dungeon','dungeon_game_id'):'dungeonGameId'}.get(path)
   if key and isinstance(v,int):state[key]=v;changed=True
   # Exact preset dictionary: 2817=dungeon, 6125=npcs.
   if len(path)==3 and path[:2]==('dungeon','npcs') and isinstance(path[2],bytes) and isinstance(v,int):
    state['npcSerials'][actor_hash(path[2])]=v;changed=True
  return self.emit([state]) if changed else []
 def context(self,state):
  return {'kind':'encounter-identity','spaceHash':state['spaceHash'],'dungeonSid':state.get('dungeonSid'),'dungeonGameId':state.get('dungeonGameId'),'npcs':[{**self.npcs[h],'dungeonSerialId':serial} for h,serial in state['npcSerials'].items() if h in self.npcs],'preset':self.preset.id,'nameSource':None}
 def emit(self,states):
  out=[]
  for state in states:
   row=self.context(state);key=state['spaceHash']
   if self.emitted.get(key)==row:continue
   self.emitted[key]=row;out.append(row)
  return out
 def contexts(self):return self.emit(s for s in self.spaces.values() if any(h in self.npcs for h in s['npcSerials']))
