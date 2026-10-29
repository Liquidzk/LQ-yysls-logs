import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('build_names',Path(__file__).resolve().parents[2]/'tools/build-name-catalog.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class NameCatalogTests(unittest.TestCase):
    def test_exact_text_keys_main_skill_links_and_unknowns_remain_distinct(self):
        docs={'skills':{'rows':{'10':{'values':{'name':123}},'11':{'values':{'skill_main_id':10}},
                              '12':{'values':{}},'13':{'values':{'name':124}},'14':{'values':{},'unresolved_headers':[5]},
                              '15':{'values':{'skill_main_id':13}},'16':{'values':{'skill_main_id':17}},'17':{'values':{'skill_main_id':16}}}},
              'buff':{'rows':{'10':{'values':{'buff_name':123}},'11':{'values':{'buff_name':125}}}}}
        result=module.build(docs,{'123':{'text':'真实名称'},'125':{'text':'坏\ufffd文本'}},{'skills':{'10':2,'11':3,'12':1,'13':1,'0':8}})
        self.assertEqual(result['names']['skills'],{'10':'真实名称','11':'真实名称'})
        self.assertEqual(result['provenance']['skills']['11']['via'],'10')
        self.assertEqual(result['unresolved']['skills']['12']['status'],'unnamed')
        for ident in ('13','14','15','16','17'):self.assertEqual(result['unresolved']['skills'][ident]['status'],'pending')
        self.assertEqual(result['unresolved']['skills']['0']['status'],'placeholder')
        self.assertEqual(result['summary']['skills']['observed_total'],4)
        self.assertEqual(result['summary']['skills']['mapped_event_occurrences'],5)
        self.assertNotIn('11',result['names']['buffs'])

    def supplement(self):
        return {'entries':[{'kind':'buffs','table':'buff','row':'10','field':'buff_name',
                            'text_key':'123','name':'崩解','evidence':{'method':'game-ui-and-exact-resource','sources':['local-reviewed-ui']}}]}

    def test_unnamed_main_skill_chain_does_not_hide_missing_or_partial_names(self):
        docs = {'skills': {'rows': {
            '3': {'values': {'skill_main_id': 2}},
            '2': {'values': {'skill_main_id': 1}},
            '1': {'values': {'skill_main_id': 1}},
            '4': {'values': {'skill_main_id': 1, 'name': 123}},
            '5': {'values': {'skill_main_id': 1}, 'error': 'incomplete row'},
            '6': {'values': {'skill_main_id': 99}},
            '7': {'values': {'skill_main_id': 8}},
            '8': {'values': {}, 'deleted': True},
        }}}
        result = module.build(docs, {})
        for ident in ('1', '2', '3'):
            self.assertEqual(result['unresolved']['skills'][ident]['status'], 'unnamed')
        for ident in ('4', '5', '6', '7'):
            self.assertEqual(result['unresolved']['skills'][ident]['status'], 'pending')
        self.assertFalse(result['names']['skills'])

    def test_reviewed_name_requires_exact_row_and_retains_evidence(self):
        docs={'buff':{'rows':{'10':{'values':{'buff_name':123}},'11':{'values':{'buff_name':124}}}}}
        result=module.build(docs,{}, {'buffs':{'10':3,'11':1}},self.supplement())
        self.assertEqual(result['names']['buffs'],{'10':'崩解'})
        self.assertEqual(result['summary']['buffs']['mapped_event_occurrences'],3)
        self.assertNotIn('10',result['unresolved']['buffs'])
        self.assertIn('11',result['unresolved']['buffs'])
        self.assertEqual(result['provenance']['buffs']['10']['resolution'],'resource_crosscheck')

    def test_stale_or_conflicting_supplement_is_rejected(self):
        docs={'buff':{'rows':{'10':{'values':{'buff_name':123}}}}}
        with self.assertRaisesRegex(ValueError,'conflicts'):
            module.build(docs,{'123':'另一个效果'},supplements=self.supplement())
        docs['buff']['rows']['10']['values']['buff_name']=124
        with self.assertRaisesRegex(ValueError,'Stale'):
            module.build(docs,{},supplements=self.supplement())

    def test_duplicate_or_unreviewed_supplement_is_rejected(self):
        docs={'buff':{'rows':{'10':{'values':{'buff_name':123}}}}}
        supplement=self.supplement();supplement['entries']*=2
        with self.assertRaisesRegex(ValueError,'Duplicate'):
            module.build(docs,{},supplements=supplement)
        supplement=self.supplement();supplement['entries'][0].pop('evidence')
        with self.assertRaisesRegex(ValueError,'requires review evidence'):
            module.build(docs,{},supplements=supplement)

if __name__=='__main__':unittest.main()
