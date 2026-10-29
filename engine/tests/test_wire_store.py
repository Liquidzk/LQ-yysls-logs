import json
from pathlib import Path
import tempfile
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wire_store import WireStore


class WireStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.store = WireStore(self.base / 'data', self.base / 'capture')
        self.root = self.store.root / 'sessions' / 'test' / 'capture'
        self.root.mkdir(parents=True)
        self.stat = {'schemaVersion': 1, 'source': {'sessionId': 's', 'mode': 'replay'}, 'observedAt': '2026-01-01T00:00:10Z',
                     'npcNo': 1, 'timeCostSeconds': 10, 'actors': [{'idHash': 'a', 'damage': 100, 'heal': 0}], 'sequence': 1}
        (self.root / 'latest.json').write_text(json.dumps(self.stat))
        self.append('statistics.jsonl', self.stat)
        self.key = self.store.key(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def append(self, file, row):
        with (self.root / file).open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(row) + '\n')

    def test_cumulative_totals_are_not_added_to_notification_amounts(self):
        self.append('damage-events.jsonl', {'observedAt': self.stat['observedAt'], 'sourceActorHash': 'a', 'targetActorHash': 'b', 'amount': 40})
        r = self.store.report(self.key)
        self.assertEqual(r['actors'][0]['damage'], 100)
        self.assertEqual(r['counts']['hit'], 1)
        self.assertEqual(r['events'][0]['data']['amount'], 40)

    def test_anchored_final_settlement_keeps_members_missing_from_idle_counters(self):
        clock={'startObservedAt':'2026-01-01T00:00:05Z','endObservedAt':'2026-01-01T00:00:10Z'}
        folder=self.root/'battles'/'settled';folder.mkdir(parents=True)
        (folder/'battle.json').write_text(json.dumps({'clock':clock,'statistics':dict(self.stat,encounterClock=clock)}))
        self.append('settlement-details.jsonl',{'observedAt':'2026-01-01T00:00:10.100Z','encounterContext':clock,'timeCostSeconds':5.1,
            'actors':[{'actorHash':a,'totals':{'damage':n,'heal':0,'absorb_dmg':0},'targets':[]} for a,n in [('a',100),('b',50)]]})
        report=self.store.report(self.store.key(folder))
        self.assertEqual([a['idHash'] for a in report['actors']],['a','b'])
        self.assertEqual(report['duration'],5.1)
        self.assertEqual(self.store.timeline(self.store.key(folder))['serverDuration'],5.1)

    def test_partial_line_waits_without_duplicating_prior_events(self):
        file = self.root / 'buff-events.jsonl'
        file.write_text('{"observedAt":"2026-01-01T00:00:05Z",')
        self.assertEqual(self.store.report(self.key)['counts'].get('buff', 0), 0)
        with file.open('a') as stream: stream.write('"buffNo":123}\n')
        self.assertEqual(self.store.report(self.key)['counts']['buff'], 1)
        self.assertEqual(self.store.report(self.key)['counts']['buff'], 1)

    def test_legacy_timer_closes_view_without_rewriting_original_archive(self):
        folder=self.root/'battles'/'legacy';folder.mkdir(parents=True)
        clock={'startObservedAt':'2026-01-01T00:00:05Z'}
        stat=dict(self.stat,timeCostSeconds=0,encounterClock=clock,battleTimer={
            'startObservedAt':clock['startObservedAt'],'endObservedAt':self.stat['observedAt'],
            'phase':'finalized','durationSeconds':4.8,'finalActors':self.stat['actors']})
        file=folder/'battle.json';original=json.dumps({'status':'active','clock':clock,'statistics':stat});file.write_text(original)
        self.append('damage-events.jsonl',{'observedAt':'2026-01-01T01:00:00Z','amount':999})
        result=self.store.report(self.store.key(folder))
        self.assertEqual(result['duration'],4.8);self.assertEqual(result['counts'].get('hit',0),0)
        self.assertEqual(self.store.timeline(self.store.key(folder))['duration'],5)
        self.assertEqual(next(x for x in self.store.list() if x['kind']=='battle')['status'],'ended')
        self.assertEqual(file.read_text(),original)

    def test_closed_unfinished_battle_cannot_extend_to_another_hour(self):
        self.stat['timeCostSeconds']=0
        (self.root/'statistics.jsonl').write_text(json.dumps(self.stat)+'\n')
        folder=self.root/'battles'/'unfinished';folder.mkdir(parents=True)
        clock={'startObservedAt':'2026-01-01T00:00:05Z'}
        (folder/'battle.json').write_text(json.dumps({'status':'active','clock':clock,'statistics':dict(self.stat,timeCostSeconds=0)}))
        (self.root/'completion.json').write_text('{}')
        self.append('damage-events.jsonl',{'observedAt':'2026-01-01T01:00:00Z','amount':999})
        result=self.store.report(self.store.key(folder))
        self.assertEqual(result['duration'],5);self.assertEqual(result['counts'].get('hit',0),0)
        self.assertEqual(next(x for x in self.store.list() if x['kind']=='battle')['status'],'interrupted')

    def test_battle_filters_events_and_preserves_same_time_hits(self):
        folder = self.root / 'battles' / 'one'; folder.mkdir(parents=True)
        (folder / 'battle.json').write_text(json.dumps({'clock': {'startObservedAt': '2026-01-01T00:00:05Z', 'endObservedAt': '2026-01-01T00:00:10Z'}}))
        for t in [2, 5, 5, 10, 12]:
            self.append('damage-events.jsonl', {'observedAt': f'2026-01-01T00:00:{t:02}Z', 'sourceActorHash': 'a', 'amount': 5})
        r = self.store.report(self.store.key(folder))
        self.assertEqual(r['counts']['hit'], 3)
        self.assertEqual([e['t'] for e in r['events']], [0, 0, 5])

    def test_unsupported_directory_and_unknown_keys_are_rejected(self):
        with self.assertRaises(ValueError): self.store.add_source(self.base)
        with self.assertRaises(ValueError): self.store.report('../../outside')

    def test_service_cannot_read_snapshot_outside_capture_root(self):
        outside = self.base / 'outside.json'; outside.write_text(json.dumps(self.stat))
        (self.store.root / 'service.json').write_text(json.dumps({'latestPath': str(outside)}))
        self.assertEqual(self.store.status()['latest'], {})

    def test_pagination_and_actor_filters_do_not_truncate_saved_log(self):
        for i in range(205):
            self.append('damage-events.jsonl', {'observedAt': self.stat['observedAt'], 'sourceActorHash': 'a', 'targetActorHash': 'b', 'amount': i})
        r = self.store.report(self.key, actor='a', offset=200)
        self.assertEqual(r['totalEvents'], 205); self.assertEqual(len(r['events']), 5)
        self.assertEqual(self.store.report(self.key, actor='not-present')['totalEvents'], 0)
        self.assertEqual(r['observedSkills'][0]['notificationCount'], 205)
        self.assertEqual(r['observedSkills'][0]['amount'], sum(range(205)))

    def test_live_skill_summary_without_settlement_preserves_zero_and_unknown(self):
        for skill, amount in [(123, 20), (123, 0), (123, 30), (456, None)]:
            self.append('damage-events.jsonl', {'observedAt': self.stat['observedAt'], 'sourceActorHash': 'a', 'targetActorHash': 'b', 'rawSkillId': skill, 'amount': amount})
        r = self.store.report(self.key, search='123')
        self.assertEqual(r['settlements'], [])
        self.assertEqual(r['observedSkills'][0]['amount'], 50)
        self.assertEqual(r['observedSkills'][0]['notificationCount'], 3)
        unknown = self.store.report(self.key, search='456')['observedSkills'][0]
        self.assertIsNone(unknown['amount']); self.assertEqual(unknown['measuredCount'], 0)
        self.assertEqual(r['actors'][0]['damage'], 100)

    def test_names_arriving_after_hits_resolve_to_the_same_actor_id(self):
        self.append('damage-events.jsonl', {'observedAt': self.stat['observedAt'], 'sourceActorHash': 'a', 'targetActorHash': 'b', 'rawSkillId': 123, 'amount': 5})
        (self.root / 'identities.json').write_text(json.dumps({'names': [{'idHash': 'a', 'name': '角色甲'}, {'idHash': 'b', 'name': '角色乙'}]}), encoding='utf8')
        r = self.store.report(self.key)
        self.assertEqual(r['actors'][0]['name'], '角色甲')
        self.assertEqual(r['events'][0]['data']['sourceActorName'], '角色甲')
        self.assertEqual(r['events'][0]['data']['targetActorName'], '角色乙')

    def test_unknown_clock_stays_unknown_for_whole_session(self):
        self.stat['timeCostSeconds'] = 0
        (self.root / 'statistics.jsonl').write_text(json.dumps(self.stat) + '\n')
        self.assertIsNone(self.store.report(self.key)['duration'])

    def test_import_accepts_session_directory_and_unassociated_settlement_is_safe(self):
        self.store.add_source(self.root.parent)
        self.assertIn(self.root, self.store.roots())
        folder = self.root / 'battles' / 'one'; folder.mkdir(parents=True)
        (folder / 'battle.json').write_text(json.dumps({'clock': {'startObservedAt': '2026-01-01T00:00:05Z'}}))
        self.append('settlement-details.jsonl', {'observedAt': self.stat['observedAt'], 'encounterContext': None})
        self.assertEqual(self.store.report(self.store.key(folder))['settlements'], [])

    def test_nonfinite_imported_events_are_excluded(self):
        self.append('damage-events.jsonl', {'observedAt': self.stat['observedAt'], 'amount': float('nan')})
        r = self.store.report(self.key)
        self.assertEqual(r['skippedRows'], 1)
        self.assertEqual(r['counts'].get('hit', 0), 0)

    def test_late_final_counters_need_matching_battle_anchor(self):
        folder = self.root / 'battles' / 'one'; folder.mkdir(parents=True)
        clock = {'startObservedAt': '2026-01-01T00:00:05Z', 'endObservedAt': '2026-01-01T00:00:10Z'}
        final = {**self.stat, 'observedAt': '2026-01-01T00:00:11Z', 'encounterClock': clock,
                 'actors': [{'idHash': 'a', 'damage': 150, 'heal': 0}]}
        file = folder / 'battle.json'
        file.write_text(json.dumps({'clock': clock, 'statistics': final}))
        self.assertEqual(self.store.report(self.store.key(folder))['actors'][0]['damage'], 150)
        final['encounterClock'] = {'startObservedAt': '2026-01-01T00:00:20Z'}
        file.write_text(json.dumps({'clock': clock, 'statistics': final}))
        self.assertEqual(self.store.report(self.store.key(folder))['actors'][0]['damage'], 100)


if __name__ == '__main__': unittest.main()
