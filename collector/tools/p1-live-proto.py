"""Persistent, offline-only schema gate. No networking or process access."""
import sys,pathlib,json,base64,struct,hashlib
from p1_encounter_schema import EncounterSchema
from p1_buff_stream import BuffStream
from p1_target_resource_stream import TargetResourceStream
from p1_identity_stream import IdentityStream
identity_stream=IdentityStream()
encounter_schema=EncounterSchema()
buff_stream=BuffStream()
target_resource_stream=TargetResourceStream()
root=pathlib.Path(__file__).resolve().parents[1]/'evidence/p0/runtime-rpc-analysis'
sys.path.insert(0,str(root/'pydeps'))
from google.protobuf import descriptor_pool,message_factory
pool=descriptor_pool.DescriptorPool()
for name in ('common.proto','client_gate.proto'):pool.AddSerializedFile((root/(name+'.descriptor.bin')).read_bytes())
service=pool.FindServiceByName('mobile.server.lua.IGateClient')
types=[message_factory.GetMessageClass(m.input_type) for m in service.methods]
def walk(msg,out,events,identities,path,depth=0):
 if depth>30:raise ValueError('Message nesting exceeds limit')
 if msg.DESCRIPTOR.name=='AreaMessage' and msg.method.index==0x2e77db68:
  out.append(base64.b64encode(msg.smsgpack).decode())
 if msg.DESCRIPTOR.name=='AreaMessage' and msg.method.index in (1164740750,1000155338):
  events.append({'methodIndex':msg.method.index,'targetActorHash':hashlib.sha256(msg.id).hexdigest()[:16] if msg.id else None,'path':path,'data':base64.b64encode(msg.smsgpack).decode()})
 if msg.DESCRIPTOR.name=='AreaMessage' and msg.method.index==1376711304:
  identities.append({'methodIndex':msg.method.index,'path':path,'data':base64.b64encode(msg.smsgpack).decode()})
 for f,v in msg.ListFields():
  if f.type==f.TYPE_MESSAGE:
   if f.is_repeated:
    for index,item in enumerate(v):walk(item,out,events,identities,path+'.'+f.name+'['+str(index)+']',depth+1)
   else:walk(v,out,events,identities,path+'.'+f.name,depth+1)
print(json.dumps({'ready':True,'methods':len(types)}),flush=True)
for line in sys.stdin:
 try:
  job=json.loads(line);b=base64.b64decode(job['body'],validate=True);mi=struct.unpack_from('<H',b)[0]
  if not 0<=mi<len(types):raise ValueError('Server method index outside recorded schema')
  msg=types[mi]();msg.ParseFromString(b[2:])
  if not msg.IsInitialized():raise ValueError('Missing required protobuf fields')
  out=[];events=[];identities=[];walk(msg,out,events,identities,msg.DESCRIPTOR.name)
  encounter_events=encounter_schema.consume(msg)
  encounter_events.extend(target_resource_stream.consume(msg))
  buff_revision=buff_stream.revision
  buff_events=buff_stream.consume(msg)
  print(json.dumps({'id':job['id'],'ok':True,'statistics':out,'events':events,'identities':identities,'identityRows':identity_stream.consume(msg),'encounterEvents':encounter_events,'buffEvents':buff_events,'buffCoverage':buff_stream.coverage() if job['id']%100==0 else None}),flush=True)
 except Exception as e:print(json.dumps({'id':job.get('id') if 'job' in locals() else None,'ok':False,'error':type(e).__name__+': '+str(e)}),flush=True)
