import unittest
import test_combat  # Shares the application import path used by the other tests.
from combat import buff_intervals,cast_intervals
from skill_review import review_cast,current_name_coverage


def event(t,type_,actor='a',**values):
    category=('buff' if type_ in ('add_buff','remove_buff','buff_level_change') else
              'damage' if type_=='damage' else 'heal' if type_=='heal' else 'skill')
    return {'t':t,'type':type_,'actor':actor,'category':category,**values}


def report(events,duration=2):
    events=sorted(events,key=lambda e:e['t'])
    for i,e in enumerate(events):e['id']=i
    return {'events':events,'casts':cast_intervals(events,duration),
            'buff_intervals':buff_intervals(events,duration),'revision':'test-revision',
            'actors':[{'id':'a','kind':'player'},{'id':'b','kind':'player'}],
            'sessions':[{'filter_id':140001}],'duration':duration}


def start(t,skill=100,actor='a'):return event(t,'skill_state_change',actor,skill=skill,state='SKILL_START')
def leave(t,skill=100,actor='a'):return event(t,'skill_state_change',actor,skill=skill,state='SKILL_LEAVE')


class SkillReviewTests(unittest.TestCase):
    def test_unrelated_or_missing_skill_break_does_not_mark_current_cast(self):
        r=report([start(0),event(.2,'skill_brk',skill=200),event(.3,'skill_brk',skill=None),leave(.5)])
        self.assertFalse(r['casts'][0]['interrupted'])
        r=report([start(0),event(.2,'skill_brk',skill=100),leave(.5)])
        self.assertTrue(r['casts'][0]['interrupted']);self.assertEqual(r['casts'][0]['interrupt_events'],[1])

    def test_same_timestamp_stack_order_sources_and_remove_only(self):
        r=report([event(.1,'add_buff',source='b',target='a',buff=900,stacks=1),start(.1),
            event(.1,'buff_level_change',source='b',target='a',buff=900,stacks=5),
            event(.2,'add_buff',source='a',target='a',buff=900,stacks=2),
            event(.4,'remove_buff',source='b',target='a',buff=999),
            event(.6,'remove_buff',source='b',target='a',buff=900),
            event(1,'remove_buff',source='a',target='a',buff=900),leave(1.1)])
        d=review_cast(r,r['casts'][0]['id']);self.assertEqual(len(d['buffs']),2)
        external=next(b for b in d['buffs'] if b['external']);own=next(b for b in d['buffs'] if not b['external'])
        self.assertEqual(external['stacks_at_start'],1);self.assertTrue(external['active_at_start'])
        self.assertAlmostEqual(external['coverage'],.5);self.assertFalse(own['active_at_start'])
        self.assertEqual(d['cast']['external_buffs_at_start'],1)

    def test_hit_filter_keeps_multi_hits_and_does_not_mix_skill_source_or_self_damage(self):
        r=report([start(0),event(.2,'damage',source='a',target='boss',skill=100,amount=30),
            event(.2,'damage',source='a',target='boss',skill=100,amount=30),
            event(.3,'damage',source='a',target='a',skill=100,amount=400),
            event(.3,'damage',source='b',target='boss',skill=100,amount=500),
            event(.3,'damage',source='a',target='boss',skill=101,amount=600),
            event(.4,'heal',source='a',target='a',skill=100,amount=20),leave(1),
            event(1,'damage',source='a',target='boss',skill=100,amount=800)])
        d=review_cast(r,r['casts'][0]['id'])
        self.assertEqual(d['damage'],{'amount':60,'records':2,'per_second':60})
        self.assertEqual(d['heal']['amount'],20);self.assertEqual(len(d['matching_events']),3)

    def test_missing_damage_is_unknown_and_uncertain_end_has_no_rate(self):
        r=report([start(0),start(1,200),leave(2,200)])
        d=review_cast(r,r['casts'][0]['id']);self.assertIsNone(d['damage']['amount'])
        self.assertFalse(d['cast']['end_known'])
        r=report([start(0),event(.5,'damage',source='a',target='boss',skill=100,amount=10),start(1,200)])
        d=review_cast(r,r['casts'][0]['id']);self.assertEqual(d['damage']['amount'],10)
        self.assertIsNone(d['damage']['per_second'])

    def test_sync_does_not_become_cast_and_peers_use_event_order(self):
        r=report([start(0,200,'b'),start(.1),event(.2,'apply_skill','a',skill=100),leave(.5),leave(1,200,'b')])
        own=next(c for c in r['casts'] if c['actor']=='a' and c['kind']=='cast')
        d=review_cast(r,own['id']);self.assertEqual(len(d['peers']),1)
        sync=next(c for c in r['casts'] if c['kind']=='sync')
        self.assertIsNone(review_cast(r,sync['id'])['damage']['amount'])
        r=report([start(0,200,'b'),leave(.1,200,'b'),start(.1),leave(.5)])
        d=review_cast(r,r['casts'][1]['id']);self.assertEqual(d['peers'],[])

    def test_removed_and_readded_buff_at_same_time_uses_event_order(self):
        r=report([event(0,'add_buff',source='b',target='a',buff=900,stacks=1),
            event(.1,'remove_buff',source='b',target='a',buff=900),start(.1),
            event(.1,'add_buff',source='b',target='a',buff=900,stacks=3),leave(1)])
        d=review_cast(r,r['casts'][0]['id']);self.assertEqual(d['cast']['buffs_at_start'],0)
        self.assertFalse(d['buffs'][0]['active_at_start']);self.assertIsNone(d['buffs'][0]['stacks_at_start'])

    def test_current_name_coverage_includes_new_ids_and_manual_names(self):
        r=report([start(0,100),start(.1,101),start(.2,-1),event(.3,'add_buff',source='b',target='a',buff=900)])
        names={'skills':{'100':'已命名'},'scenes':{'140001':'已命名场景'}}
        summary,missing=current_name_coverage(r,names,{'skills':{'101':{'status':'unnamed'}}})
        self.assertEqual(summary['skills']['observed_mapped'],1)
        self.assertEqual(summary['skills']['observed_unnamed'],1)
        self.assertEqual(summary['skills']['observed_placeholders'],1)
        self.assertEqual(missing['buffs']['900']['status'],'pending')
        names['skills']['101']='手动名称'
        self.assertEqual(current_name_coverage(r,names,missing)[0]['skills']['observed_mapped'],2)


if __name__=='__main__':unittest.main()
