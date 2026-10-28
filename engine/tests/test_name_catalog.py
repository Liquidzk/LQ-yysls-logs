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

if __name__=='__main__':unittest.main()
