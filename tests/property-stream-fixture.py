"""Real descriptor messages with fixed, independently extracted current indices."""
import pathlib,sys,json,hashlib
root=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'runtime/collector/tools'))
sys.path.insert(0,str(root/'runtime/collector/evidence/p0/runtime-rpc-analysis/pydeps'))
from google.protobuf import descriptor_pool,message_factory,json_format
from p1_buff_stream import BuffStream
from p1_identity_stream import IdentityStream
from property_preset import PropertyPreset
pool=descriptor_pool.DescriptorPool()
for n in ['common.proto','client_gate.proto']:pool.AddSerializedFile((root/('runtime/collector/evidence/p0/runtime-rpc-analysis/'+n+'.descriptor.bin')).read_bytes())
from base64 import b64encode
def raw(s):return {'svalue':b64encode(s.encode()).decode()}
def idx(n):return {'sindex':n}
def prop(n,v):return {'name':idx(n),'value':v}
def message(name,body):
 m=message_factory.GetMessageClass(pool.FindMessageTypeByName('mobile.server.lua.'+name))()
 json_format.ParseDict(body,m);assert m.IsInitialized();return m
buff={'name':idx(1496),'dict':{'item':[{'name':idx(502),'dict':{'item':[{'name':raw('instance'),'oper':11,'dict':{'item':[
 prop(239,{'ivalue':12345}),prop(3672,raw('provider')),prop(2896,{'ivalue':200}),prop(8595,{'ivalue':100}),prop(1733,{'ivalue':1})
]}}]}}]}}
create=message('AreaCreateEntityMsg',{'name':b64encode(b'Avatar').decode(),'id':b64encode(b'target').decode(),'guid':'1','props':{'props':[
 {'name':idx(1094),'dict':{'item':[prop(6090,raw('真实编号测试角色'))]}},buff]}})
stream=BuffStream();names=IdentityStream().consume(create);events=stream.consume(create)
assert names[0]['name']=='真实编号测试角色'
assert events[0]['buffNo']==12345 and events[0]['sourceActorHash']==hashlib.sha256(b'provider').hexdigest()[:16]
patch=message('AoiProp',{'guid':'1','props':[{'path':[idx(1496),idx(502),raw('instance')],**prop(1733,{'ivalue':3})}]})
changed=stream.consume(patch)[0];assert changed['buffNo']==12345 and changed['charge_level']==3 and changed['hadKnownState']
remove=message('AoiProp',{'guid':'1','props':[{'path':[idx(1496),idx(502)],'name':raw('instance'),'oper':4}]})
removed=stream.consume(remove)[0];assert removed['buffNo']==12345 and removed['kind']=='remove_candidate'
# A late join may see patches before an entity snapshot. Never mix two GUIDs.
unknown=BuffStream()
for guid in [2,3]:
 unknown.consume(message('AoiProp',{'guid':str(guid),'props':[{'path':[idx(1496),idx(502),raw('same')],**prop(239,{'ivalue':100+guid})}]}))
e=unknown.consume(message('AoiProp',{'guid':'2','props':[{'path':[idx(1496),idx(502),raw('same')],**prop(1733,{'ivalue':9})}]}))[0]
assert e['buffNo']==102 and e['targetActorHash'] is None and e['targetGuid']=='2'
try:PropertyPreset('0'*64);raise AssertionError('Unknown build accepted')
except ValueError:pass
print(json.dumps({'passed':True,'preset':stream.preset.id,'checks':['name','buff-fields','patch-state','remove','unresolved-guid-isolation','unknown-build-rejected']}))
