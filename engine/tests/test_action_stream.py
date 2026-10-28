import hashlib, unittest
from test_boss_health import types, preset
from p1_action_stream import ActionStream

ACTOR=hashlib.sha256(b'player').hexdigest()[:16]
SKILL=int.from_bytes(hashlib.md5(b'Skillsync').digest()[-4:],'big')&0x7fffffff

def queue(op=11,args=b'first'):
    m=types[10]();m.guid=1
    p=m.props.add();p.name.svalue=b'skill';p.path.add().sindex=preset.indexes['sync_event_data'];p.oper=op
    if op!=4:
        x=p.dict.item.add();x.name.sindex=preset.indexes['event'];x.value.ivalue=SKILL
        x=p.dict.item.add();x.name.sindex=preset.indexes['args'];x.value.svalue=args
    return m

class ActionStreamTests(unittest.TestCase):
    def test_removal_retains_exact_start_identity_and_ignores_duplicate_remove(self):
        s=ActionStream(preset);first=s.consume(queue(),{1:ACTOR})[0]
        end=s.consume(queue(4),{1:ACTOR})[0]
        self.assertEqual(end['operation'],'remove');self.assertEqual(end['args'],first['args'])
        self.assertEqual(end['ownerHash'],ACTOR);self.assertEqual(end['queue'],'skill')
        self.assertEqual(s.consume(queue(4),{1:ACTOR}),[])
    def test_replacement_has_unknown_boundary_then_new_start(self):
        s=ActionStream(preset);s.consume(queue(),{1:ACTOR})
        rows=s.consume(queue(args=b'second'),{1:ACTOR})
        self.assertEqual(rows[0]['operation'],'boundary');self.assertEqual(rows[0]['boundaryReason'],'queue-replaced')
        self.assertNotEqual(rows[0]['args'],rows[1]['args'])
    def test_snapshot_not_new_cast_and_space_reset_not_confirmed_end(self):
        s=ActionStream(preset);self.assertTrue(s.consume(queue(49),{1:ACTOR})[0]['initial'])
        m=types[14]();m.dict.SetInParent();rows=s.consume(m,{1:ACTOR})
        self.assertEqual([r['operation'] for r in rows],['boundary','visibility'])
        self.assertEqual(s.consume(queue(4),{1:ACTOR}),[])
    def test_aoi_loss_prevents_late_removal_closing_a_previous_cast(self):
        s=ActionStream(preset);s.consume(queue(),{1:ACTOR})
        m=types[9]();m.leave.append(1);rows=s.consume(m,{1:ACTOR})
        self.assertEqual(rows[0]['operation'],'boundary')
        self.assertEqual(s.consume(queue(4),{1:ACTOR}),[])
    def test_unknown_aoi_leave_does_not_close_everyone(self):
        s=ActionStream(preset);s.consume(queue(),{1:ACTOR})
        m=types[9]();m.leave.append(999);self.assertEqual(s.consume(m,{1:ACTOR}),[])
        self.assertEqual(s.consume(queue(4),{1:ACTOR})[0]['operation'],'remove')

if __name__=='__main__':unittest.main()
