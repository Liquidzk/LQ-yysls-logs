"""Local-only Yanyun Logs library and browser application."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import gzip
import io
import json
import mimetypes
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
import zipfile

from combat import ROOT, normalize, merge_sessions, digest
from skill_review import review_cast, current_name_coverage

from library import Library, DEFAULT_LOG_ROOT, MAX_UPLOAD


class Handler(BaseHTTPRequestHandler):
    server_version='YanyunLogs/0.4'
    def log_message(self,fmt,*args):
        if args and ' 200 ' not in str(args):print(fmt%args,flush=True)

    @property
    def lib(self):return self.server.library

    def send(self,data,status=200,ctype='application/json; charset=utf-8',download=None):
        if isinstance(data,(dict,list)):data=json.dumps(data,ensure_ascii=False,allow_nan=False).encode('utf-8')
        if isinstance(data,str):data=data.encode('utf-8')
        self.send_response(status);self.send_header('Content-Type',ctype)
        self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        if download:self.send_header('Content-Disposition',f'attachment; filename="{download}"')
        self.end_headers();self.wfile.write(data)

    def valid_host(self):
        return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}')

    def do_GET(self):
        if not self.valid_host():self.send({'error':'仅限本机访问'},403);return
        try:
            parsed=urlparse(self.path);q=parse_qs(parsed.query);path=parsed.path
            if path=='/api/status':
                with self.lib.db() as c:
                    count=c.execute('SELECT count(*) FROM sessions').fetchone()[0]
                    errors=[{'file':Path(r[0]).name,'message':r[1]} for r in c.execute('SELECT path,message FROM errors ORDER BY updated DESC LIMIT 8')]
                self.send({**self.lib.status,'session_count':count,'errors':errors,'version':'0.4.0'});return
            if path=='/api/sessions':self.send(self.lib.list_sessions());return
            if path=='/api/names':self.send(self.lib.names());return
            if path=='/api/name-catalog':self.lib.refresh_catalog();self.send(self.lib.catalog);return
            if path=='/api/export':
                ids=q.get('ids',[''])[0].split(',')
                self.send(self.lib.export_zip(ids),ctype='application/zip',download='yanyun-combat-logs.zip');return
            if path.startswith('/api/'):self.send({'error':'接口不存在'},404);return
            files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/review.js':'review.js','/desktop-bridge.js':'desktop-bridge.js','/style.css':'style.css'}
            if path not in files:self.send('Not found',404,'text/plain');return
            file=ROOT/'web'/files[path]
            self.send(file.read_bytes(),ctype=mimetypes.guess_type(str(file))[0]+'; charset=utf-8')
        except (ValueError,KeyError,FileNotFoundError) as exc:self.send({'error':str(exc)},400)
        except Exception as exc:
            print('Request failed:',repr(exc),flush=True);self.send({'error':'处理失败，请查看本机运行日志。'},500)

    def do_POST(self):
        origin=self.headers.get('Origin')
        allowed=(f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}')
        if not self.valid_host() or self.headers.get('X-Yanyun-Local')!='1' or (origin and origin not in allowed):
            self.send({'error':'仅接受本机复盘界面的操作'},403);return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if length<0 or length>MAX_UPLOAD:raise ValueError('文件或请求过大（上限 64 MB）')
            raw=self.rfile.read(length)
            parsed=urlparse(self.path);path=parsed.path;q=parse_qs(parsed.query)
            if path=='/api/star':
                body=json.loads(raw);self.send(self.lib.set_star(body['id'],body['starred']));return
            if path=='/api/import':
                self.send(self.lib.import_blob(raw,q.get('name',['combat.bin'])[0]));return
            body=json.loads(raw or b'{}')
            if path=='/api/report':self.send(self.lib.report(body.get('ids',[]),body.get('offsets',{})));return
            if path=='/api/cast-review':
                report=self.lib.report(body.get('ids',[]),body.get('offsets',{}))
                if body.get('revision')!=report['revision']:
                    self.send({'error':'日志内容已更新，请重新打开这场记录后查看技能。'},409);return
                self.send(review_cast(report,body.get('cast_id')));return
            if path=='/api/scan':
                threading.Thread(target=self.lib.scan,daemon=True).start();self.send({'ok':True});return
            if path=='/api/names':self.lib.save_names(body);self.send({'ok':True});return
            if path=='/api/notes':
                key=body.get('report_key','');text=body.get('text','').strip();t=body.get('t')
                if not isinstance(text,str) or not 1<=len(text)<=1000 or not isinstance(t,(int,float)) or not 0<=t<86400 or len(key)!=20:
                    raise ValueError('笔记内容或时间无效')
                nid='n_'+secrets.token_hex(8)
                with self.lib.db() as c:c.execute('INSERT INTO notes VALUES(?,?,?,?)',(nid,key,t,text))
                self.send({'id':nid,'t':t,'text':text});return
            self.send({'error':'接口不存在'},404)
        except (ValueError,KeyError,TypeError,zipfile.BadZipFile) as exc:self.send({'error':str(exc)},400)
        except Exception as exc:
            print('Mutation failed:',repr(exc),flush=True);self.send({'error':'处理失败，请检查文件格式或运行日志。'},500)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8769)
    parser.add_argument('--log-root');parser.add_argument('--data-dir')
    parser.add_argument('--no-watch',action='store_true');args=parser.parse_args()
    settings_path=ROOT/'settings.json'
    settings=json.loads(settings_path.read_text(encoding='utf-8-sig')) if settings_path.exists() else {}
    library=Library(args.data_dir,args.log_root or settings.get('log_root') or DEFAULT_LOG_ROOT);stop=threading.Event()
    library.status['watching']=not args.no_watch
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler);server.library=library
    (library.data/'server.pid').write_text(str(os.getpid()),encoding='ascii')
    if not args.no_watch:threading.Thread(target=library.watch,args=(stop,),daemon=True).start()
    print(f'Yanyun Logs ready: http://127.0.0.1:{args.port}',flush=True)
    try:server.serve_forever()
    finally:stop.set();server.server_close()


if __name__=='__main__':main()
