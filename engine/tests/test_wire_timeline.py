import json
from pathlib import Path
import tempfile
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wire_timeline import dps_curves, buff_intervals, action_rows, action_timing, ts
from wire_store import WireStore

def at(t): return f'2026-01-01T00:00:{t:06.3f}Z'
START = ts(at(0))
def stat(t,a,b=0): return {'observedAt':at(t),'npcNo':1,'actors':[{'idHash':'a','damage':a},{'idHash':'b','damage':b}]}
def buff(t,kind='apply_candidate',instance='i',source='a',**extra):
    return dict(observedAt=at(t),kind=kind,targetActorHash='b',sourceActorHash=source,buffInstanceHash=instance,buffNo=123,bag='ac_buffs',**extra)

def action(t,kind='cast',actor='a',skill=123,identifier='one',**extra):
    return ('action',dict(observedAt=at(t),actionKind=kind,sourceActorHash=actor,rawSkillId=skill,identifierHash=identifier,**extra))

class TimelineTests(unittest.TestCase):
    def test_action_durations_and_gaps_use_matching_ends_not_hits(self):
        events=[action(1),('hit',dict(observedAt=at(1.2),sourceActorHash='a',rawSkillId=123)),
                action(2,'end'),action(4,identifier='two'),action(4.5,'end',identifier='two')]
        r=action_timing(events,START,START+6)
        self.assertEqual([x['duration'] for x in r['spans']],[1,.5])
        self.assertEqual(r['gaps'][0]['duration'],2);self.assertEqual(r['spans'][1]['gapBefore'],2)
    def test_unrelated_and_old_identifier_end_do_not_close_new_action(self):
        r=action_timing([action(0),action(1,identifier='two'),action(2,'end'),action(3,'end',identifier='two')],START,START+5)
        self.assertIsNone(r['spans'][0]['duration']);self.assertEqual(r['spans'][1]['duration'],2)
        self.assertEqual(r['gaps'],[])
    def test_visibility_breaks_gap_even_when_no_action_is_active(self):
        r=action_timing([action(0),action(1,'end'),action(2,'visibility'),action(4,identifier='two'),action(5,'end',identifier='two')],START,START+6)
        self.assertEqual(r['gaps'],[])
    def test_snapshot_and_range_clipping_do_not_claim_full_duration(self):
        for events in ([action(0,'snapshot'),action(2,'end')],[action(0),action(2,'end')]):
            r=action_timing(events,START+1,START+3)
            self.assertIsNone(r['spans'][0]['duration']);self.assertFalse(r['spans'][0]['startKnown'])
        r=action_timing([action(1)],START,START+3)
        self.assertFalse(r['spans'][0]['endKnown']);self.assertEqual(r['gaps'],[])
    def test_simultaneous_players_and_zero_duration_are_preserved(self):
        r=action_timing([action(1),action(1,actor='b'),action(1,'end'),action(2,'end',actor='b')],START,START+3)
        self.assertEqual([x['duration'] for x in r['spans']],[0,1])
    def test_unconfirmed_queue_boundary_is_not_an_idle_start(self):
        r=action_timing([action(0),action(1,'boundary',endReason='observed-aoi-leave'),action(4,identifier='two')],START,START+5)
        self.assertTrue(all(x['duration'] is None for x in r['spans']));self.assertEqual(r['gaps'],[])
    def test_same_instance_duplicate_start_preserves_original_start(self):
        r=action_timing([action(1),action(1.1),action(2,'end')],START,START+3)
        self.assertEqual(len(r['spans']),1);self.assertEqual(r['spans'][0]['duration'],1)
    def test_wrong_skill_cannot_close_an_instance_even_with_same_identifier(self):
        r=action_timing([action(1),action(2,'end',skill=999),action(3,'end')],START,START+4)
        self.assertEqual(r['spans'][0]['duration'],2)
    def test_rates_are_differences_not_cumulative_or_hit_amounts(self):
        d=dps_curves([stat(i,i*100,i*50) for i in range(11)],START,START+10,3)
        self.assertEqual(d['actors']['a'][-1],100)
        self.assertEqual(d['team'][-1],150)
        self.assertIsNone(d['team'][0])
    def test_partial_first_counter_reset_and_gaps_do_not_make_spikes(self):
        d=dps_curves([stat(1,10000),stat(2,10100),stat(3,0),stat(4,100),stat(10,99999)],START,START+10,1)
        values=dict(zip(d['times'],d['actors']['a']))
        self.assertIsNone(values[1]);self.assertEqual(values[2],100)
        self.assertIsNone(values[3]);self.assertEqual(values[4],100);self.assertIsNone(values[10])
    def test_same_timestamp_final_counter_and_roster_gaps(self):
        d=dps_curves([stat(0,0),stat(1,50),stat(1,100)],START,START+1,1)
        self.assertEqual(d['team'][-1],100)
        s=stat(1,100);s['actors']=s['actors'][:1]
        d=dps_curves([stat(0,0),s,stat(2,200,50)],START,START+2,1)
        self.assertIsNone(d['team'][-1])
    def test_overlapping_sources_are_unioned_refresh_splits_and_old_buff_carries(self):
        events=[buff(0),buff(3,instance='j',source='c'),buff(4,kind='update',charge_level=2),buff(5,kind='remove_candidate'),buff(7,kind='remove_candidate',instance='j')]
        lane=buff_intervals(events,START+2,START+10)[0]
        self.assertEqual(lane['union'],[[0,5]])
        self.assertEqual(lane['coverage'],5/8)
        self.assertEqual(len(lane['intervals']),3)
        self.assertEqual({i['source'] for i in lane['intervals']},{'a','c'})
    def test_snapshot_and_unclosed_intervals_are_uncertain_and_invalidation_cuts(self):
        rows=[buff(2,kind='snapshot'),dict(observedAt=at(4),kind='invalidation',targetActorHash='b'),buff(6)]
        lane=buff_intervals(rows,START,START+10)[0]
        self.assertEqual(lane['union'],[[2,4],[6,10]])
        self.assertTrue(lane['intervals'][0]['leftUnknown'])
        self.assertTrue(all(i['rightUnknown'] for i in lane['intervals']))
    def test_action_order_and_duplicate_time_are_not_deduplicated(self):
        d={'observedAt':at(1),'sourceActorHash':'a','rawSkillId':123,'actionKind':'cast'}
        rows=action_rows([('action',d),('hit',dict(d,amount=50)),('hit',dict(d,amount=50))],START,START+2)
        self.assertEqual([r['kind'] for r in rows],['cast','hit','hit'])
        self.assertEqual(len(rows),3)
    def test_team_curve_recovers_after_a_roster_change(self):
        snapshots=[stat(i,i*100,i*50) for i in range(6)]
        for s in snapshots[3:]:s['actors']=s['actors'][:1]
        d=dps_curves(snapshots,START,START+5,1);values=dict(zip(d['times'],d['team']))
        self.assertEqual(values[2],150);self.assertIsNone(values[3]);self.assertEqual(values[5],100)
    def test_store_full_timeline_is_independent_of_pagination_and_session_needs_battle(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);store=WireStore(base/'data',base/'captures');root=store.root/'sessions'/'s'/'capture';root.mkdir(parents=True)
            (root/'latest.json').write_text(json.dumps(stat(10,1000)))
            (root/'statistics.jsonl').write_text('\n'.join(json.dumps(stat(i,i*100)) for i in range(11))+'\n')
            (root/'damage-events.jsonl').write_text('\n'.join(json.dumps({'observedAt':at(5),'sourceActorHash':'a','rawSkillId':i}) for i in range(205))+'\n')
            (root/'buff-events.jsonl').write_text(json.dumps(buff(0))+'\n'+json.dumps(buff(8,'remove_candidate'))+'\n')
            folder=root/'battles'/'one';folder.mkdir(parents=True)
            (folder/'battle.json').write_text(json.dumps({'clock':{'startObservedAt':at(2),'endObservedAt':at(10)}}))
            self.assertTrue(store.timeline(store.key(root))['requiresBattle'])
            key=store.key(folder)
            self.assertEqual(len(store.report(key,offset=200)['events']),6)
            timeline=store.timeline(key)
            self.assertEqual(len(timeline['actions']),205)
            self.assertEqual(timeline['buffs'][0]['coverage'],.75)
            self.assertEqual(timeline['dps']['team'][-1],100)
            self.assertEqual(store.timeline(key),timeline)
            # An explicit rebuilt stream replaces old action indexing, not hits.
            (root/'action-events.jsonl').write_text(json.dumps(action(3)[1])+'\n')
            self.assertEqual(len(store.timeline(key)['actionTiming']['spans']),1)
            (root/'action-reprocessed.jsonl').write_text('\n'.join(json.dumps(a[1]) for a in [action(3),action(4,'end')])+'\n')
            rebuilt=store.timeline(key)
            self.assertEqual(len(rebuilt['actionTiming']['spans']),1)
            self.assertEqual(rebuilt['actionTiming']['spans'][0]['duration'],1)
            self.assertEqual(len(rebuilt['actions']),207)
            with self.assertRaises(ValueError):store.timeline(key,'nan')

if __name__=='__main__':unittest.main()
