import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from desktop_server import DesktopHandler,ThreadingHTTPServer
from library import Library
from test_combat import fixture

class DesktopHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();root=Path(self.tmp.name)
        self.lib=Library(root/'data',root/'absent');self.sid=self.lib.ingest(fixture(),'a.bin')[0]
        self.http=ThreadingHTTPServer(('127.0.0.1',0),DesktopHandler);self.http.library=self.lib
        self.http.kagerou_root=root/'skin';self.http.kagerou_root.mkdir()
        self.http.assets_root=root/'assets';self.http.assets_root.mkdir()
        (root/'secret.txt').write_text('outside static root')
        (self.http.kagerou_root/'test.txt').write_text('bundled skin')
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.http.server_port}'
    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.thread.join();self.tmp.cleanup()
    def request(self,path,body=None,headers=None):
        req=Request(self.base+path,data=json.dumps(body).encode() if body is not None else None,
                    headers=headers or {'X-Yanyun-Local':'1'})
        with urlopen(req) as response:return response.read()
    def test_selected_report_reaches_overlay_and_range_is_validated(self):
        self.assertTrue(json.loads(self.request('/api/overlay-view'))['waiting'])
        self.request('/api/overlay-view',{'ids':[self.sid]})
        view=json.loads(self.request('/api/overlay-view'));self.assertTrue(view['yanyunObserved'])
        self.assertEqual(view['meta']['mode'],'archived-review')
        with self.assertRaises(HTTPError):self.request('/api/overlay-view',{'ids':[self.sid],'to':1e9})
        self.assertEqual(json.loads(self.request('/api/overlay-view'))['meta'],view['meta'])
    def test_static_paths_do_not_escape_bundle(self):
        self.assertEqual(self.request('/kagerou/test.txt'),b'bundled skin')
        with self.assertRaises(HTTPError) as error:self.request('/kagerou/%2e%2e/secret.txt')
        self.assertEqual(error.exception.code,403)
    def test_foreign_origin_cannot_replace_overlay(self):
        with self.assertRaises(HTTPError) as error:
            self.request('/api/overlay-view',{'ids':[self.sid]}, {'X-Yanyun-Local':'1','Origin':'https://foreign.invalid'})
        self.assertEqual(error.exception.code,403)

if __name__=='__main__':unittest.main()
