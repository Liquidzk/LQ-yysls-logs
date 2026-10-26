"""Strict recorded descriptor validation; no state, process, or network access."""
import pathlib,sys,json,base64,struct,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'evidence/p0/runtime-rpc-analysis/pydeps'))
from google.protobuf import descriptor_pool,message_factory
pool=descriptor_pool.DescriptorPool();sources=[]
for name in ('common.proto','client_gate.proto'):
 p=ROOT/'evidence/p0/runtime-rpc-analysis'/(name+'.descriptor.bin');data=p.read_bytes();pool.AddSerializedFile(data);sources.append({'file':str(p.relative_to(ROOT)),'sha256':hashlib.sha256(data).hexdigest()})
types=[message_factory.GetMessageClass(m.input_type) for m in pool.FindServiceByName('mobile.server.lua.IGateClient').methods]
job=json.load(sys.stdin);methods=set();nonempty=0;checked=0;error=None
try:
 for encoded in job['bodies']:
  b=base64.b64decode(encoded,validate=True)
  if len(b)<2:raise ValueError('Short body')
  mi=struct.unpack_from('<H',b)[0]
  if mi>=len(types):raise ValueError('Unknown server method')
  msg=types[mi]();msg.ParseFromString(b[2:])
  if not msg.IsInitialized():raise ValueError('Required fields absent')
  nonempty+=bool(msg.ListFields());methods.add(mi);checked+=1
except Exception as e:error=type(e).__name__+': '+str(e)
valid=error is None and checked>=job.get('minRecords',6) and len(methods)>=2 and nonempty>=3
print(json.dumps({'valid':valid,'checkedRecords':checked,'distinctMethods':len(methods),'recordsWithKnownFields':nonempty,'error':error,'descriptorSources':sources,'criteria':'Every complete frame parses and initializes under recorded method schema; >=2 method types and >=3 messages with known fields'}))
