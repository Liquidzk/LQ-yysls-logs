import math
import unittest
from kagerou_adapter import to_kagerou

def report():
    return {'duration':10,'key':'report-a','revision':'r1','names':{},'sessions':[{'filter_id':7}],
            'actors':[{'id':'a','kind':'player','is_observer':True},{'id':'b','kind':'player'},
                      {'id':'enemy','kind':'npc'}], 'events':[],'casts':[]}

def hit(t,source,target,amount,category='damage'):
    return {'t':t,'source':source,'target':target,'amount':amount,'category':category,'type':'behit_began'}

class KagerouTests(unittest.TestCase):
    def test_unknown_is_not_zero_and_no_false_hit_count(self):
        p=to_kagerou(report())
        self.assertIsNone(p['Combatant']['a']['damage'])
        self.assertIsNone(p['Encounter']['encdps'])
        self.assertEqual(p['Encounter']['hits'],0)
        self.assertNotIn('enemy',p['Combatant'])

    def test_self_damage_not_outgoing_and_npc_not_ranked(self):
        r=report();r['events']=[hit(1,'a','a',20),hit(2,'enemy','a',300),hit(3,'a','enemy',100),hit(3,'a','enemy',100),hit(4,'b','a',25,'heal')]
        p=to_kagerou(r);a=p['Combatant']['a'];b=p['Combatant']['b']
        self.assertEqual((a['damage'],a['swings'],a['encdps']),(200,2,20))
        self.assertEqual(a['damagetaken'],320)
        self.assertEqual((b['healed'],b['enchps']),(25,2.5))
        self.assertIsNone(b['damage'])
        self.assertEqual(p['Encounter']['damage'],200)

    def test_explicit_zero_is_preserved(self):
        r=report();r['events']=[hit(1,'a','enemy',0)]
        p=to_kagerou(r)
        self.assertEqual(p['Combatant']['a']['damage'],0)
        self.assertEqual(p['Combatant']['a']['encdps'],0)

    def test_range_and_incomplete_numbers(self):
        r=report();r['events']=[hit(2,'a','enemy',100),hit(8,'a','enemy',700),hit(3,'a','enemy',math.nan)]
        p=to_kagerou(r,1,5)
        self.assertEqual(p['Combatant']['a']['encdps'],25)
        self.assertIsNone(to_kagerou(r,2,2)['Combatant']['a']['encdps'])
        for a,b in [(0,11),(-1,10),(5,2),(0,math.nan),(True,3)]:
            with self.assertRaises(ValueError):to_kagerou(r,a,b)

    def test_actual_casts_and_external_buffs_only(self):
        r=report();r['casts']=[{'actor':'a','start':2,'kind':'cast'},{'actor':'a','start':2,'kind':'sync'}]
        r['events']=[{'t':2,'type':'add_buff','category':'buff','source':'a','target':'b'},
                     {'t':3,'type':'add_buff','category':'buff','source':'a','target':'a'}]
        p=to_kagerou(r);self.assertEqual(p['Combatant']['a']['yanyunActions'],1)
        self.assertEqual(p['Combatant']['a']['yanyunBuffs'],1)

if __name__=='__main__':unittest.main()
