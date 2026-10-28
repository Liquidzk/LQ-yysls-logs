import sys,struct,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
if not (ROOT/'runtime/collector/evidence/p0/runtime-rpc-analysis/common.proto.descriptor.bin').exists():
 raise unittest.SkipTest('Prepare the collector runtime descriptors before protocol tests')
sys.path[:0]=[str(ROOT/'collector/tools'),str(ROOT/'runtime/collector/evidence/p0/runtime-rpc-analysis/pydeps')]
from google.protobuf import descriptor_pool,message_factory
from property_preset import PropertyPreset
from p1_boss_health_stream import BossHealthStream,unsalt

pool=descriptor_pool.DescriptorPool()
for file in ('common.proto','client_gate.proto'):
 pool.AddSerializedFile((ROOT/'runtime/collector/evidence/p0/runtime-rpc-analysis'/(file+'.descriptor.bin')).read_bytes())
types=[message_factory.GetMessageClass(m.input_type) for m in pool.FindServiceByName('mobile.server.lua.IGateClient').methods]
preset=PropertyPreset('4483a00721a7b08a21f3cfb666eb6a8858dacf2e3830956be98c569bac746d1b')
def salted(n,salt):
 v=struct.unpack('<Q',struct.pack('<d',n))[0]^salt
 return v-(1<<64) if v>=1<<63 else v
def item(items,path,value):
 p=items.add();p.name.sindex=preset.indexes[path[-1]]
 for name in path[:-1]:p.path.add().sindex=preset.indexes[name]
 p.value.ivalue=value;return p
def create(guid=1,actor=b'boss',npc=22800004,hp=800,maximum=1000,salt=0x76543210fedcba98):
 m=types[12]();m.name=b'Npc';m.id=actor;m.guid=guid
 item(m.props.props,['No'],npc)
 for field,val in [('HP',salted(hp,salt)),('HP_MAX',salted(maximum,salt)),('salt',salt)]:item(m.props.props,['attr',field],val)
 return m
class HealthTests(unittest.TestCase):
 def test_exact_signed64_conversion(self):
  for salt in (0,12345,0xffffffffffffffff):
   for n in (0,1.01,39098936.9277):self.assertEqual(unsalt(salted(n,salt),salt),n)
  self.assertEqual(unsalt(0,123),0);self.assertIsNone(unsalt(100.0,123))
 def test_hp_max_independent_updates_healing_and_zero(self):
  s=BossHealthStream(preset);a=s.consume(create())[0];self.assertEqual((a['currentHp'],a['maxHp']),(800,1000))
  for n in (700,900,0):
   m=types[10]();m.guid=1;item(m.props,['attr','HP'],salted(n,0x76543210fedcba98))
   a=s.consume(m)[0];self.assertTrue(a['available']);self.assertEqual(a['currentHp'],n);self.assertEqual(a['maxHp'],1000)
 def test_dual_entities_do_not_share_maximum(self):
  s=BossHealthStream(preset);s.consume(create());a=s.consume(create(2,b'soul',22800007,400,2000))[0]
  self.assertEqual((a['currentHp'],a['maxHp']),(400,2000));self.assertEqual(len(s.hp),2)
 def test_unknown_leave_and_rebind(self):
  s=BossHealthStream(preset);s.consume(create());m=types[9]();m.leave.append(999)
  self.assertEqual(s.consume(m),[]);self.assertEqual(len(s.hp),1)
  out=s.consume(create(actor=b'replacement'));self.assertEqual(out[0]['reason'],'guid_rebound');self.assertEqual(len(s.hp),1)
 def test_space_entity_before_or_after_boss_does_not_clear_hp(self):
  for boss_first in (False,True):
   with self.subTest(boss_first=boss_first):
    s=BossHealthStream(preset)
    space=types[12]();space.name=b'SpaceData';space.id=b'space';space.guid=9
    for msg in ([create(),space] if boss_first else [space,create()]):s.consume(msg)
    self.assertEqual(s.consume(space),[])  # repeated entity snapshot
    m=types[10]();m.guid=1;item(m.props,['attr','HP'],salted(650,0x76543210fedcba98))
    a=s.consume(m)[0];self.assertEqual((a['currentHp'],a['maxHp']),(650,1000))
 def test_engine_space_reset_clears_old_world_and_allows_new_party_order(self):
  s=BossHealthStream(preset);s.consume(create());s.consume(create(2,b'soul',22800007,400,2000))
  m=types[14]();m.dict.SetInParent()  # complete engine space data, even empty
  out=s.consume(m);self.assertEqual(len(out),2)
  self.assertTrue(all(r['reason']=='space-data-reset' and not r['available'] for r in out))
  self.assertFalse(s.hp);self.assertFalse(s.guids);self.assertFalse(s.classes)
  # No AOI leave is sent for the previous world; its late properties cannot
  # reanimate a Boss or supply the maximum for a reused GUID.
  m=types[10]();m.guid=1;item(m.props,['attr','HP'],0);self.assertEqual(s.consume(m),[])
  s.consume(create(actor=b'new-boss',npc=92000001,hp=3000,maximum=4000))
  space=types[12]();space.name=b'SpaceData';space.id=b'new-space';space.guid=9;s.consume(space)
  m=types[10]();m.guid=1;item(m.props,['attr','HP'],salted(2500,0x76543210fedcba98))
  a=s.consume(m)[0];self.assertEqual((a['currentHp'],a['maxHp']),(2500,4000))
  self.assertEqual(len(s.hp),1)
 def test_engine_space_key_value_update_is_not_a_world_reset(self):
  s=BossHealthStream(preset);s.consume(create())
  m=types[14]();m.key.value.svalue=b'preload_entities';m.value.value.ivalue=1
  self.assertEqual(s.consume(m),[]);self.assertEqual(len(s.hp),1)
 def test_leave_does_not_turn_last_hp_into_zero_or_reuse_maximum(self):
  s=BossHealthStream(preset);s.consume(create());m=types[9]();m.leave.append(1)
  self.assertFalse(s.consume(m)[0]['available'])
  m=types[10]();m.guid=1;item(m.props,['attr','HP'],0);self.assertEqual(s.consume(m),[])
 def test_no_maximum_no_health_percentage(self):
  m=create();del m.props.props[2]
  self.assertFalse(BossHealthStream(preset).consume(m)[0]['available'])
 def test_salt_change_cannot_reinterpret_old_health(self):
  s=BossHealthStream(preset);s.consume(create())
  m=types[10]();m.guid=1;item(m.props,['attr','salt'],33)
  self.assertFalse(s.consume(m)[0]['available'])
  m=types[10]();m.guid=1;item(m.props,['attr','HP'],salted(50,33));item(m.props,['attr','HP_MAX'],salted(100,33))
  a=s.consume(m)[0];self.assertEqual((a['currentHp'],a['maxHp']),(50,100))

if __name__=='__main__':unittest.main()
