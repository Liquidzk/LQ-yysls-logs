import json
from pathlib import Path
import tempfile
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wire_store import WireStore
from stars import Stars
from display_names import apply_display_names
from wire_timeline import boss_targets, buff_intervals


class StarsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.store = WireStore(self.base / 'data', self.base / 'captures')
        self.root = self.store.root / 'sessions/current/capture'; self.root.mkdir(parents=True)
        self.write(self.store.root / 'control.json', {'binding': {'pid': 1}, 'running': True})
        self.write(self.store.root / 'service.json', {'latestPath': str(self.root / 'latest.json')})
        self.write(self.root / 'latest.json', {'battleTimer': {'phase': 'active'}})

    def write(self, file, data):
        file.parent.mkdir(parents=True, exist_ok=True); file.write_text(json.dumps(data), encoding='utf8')

    def battle(self, ident, start, end=None, root=None):
        folder = (root or self.root) / 'battles' / ident
        self.write(folder / 'battle.json', {'clock': {'startObservedAt': start, 'endObservedAt': end},
                                           'status': 'ended' if end else 'active'})
        return self.store.key(folder)

    def test_latest_is_scoped_to_current_session_and_ignores_active_attempt(self):
        key = self.battle('finished','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z')
        self.battle('active','2026-01-01T00:02:00Z')
        self.battle('foreign','2026-01-02T00:00:00Z','2026-01-02T00:01:00Z',self.store.root / 'sessions/other/capture')
        first = self.store.star_latest(); self.assertEqual(first['key'], key); self.assertTrue(first['changed'])
        again = self.store.star_latest(); self.assertFalse(again['changed']); self.assertTrue(again['starred'])
        self.assertEqual(self.store.stars.ids('capture'), {key})

    def test_pending_terminal_archive_does_not_star_older_fight(self):
        self.battle('old','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z')
        self.write(self.root / 'latest.json', {'battleTimer': {'phase':'ended','startObservedAt':'2026-01-01T00:02:00Z'}})
        with self.assertRaisesRegex(ValueError, '稍后'): self.store.star_latest()
        self.assertEqual(self.store.stars.ids('capture'), set())

    def test_unbound_and_no_completed_fight_cannot_star(self):
        self.battle('active','2026-01-01T00:02:00Z')
        with self.assertRaises(ValueError): self.store.star_latest()
        self.write(self.store.root / 'control.json', {'running':False,'binding':None})
        with self.assertRaisesRegex(ValueError, '已绑定'): self.store.star_latest()

    def test_star_persists_outside_index_and_can_be_unstarred(self):
        key = self.battle('done','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z')
        self.store.set_star(key, True)
        self.store.dbpath.unlink()  # the disposable index is independent
        rebuilt = WireStore(self.store.data, self.store.root)
        self.assertTrue(next(r for r in rebuilt.list() if r['key'] == key)['starred'])
        rebuilt.set_star(key, False); self.assertFalse(next(r for r in rebuilt.list() if r['key'] == key)['starred'])
        with self.assertRaises(ValueError): rebuilt.set_star(rebuilt.key(self.root), True)
        with self.assertRaises(ValueError): rebuilt.set_star(key, 'true')

    def test_clv2_scope_does_not_collide_with_capture(self):
        stars = Stars(self.store.data); stars.set('clv2','same',True)
        stars.set('capture','same',True); stars.set('capture','same',False)
        self.assertEqual(stars.ids('clv2'), {'same'}); self.assertEqual(stars.ids('capture'), set())


class PresentationDataTests(unittest.TestCase):
    def test_explicit_buff_alias_keeps_resource_provenance(self):
        source = {'names': {'buffs': {'98752':'增伤'}}, 'provenance': {'buffs': {'98752':{'table':'buff','name':'增伤'}}}}
        changed = apply_display_names(source)
        self.assertEqual(changed['names']['buffs']['98752'], '增伤（阴阳）')
        evidence = changed['provenance']['buffs']['98752']
        self.assertEqual(evidence['original']['name'], '增伤')
        self.assertEqual(apply_display_names(changed)['provenance']['buffs']['98752'], evidence)

    def test_boss_targets_include_both_bodies_but_never_adds_or_other_scene(self):
        catalog={'entities':{'100':{'group':'dual','role':'body'},'101':{'group':'dual','role':'soul'}}}
        clock={'spaceHash':'current','startObservedAt':'2026-01-01T00:00:00Z',
               'identityContext':{'npcs':[{'actorHash':'body','npcTemplateNo':100},{'actorHash':'add','npcTemplateNo':200}]}}
        battle={'clock':clock,'statistics':{'encounterClock':clock,'bossHealth':{'rows':[{'actorHash':'soul','npcTemplateNo':101}]}}}
        events=[{'kind':'encounter-identity','spaceHash':'old','npcs':[{'actorHash':'old','npcTemplateNo':100}]}]
        self.assertEqual([r['actorHash'] for r in boss_targets(battle,events,catalog)], ['body','soul'])
        buffs=[{'observedAt':'2026-01-01T00:00:01Z','kind':'apply_candidate','targetActorHash':'body','sourceActorHash':'player',
                'buffNo':5,'buffInstanceHash':'instance','charge_level':2},
               {'observedAt':'2026-01-01T00:00:04Z','kind':'remove_candidate','targetActorHash':'body','buffInstanceHash':'instance'}]
        from wire_timeline import ts
        lane=buff_intervals(buffs,ts('2026-01-01T00:00:00Z'),ts('2026-01-01T00:00:05Z'))[0]
        self.assertEqual(lane['coverage'],.6); self.assertEqual(lane['intervals'][0]['source'],'player')
        self.assertEqual(lane['intervals'][0]['stacks'],2)


if __name__ == '__main__': unittest.main()
