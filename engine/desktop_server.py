"""Private desktop child process: archive API + locally bundled Kagerou assets."""
import argparse
import json
import mimetypes
from pathlib import Path
import sys
import threading
from urllib.parse import urlparse,unquote
from server import Handler,ThreadingHTTPServer
from library import Library
from kagerou_adapter import to_kagerou
from wire_store import WireStore
from urllib.parse import parse_qs

class DesktopHandler(Handler):
    def do_GET(self):
        path=unquote(urlparse(self.path).path)
        if not self.valid_host():self.send({'error':'仅限本机访问'},403);return
        if path in ('/', '/capture', '/workbench.js', '/workbench.css', '/timeline.js', '/timeline-layout.js', '/timeline.css'):
            name={'/':'workbench.html','/capture':'workbench.html','/workbench.js':'workbench.js','/workbench.css':'workbench.css','/timeline.js':'timeline.js','/timeline-layout.js':'timeline-layout.js','/timeline.css':'timeline.css'}[path]
            from combat import ROOT
            file=ROOT/'web'/name
            self.send(file.read_bytes(),ctype=mimetypes.guess_type(str(file))[0]+'; charset=utf-8');return
        if path=='/review':
            self.path='/index.html';return super().do_GET()
        if path.startswith('/api/capture/'):
            try:
                q=parse_qs(urlparse(self.path).query)
                if path=='/api/capture/status':self.send(self.server.wire.status());return
                if path=='/api/capture/sessions':self.send(self.server.wire.list());return
                if path=='/api/capture/timeline':
                    self.send(self.server.wire.timeline(q.get('key',[''])[0],q.get('window',[3])[0]));return
                if path=='/api/capture/report':
                    self.send(self.server.wire.report(q.get('key',[''])[0],q.get('actor',[''])[0],q.get('kind',['all'])[0],q.get('offset',[0])[0],q.get('search',[''])[0]));return
            except (ValueError,OSError) as exc:self.send({'error':str(exc)},400);return
        if path=='/api/overlay-view':
            self.send(getattr(self.server,'overlay_view',None) or {'waiting':True});return
        if path.startswith('/kagerou/') or path.startswith('/desktop-assets/'):
            prefix='/kagerou/' if path.startswith('/kagerou/') else '/desktop-assets/'
            root=self.server.kagerou_root if prefix=='/kagerou/' else self.server.assets_root
            file=(root/path[len(prefix):]).resolve()
            if not file.is_relative_to(root):self.send('Forbidden',403,'text/plain');return
            if file.is_dir():file=file/'index.html'
            if file.suffix.lower() not in ('.html','.js','.css','.json','.svg','.png','.woff','.woff2','.txt') or not file.is_file():
                self.send('Not found',404,'text/plain');return
            self.send(file.read_bytes(),ctype=mimetypes.guess_type(str(file))[0] or 'application/octet-stream');return
        super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path in ('/api/capture/star','/api/capture/star-latest'):
            origin=self.headers.get('Origin')
            if not self.valid_host() or self.headers.get('X-Yanyun-Local')!='1' or origin and origin!=f'http://127.0.0.1:{self.server.server_port}':
                self.send({'error':'仅限本机操作'},403);return
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<4096:raise ValueError('请求大小无效')
                body=json.loads(self.rfile.read(size))
                result=self.server.wire.star_latest() if urlparse(self.path).path.endswith('star-latest') else self.server.wire.set_star(body['key'],body['starred'])
                self.send(result)
            except (ValueError,OSError,KeyError,TypeError) as exc:self.send({'error':str(exc)},400)
            return
        if urlparse(self.path).path=='/api/capture/import':
            origin=self.headers.get('Origin')
            if not self.valid_host() or self.headers.get('X-Yanyun-Local')!='1' or origin and origin!=f'http://127.0.0.1:{self.server.server_port}':
                self.send({'error':'仅限本机操作'},403);return
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<16384:raise ValueError('请求大小无效')
                self.send(self.server.wire.add_source(json.loads(self.rfile.read(size))['path']))
            except (ValueError,OSError,KeyError) as exc:self.send({'error':str(exc)},400)
            return
        if urlparse(self.path).path!='/api/overlay-view':return super().do_POST()
        origin=self.headers.get('Origin')
        if (not self.valid_host() or self.headers.get('X-Yanyun-Local')!='1'
                or origin and origin not in (f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}')):
            self.send({'error':'仅接受本机操作'},403);return
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=16384:raise ValueError('请求大小无效')
            body=json.loads(self.rfile.read(size))
            with self.lib.lock:
                ticket=getattr(self.server,'overlay_ticket',0)+1
                self.server.overlay_ticket=ticket
            report=self.lib.report(body.get('ids',[]),body.get('offsets',{}))
            view=to_kagerou(report,body.get('from',0),body.get('to'))
            with self.lib.lock:
                if self.server.overlay_ticket==ticket:self.server.overlay_view=view
            self.send({'ok':True,'revision':report['revision']})
        except (ValueError,TypeError,KeyError) as exc:self.send({'error':str(exc)},400)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--data-dir',required=True);parser.add_argument('--log-root',required=True)
    parser.add_argument('--kagerou-root',required=True);parser.add_argument('--assets-root',required=True)
    parser.add_argument('--port',type=int,default=0);parser.add_argument('--no-watch',action='store_true')
    parser.add_argument('--capture-root')
    args=parser.parse_args()
    lib=Library(args.data_dir,args.log_root);stop=threading.Event()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),DesktopHandler)
    server.library=lib;server.kagerou_root=Path(args.kagerou_root).resolve();server.assets_root=Path(args.assets_root).resolve()
    server.wire=WireStore(args.data_dir,args.capture_root or str(lib.data/'captures'))
    lib.status['watching']=not args.no_watch
    watch=threading.Thread(target=lib.watch,args=(stop,),daemon=True)
    if not args.no_watch:watch.start()
    # EOF means the parent exited. Never leave a desktop-owned server behind.
    def parent():
        sys.stdin.readline();stop.set();server.shutdown()
    threading.Thread(target=parent,daemon=True).start()
    print(json.dumps({'ready':True,'port':server.server_port}),flush=True)
    try:server.serve_forever(poll_interval=.2)
    finally:
        stop.set();server.server_close()
        if watch.is_alive():watch.join(timeout=5)

if __name__=='__main__':main()
