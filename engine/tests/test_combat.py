import base64
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
import zlib

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from combat import KEY,EVENT_NAMES,normalize,merge_sessions,read_log,fields,actor_id,msgpack
from server import Library

CODES={v:k for k,v in EVENT_NAMES.items()}


def frame(block):
    compressed=zlib.compress(msgpack.packb(block,use_bin_type=False))
    encoded=base64.b64encode(bytes(v^KEY[i%len(KEY)] for i,v in enumerate(compressed)))
    return len(encoded).to_bytes(4,'big')+encoded


def fixture(who='player-a',session='test-1',offset=0,extra=None):
    meta={'role_id':who,'session_id':session,'config_name':'PVE_MULTI','space_id':'room-1','filter_id':140001,'start_ts':1000+offset}
    symbols=['player-a','player-b','boss']
    def row(ms,entity,name,*args):return [ms,100+ms,symbols.index(entity)+1,CODES[name],*args]
    rows=[row(0,who,'skill_req',1,100,0)]
    if who=='player-a':
        rows += [row(100,'player-a','skill_state_change',100,'SKILL_START'),
                 row(200,'player-a','add_buff','player-a','player-b',900,1),
                 row(300,'player-a','buff_level_change','player-a','player-b',900,2),
                 row(800,'player-a','remove_buff','player-a','player-b',900),
                 row(1000,'player-a','skill_state_change',100,'SKILL_LEAVE'),
                 row(1100,'player-a','hp_change',1000,500)]
    else:
        rows += [row(100,'player-b','skill_state_change',200,'SKILL_START'),
                 row(200,'player-a','add_buff','player-a','player-b',900,1),
                 row(900,'player-b','skill_state_change',200,'SKILL_LEAVE'),
                 row(1100,'player-b','hp_change',1000,800)]
    rows+=extra or []
    return b'CLv2'+frame([-3,meta])+frame([-2,1000+offset,symbols,rows])


class CombatTests(unittest.TestCase):
    def test_decode_and_external_buff_source(self):
        s=normalize(fixture(),'a.bin');e=next(e for e in s['events'] if e['type']=='add_buff')
        self.assertEqual(e['source'],actor_id('player-b'));self.assertEqual(e['target'],s['observer'])
        self.assertNotEqual(e['source'],e['target']);self.assertEqual(s['event_count'],7)

    def test_strict_and_live_partial_frames(self):
        raw=fixture()
        with self.assertRaises(ValueError):read_log(raw[:-1])
        meta,rows,complete=read_log(raw[:-1],allow_partial=True)
        self.assertFalse(complete);self.assertEqual(rows,[]);self.assertEqual(meta['filter_id'],140001)

    def test_nested_payload_not_confused_with_result(self):
        f=fields('{skill_d: {damage: 999, id: 900}, damage: 12.5, skill_id: 100, fromer_id: a}')
        self.assertEqual(f['damage'],'12.5');self.assertEqual(f['skill_id'],'100')
        self.assertEqual(fields('{broken: [1,2}'),{})

    def test_merge_keeps_other_players_actions(self):
        a=normalize(fixture(),'a.bin');b=normalize(fixture('player-b'),'b.bin')
        r=merge_sessions([a,b]);self.assertEqual(r['duplicate_count'],1)
        actors={c['actor'] for c in r['casts'] if c['kind']=='cast'}
        self.assertEqual(actors,{actor_id('player-a'),actor_id('player-b')})
        self.assertEqual(len(r['buff_intervals']),1)
        self.assertAlmostEqual(r['buff_intervals'][0]['start'],.2)
        self.assertAlmostEqual(r['buff_intervals'][0]['end'],.8)

    def test_simultaneous_multi_hits_not_collapsed(self):
        a=normalize(fixture(),'a.bin');b=normalize(fixture('player-b'),'b.bin')
        hit={'seq':99,'ts':1000.5,'frame':50,'actor':actor_id('boss'),'type':'behit_began',
             'source':actor_id('player-a'),'target':actor_id('boss'),'amount':100,'category':'damage','skill':100}
        a['events'] += [dict(hit),dict(hit,seq=100)]
        b['events'] += [dict(hit,frame=77)]
        r=merge_sessions([a,b]);hits=[e for e in r['events'] if e['category']=='damage']
        self.assertEqual(len(hits),2);self.assertEqual(sorted(len(e['views']) for e in hits),[1,2])

    def test_near_matches_kept_and_uncertainty_marked(self):
        a=normalize(fixture(),'a.bin');b=normalize(fixture('player-b',offset=.0004),'b.bin')
        r=merge_sessions([a,b]);self.assertEqual(r['duplicate_count'],0);self.assertTrue(r['multi_view_uncertainty'])

    def test_clock_offsets_and_different_fights(self):
        a=normalize(fixture(),'a.bin');b=normalize(fixture('player-b',offset=60),'b.bin')
        with self.assertRaises(ValueError):merge_sessions([a,b])
        r=merge_sessions([a,b],{b['id']:-60});self.assertEqual(r['duplicate_count'],1)
        b['filter_id']=130001
        with self.assertRaises(ValueError):merge_sessions([a,b],{b['id']:-60})

    def test_buff_source_intervals_do_not_collapse(self):
        a=normalize(fixture(),'a.bin');e=next(e for e in a['events'] if e['type']=='add_buff')
        a['events'].append(dict(e,source=actor_id('player-c'),seq=90))
        r=merge_sessions([a]);self.assertEqual(len(r['buff_intervals']),2)
        self.assertEqual(sum(not b['end_known'] for b in r['buff_intervals']),1)

    def test_unknown_initial_buff_does_not_invent_start(self):
        a=normalize(fixture(),'a.bin');a['events']=[e for e in a['events'] if e['category']!='buff' or e['type']=='remove_buff']
        b=merge_sessions([a])['buff_intervals'][0]
        self.assertFalse(b['start_known']);self.assertEqual(b['start'],b['end'])

    def test_heal_not_damage_and_observer_not_guessed(self):
        payload='{damage: 25, damage_type: 2, fromer_id: player-b, target_id: player-a, skill_id: 300}'
        rows=[[500,100,1,CODES['behit_began'],payload]]
        s=normalize(fixture(extra=rows),'a.bin');hit=next(e for e in s['events'] if e['type']=='behit_began')
        self.assertEqual(hit['category'],'heal');self.assertEqual(hit['amount'],25)
        raw=fixture(extra=[[501,101,2,CODES['skill_req'],1,200,0]])
        self.assertIsNone(normalize(raw,'a.bin')['observer'])

    def test_library_roundtrip_dedup_export_and_zip_safety(self):
        with tempfile.TemporaryDirectory() as temp:
            lib=Library(Path(temp)/'data',Path(temp)/'no-logs')
            sid,changed=lib.ingest(fixture(),'a.bin');self.assertTrue(changed)
            _,changed=lib.ingest(fixture(),'renamed.bin');self.assertFalse(changed)
            self.assertEqual(len(lib.list_sessions()),1)
            exported=lib.export_zip([sid]);result=lib.import_blob(exported,'x.zip')
            self.assertEqual(result['duplicates'],1)
            lib.save_names({'skills':{'100':'测试技能'}})
            self.assertEqual(lib.report([sid])['names']['skills']['100'],'测试技能')
            archive=io.BytesIO()
            with zipfile.ZipFile(archive,'w') as z:z.writestr('../../outside.bin',fixture('player-b'))
            result=lib.import_blob(archive.getvalue(),'x.zip');self.assertEqual(result['added'],1)
            self.assertFalse((Path(temp)/'outside.bin').exists())
            with self.assertRaises(ValueError):lib.ingest(fixture()[:-1],'partial.bin',partial=True)

    def test_no_source_buff_is_valid(self):
        raw=fixture(extra=[[900,900,1,CODES['add_buff'],'player-a',None,901,1]])
        with tempfile.TemporaryDirectory() as temp:
            lib=Library(Path(temp)/'data',Path(temp)/'no-logs')
            lib.ingest(raw,'a.bin');self.assertEqual(lib.list_sessions()[0]['external_buff_events'],1)

    def test_final_event_is_inside_report_duration_after_timestamp_rounding(self):
        s=normalize(fixture(),'a.bin');s['start']=1700000000;s['end']=1700000000.1
        s['events']=[dict(s['events'][1],ts=s['start']),dict(s['events'][-1],ts=s['end'])]
        r=merge_sessions([s])
        self.assertEqual(r['duration'],.1)
        self.assertLessEqual(r['events'][-1]['t'],r['duration'])


if __name__=='__main__':unittest.main()
