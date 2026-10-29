"""Real descriptor messages with fixed, independently extracted current indices."""
import pathlib,sys,json,hashlib
root=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'collector/tools'))
sys.path.insert(0,str(root/'runtime/collector/evidence/p0/runtime-rpc-analysis/pydeps'))
from google.protobuf import descriptor_pool,message_factory,json_format
from p1_buff_stream import BuffStream
from p1_identity_stream import IdentityStream
from property_preset import PropertyPreset
from p1_encounter_schema import EncounterSchema
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
# Binding after login must not require a prior GUID snapshot when eid is explicit.
identities=IdentityStream()
own={'eid':b64encode(b'own-player').decode(),'path':[idx(1094)],**prop(6090,raw('本机角色'))}
late=identities.consume(message('AoiProp',{'guid':'99','props':[own]}))
assert late[0]['idHash']==hashlib.sha256(b'own-player').hexdigest()[:16]
assert late[0]['identityEvidence']['actorIdBasis']=='property.eid'
# An eid applies only to its subtree, never an unrelated sibling or unknown GUID.
assert identities.consume(message('AoiProp',{'guid':'99','props':[{'path':[idx(1094)],**prop(6090,raw('不能猜测'))}]}))==[]
named=lambda n:idx(identities.preset.indexes[n])
team=message('AoiProp',{'guid':'99','props':[{'path':[named('team'),named('players_base'),raw('member-id')],**prop(6090,raw('队伍成员'))}]})
member=identities.consume(team)[0]
assert member['idHash']==hashlib.sha256(b'member-id').hexdigest()[:16]
assert member['nameSource']=='wire.team.players_base.nickname'
social=message('AoiProp',{'guid':'99','props':[{'path':[raw('social'),named('players_base'),raw('member-id')],**prop(6090,raw('不能错配'))}]})
assert identities.consume(social)==[]
assert identities.consume(team)==[]
npc=message('AreaCreateEntityMsg',{'name':b64encode(b'Npc').decode(),'id':b64encode(b'npc').decode(),'guid':'100','props':{'props':[{'name':idx(1094),'dict':{'item':[prop(6090,raw('非玩家'))]}}]}})
assert identities.consume(npc)==[]
assert identities.consume(message('AoiProp',{'guid':'100','props':[{'path':[idx(1094)],**prop(6090,raw('非玩家更新'))}]}))==[]
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
# Victory uses the independently extracted current SpaceData property indices.
encounter=EncounterSchema()
space=lambda ident,guid,finished:message('AreaCreateEntityMsg',{'name':b64encode(b'SpaceData').decode(),'id':b64encode(ident).decode(),'guid':str(guid),'props':{'props':[
 {'name':idx(2873),'dict':{'item':[prop(2880,{'bvalue':finished}),prop(4745,{'bvalue':False})]}}
]}})
initial=encounter.consume(space(b'combat-space',20,False))
assert any(e['kind']=='dungeon-finish-state' and not e['finished'] and e['initial'] for e in initial)
finish={'path':[idx(2873)],**prop(2880,{'ivalue':1})}
win=encounter.consume(message('AoiProp',{'guid':'20','props':[finish]}))
assert len(win)==1 and win[0]['kind']=='dungeon-finish-state' and win[0]['finished']
assert win[0]['previousFinished'] is False and not win[0]['initial']
assert win[0]['spaceHash']==hashlib.sha256(b'combat-space').hexdigest()[:16]
assert encounter.consume(message('AoiProp',{'guid':'20','props':[finish]}))==[]
assert encounter.consume(message('AoiProp',{'guid':'999','props':[finish]}))==[]
assert encounter.consume(message('AoiProp',{'guid':'20','props':[{**finish,'eid':b64encode(b'other-space').decode()}]}))==[]
assert encounter.consume(message('AoiProp',{'guid':'20','props':[{'path':[idx(2873)],**prop(2880,{'ivalue':9})}]}))==[]
loaded=encounter.consume(space(b'completed-scene',21,True))
assert any(e['kind']=='dungeon-finish-state' and e['finished'] and e['initial'] for e in loaded)
# Recreating an unrelated NPC must not emit every historical dungeon roster.
from p1_encounter_identity import EncounterIdentity
identity=EncounterIdentity();named=lambda key:idx(identity.preset.indexes[key])
roster=message('AreaCreateEntityMsg',{'name':b64encode(b'SpaceData').decode(),'id':b64encode(b'roster-space').decode(),'guid':'30','props':{'props':[
 {'name':named('dungeon'),'dict':{'item':[{'name':named('npcs'),'dict':{'item':[{'name':raw('boss'),'value':{'ivalue':1}}]}}]}}
]}})
identity.consume(roster)
boss=lambda number:message('AreaCreateEntityMsg',{'name':b64encode(b'Npc').decode(),'id':b64encode(b'boss').decode(),'guid':'31','props':{'props':[{'name':named('No'),'value':{'ivalue':number}}]}})
assert len(identity.consume(boss(123)))==1
assert identity.consume(boss(123))==[]
assert identity.consume(npc)==[]
assert len(identity.consume(boss(124)))==1
print(json.dumps({'passed':True,'preset':stream.preset.id,'checks':['name','explicit-eid','team-names','identity-isolation','buff-fields','patch-state','remove','unresolved-guid-isolation','unknown-build-rejected']}))
