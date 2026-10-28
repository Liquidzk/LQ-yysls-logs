"""Skill starts stored in ALL_CLIENTS sync_event_data queues.

Snapshots are retained as snapshots, never reported as a new cast. Only the
exact event/args fields of one queue update are emitted; no damage inference.
"""
import base64
import hashlib
from property_preset import get_preset


class ActionStream:
 def __init__(self, preset=None):
  self.preset=preset or get_preset()
 def consume(self,msg,guids):
  groups=[]
  def key(v):
   result=self.preset.key(v)
   return result.decode('utf-8',errors='replace') if isinstance(result,bytes) else result
  def walk(m,path,actor,initial):
   fields=m.DESCRIPTOR.fields_by_name
   if 'guid' in fields and m.HasField('guid'):actor=guids.get(m.guid,actor)
   initial=initial or m.DESCRIPTOR.name=='AreaCreateEntityMsg'
   if m.DESCRIPTOR.name=='PropItem':
    if m.HasField('eid') and m.eid:actor=hashlib.sha256(m.eid).hexdigest()[:16]
    if m.path:path=[key(x) for x in m.path]
    if m.HasField('name'):path=path+[key(m.name)]
    if path and path[0]=='sync_event_data' and len(path)>=2:
     identity=(actor,path[1])
     if len(path)==2:
      groups.append({'identity':identity,'initial':initial,'oper':m.oper,'fields':{}})
     elif len(path)==3 and m.HasField('value'):
      if not groups or groups[-1]['identity']!=identity:
       groups.append({'identity':identity,'initial':initial,'oper':None,'fields':{}})
      for field,value in m.value.ListFields():
       if field.name in ('ivalue','svalue'):groups[-1]['fields'][path[2]]=value
   for field,value in m.ListFields():
    if field.type==field.TYPE_MESSAGE:
     for child in (value if field.is_repeated else [value]):walk(child,path,actor,initial)
  walk(msg,[],None,False)
  out=[]
  for group in groups:
   f=group['fields'];actor=group['identity'][0]
   if actor and type(f.get('event'))==int and isinstance(f.get('args'),bytes) and f['args'] and group['oper']!=4:
    out.append({'ownerHash':actor,'syncId':f['event'],'args':base64.b64encode(f['args']).decode(),
                'initial':group['initial'] or group['oper']==49,'carrier':'sync_event_data'})
  return out
