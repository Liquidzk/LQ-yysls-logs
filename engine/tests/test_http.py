import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile

from test_combat import fixture,CODES
from server import Library,Handler,ThreadingHTTPServer


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.lib=Library(Path(self.temp.name)/'data',Path(self.temp.name)/'absent')
        self.lib.catalog_path=Path(self.temp.name)/'catalog.json';self.lib.catalog={};self.lib.catalog_stamp=None
        self.http=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.http.library=self.lib
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.http.server_port}'

    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.thread.join();self.temp.cleanup()

    def request(self,path,body=None,headers=None):
        if isinstance(body,dict):body=json.dumps(body).encode()
        req=urllib.request.Request(self.base+path,data=body,headers=headers or {'X-Yanyun-Local':'1'})
        with urllib.request.urlopen(req) as response:
            raw=response.read()
            return json.loads(raw) if 'application/json' in response.headers['Content-Type'] else raw

    def test_import_review_notes_and_export_roundtrip(self):
        a=self.request('/api/import?name=a.bin',fixture())['ids'][0]
        b=self.request('/api/import?name=b.bin',fixture('player-b'))['ids'][0]
        report=self.request('/api/report',{'ids':[a,b]})
        self.assertEqual(report['duplicate_count'],1)
        note=self.request('/api/notes',{'report_key':report['key'],'t':.5,'text':'复盘验证'})
        reloaded=self.request('/api/report',{'ids':[b,a],'offsets':{b:0}})
        self.assertEqual(reloaded['notes'],[note])
        rebuilt=Library(self.lib.data,self.lib.log_root)
        self.assertEqual(rebuilt.report([a,b])['notes'],[note])
        exported=self.request(f'/api/export?ids={a},{b}')
        with zipfile.ZipFile(io.BytesIO(exported)) as z:self.assertEqual(len(z.infolist()),2)
        self.assertEqual(self.request('/api/import?name=again.zip',exported)['duplicates'],2)

    def test_foreign_origin_and_missing_local_header_rejected(self):
        for headers in ({'Content-Type':'application/json'},{'X-Yanyun-Local':'1','Origin':'https://external.invalid'}):
            with self.assertRaises(urllib.error.HTTPError) as error:self.request('/api/scan',{},headers)
            self.assertEqual(error.exception.code,403)
        self.assertEqual(self.request('/api/status')['session_count'],0)

    def test_bad_zip_member_does_not_partially_import(self):
        data=io.BytesIO()
        with zipfile.ZipFile(data,'w') as z:
            z.writestr('good.bin',fixture());z.writestr('bad.bin',b'not-a-log')
        with self.assertRaises(urllib.error.HTTPError) as error:self.request('/api/import?name=mixed.zip',data.getvalue())
        self.assertEqual(error.exception.code,400)
        self.assertEqual(self.request('/api/sessions'),[])

    def test_clv2_star_survives_reimport_and_checks_request_origin(self):
        sid=self.request('/api/import?name=star.bin',fixture())['ids'][0]
        self.assertTrue(self.request('/api/star',{'id':sid,'starred':True})['starred'])
        self.request('/api/import?name=star-again.bin',fixture())
        self.assertTrue(self.request('/api/sessions')[0]['starred'])
        with self.assertRaises(urllib.error.HTTPError):
            self.request('/api/star',{'id':sid,'starred':False},headers={'X-Yanyun-Local':'1','Origin':'https://other.invalid'})
        self.assertTrue(self.request('/api/sessions')[0]['starred'])
        self.assertFalse(self.request('/api/star',{'id':sid,'starred':False})['starred'])

    def test_builtin_names_scene_and_manual_override_sources(self):
        self.lib.catalog={'names':{'skills':{'100':'技能原名'},'scenes':{'140001':'雨铃客'}},
                          'provenance':{'skills':{'100':{'label':'客户端中文资源','table':'skills','field':'name'}}}}
        a=self.request('/api/import?name=a.bin',fixture())['ids'][0]
        report=self.request('/api/report',{'ids':[a]})
        self.assertEqual(report['names']['skills']['100'],'技能原名')
        self.assertEqual(report['names']['scenes']['140001'],'雨铃客')
        self.request('/api/names',{'skills':{'100':'自定义名称'},'scenes':{'140001':'自定义场景'}})
        report=self.request('/api/report',{'ids':[a]})
        self.assertEqual(report['names']['skills']['100'],'自定义名称')
        self.assertEqual(report['names']['scenes']['140001'],'自定义场景')
        self.assertEqual(report['name_catalog']['provenance']['skills']['100']['label'],'手动名称')
        self.assertEqual(self.request('/api/name-catalog')['names']['skills']['100'],'技能原名')
        self.assertNotIn('999999',report['names']['skills'])

    def test_rebuilt_catalog_reload_preserves_custom_names(self):
        import os
        path=Path(self.temp.name)/'catalog.json';self.lib.catalog_path=path
        path.write_text(json.dumps({'names':{'skills':{'100':'旧名称','101':'保留编号'}}}),encoding='utf-8')
        self.assertEqual(self.request('/api/names')['skills']['100'],'旧名称')
        self.request('/api/names',{'skills':{'101':'我的备注名称'}})
        stamp=path.stat().st_mtime
        path.write_text(json.dumps({'names':{'skills':{'100':'新名称','101':'官方名称'}}}),encoding='utf-8')
        os.utime(path,(stamp+2,stamp+2))
        names=self.request('/api/names')['skills']
        self.assertEqual(names['100'],'新名称')
        self.assertEqual(names['101'],'我的备注名称')

    def test_cast_review_checks_report_revision_and_keeps_unknown_damage(self):
        sid=self.request('/api/import?name=a.bin',fixture())['ids'][0]
        report=self.request('/api/report',{'ids':[sid]})
        data={'ids':[sid],'revision':report['revision'],'cast_id':report['casts'][0]['id']}
        detail=self.request('/api/cast-review',data)
        self.assertEqual(detail['cast']['skill'],100)
        self.assertIsNone(detail['damage']['amount'])
        self.assertEqual(detail['buffs'][0]['source'],report['buff_intervals'][0]['source'])
        self.assertIn('current_summary',report['name_catalog'])
        self.assertIn(b'renderCastDetail',self.request('/review.js'))
        self.request('/api/import?name=updated.bin',fixture(extra=[[1200,1200,1,CODES['hp_change'],1,2]]))
        with self.assertRaises(urllib.error.HTTPError) as error:self.request('/api/cast-review',data)
        self.assertEqual(error.exception.code,409)


if __name__=='__main__':unittest.main()
