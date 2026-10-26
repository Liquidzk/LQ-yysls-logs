"""Passive schema projection using the selected client's property preset.

Evidence: encounter-retest/index-names.json; static local-dungeon main/36;
party-retest record 2248/3115/14476. Timings remain packet receive times.
"""
import hashlib
from p1_encounter_identity import EncounterIdentity

class EncounterSchema:
 def __init__(self):
  self.spaces={}
  self.states={}
  self.identity=EncounterIdentity()
  self.preset=self.identity.preset

 def consume(self,msg):
  identity_events=self.identity.consume(msg)
  typ=msg.DESCRIPTOR.name
  initial=typ=='AreaCreateEntityMsg'
  if initial:
   if msg.name!=b'SpaceData':return identity_events
   space_hash=hashlib.sha256(msg.id).hexdigest()[:16]
   self.spaces[msg.guid]={'hash':space_hash,'id':bytes(msg.id)}
   props=msg.props.props
   guid=msg.guid
  elif typ=='AoiProp' and msg.guid in self.spaces:
   guid=msg.guid;props=msg.props;space_hash=self.spaces[guid]['hash']
  else:return identity_events
  out=list(identity_events)
  def key(v):
   return self.preset.key(v)
  def walk(item,parent):
   if item.HasField('eid') and bytes(item.eid)!=self.spaces[guid]['id']:return
   path=[key(x) for x in item.path] if item.path else list(parent)
   if item.HasField('name'):path.append(key(item.name))
   path=[x for x in path if x is not None]
   if path==['dungeon','is_in_boss_battle'] and item.HasField('value'):
    val=item.value
    active=bool(val.bvalue) if val.HasField('bvalue') else bool(val.ivalue) if val.HasField('ivalue') and val.ivalue in (0,1) else None
    if active is not None:
     prev=self.states.get(space_hash)
     if initial or prev is None or active!=prev:
      context=self.identity.context(self.identity.spaces[space_hash])
      out.append({'kind':'boss-battle-state','active':active,'initial':initial,'previousActive':prev,'stateChanged':prev is not None and active!=prev,'spaceHash':space_hash,'identityContext':context,'propertyPath':['dungeon','is_in_boss_battle'],'propertyIndexes':[self.preset.indexes[n] for n in ('dungeon','is_in_boss_battle')],'preset':self.preset.id,'timingBasis':'server_state_received; packet reception, not a server event timestamp'})
     self.states[space_hash]=active
   if item.HasField('dict'):
    for sub in item.dict.item:walk(sub,path)
  for item in props:walk(item,[])
  return out
