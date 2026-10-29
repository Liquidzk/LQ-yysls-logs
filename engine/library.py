"""Shared local combat archive. Used directly by the native client and legacy HTTP UI."""
from __future__ import annotations
from contextlib import contextmanager
import gzip
import io
import json
from pathlib import Path
import secrets
import sqlite3
import threading
import time
import zipfile
from combat import ROOT, normalize, merge_sessions, digest
from skill_review import current_name_coverage
from stars import Stars
from display_names import apply_display_names

DEFAULT_LOG_ROOT = ROOT.parent.parent/'yysls_medium'/'LocalData'/'ClientLocalLog'
MAX_UPLOAD = 64 * 1024 * 1024


class Library:
    def __init__(self, data_dir=None, log_root=None):
        self.data=Path(data_dir or ROOT/'data');self.data.mkdir(parents=True,exist_ok=True)
        self.raw=self.data/'archive';self.raw.mkdir(exist_ok=True)
        self.parsed=self.data/'sessions';self.parsed.mkdir(exist_ok=True)
        self.log_root=Path(log_root or DEFAULT_LOG_ROOT)
        self.db_path=self.data/'library.sqlite3'
        self.catalog_path=ROOT/'name_catalog.json'
        self.catalog=json.loads(self.catalog_path.read_text(encoding='utf-8')) if self.catalog_path.exists() else {}
        self.catalog_stamp=self.catalog_path.stat().st_mtime_ns if self.catalog_path.exists() else None
        apply_display_names(self.catalog)
        self.stars=Stars(self.data)
        self.lock=threading.RLock();self.scan_lock=threading.Lock()
        self.status={'scanning':False,'processed':0,'total':0,'last_scan':None,'last_error':None,
                     'watching':True,'log_root':str(self.log_root),'interval_seconds':10}
        with self.db() as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, hash TEXT, start REAL,
                  end REAL, summary TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER, session_id TEXT);
                CREATE TABLE IF NOT EXISTS names(kind TEXT, id TEXT, name TEXT, PRIMARY KEY(kind,id));
                CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, report_key TEXT, time REAL, text TEXT);
                CREATE TABLE IF NOT EXISTS errors(path TEXT PRIMARY KEY, message TEXT, updated REAL);
            ''')

    @contextmanager
    def db(self):
        c=sqlite3.connect(self.db_path,timeout=30)
        try:
            c.execute('PRAGMA journal_mode=WAL')
            with c:yield c
        finally:c.close()

    def ingest(self, raw, filename, partial=False):
        s=normalize(raw,filename,allow_partial=partial)
        if not s['complete_file']:
            # Wait for the writer: never replace a full archived session with a tail fragment.
            raise ValueError('日志尚未写完，等待下次扫描')
        checksum=s['content_hash']
        summary={k:v for k,v in s.items() if k not in ('events','actors','raw_event_counts')}
        summary['actor_count']=len(s['actors'])
        summary['combat_event_count']=sum(e['category']!='diagnostic' for e in s['events'])
        summary['external_buff_events']=sum(bool(e['type']=='add_buff' and e.get('source') and
                                            e.get('source')!=e.get('target')) for e in s['events'])
        summary['skill_starts']=sum(e['type']=='skill_state_change' and e.get('state')=='SKILL_START' for e in s['events'])
        summary['archived_at']=time.time()
        payload=json.dumps(s,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf-8')
        with self.lock:
            with self.db() as c:
                old=c.execute('SELECT hash FROM sessions WHERE id=?',(s['id'],)).fetchone()
                if old and old[0]==checksum:return s['id'],False
            target=self.raw/(checksum+'.bin')
            if not target.exists():target.write_bytes(raw)
            temp=self.parsed/(s['id']+'.tmp')
            temp.write_bytes(gzip.compress(payload,compresslevel=3))
            temp.replace(self.parsed/(s['id']+'.json.gz'))
            with self.db() as c:
                c.execute('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?,?)',
                          (s['id'],checksum,s['start'],s['end'],json.dumps(summary,ensure_ascii=False)))
        return s['id'],True

    def scan(self):
        if not self.scan_lock.acquire(blocking=False):return
        try:
            self.status.update(scanning=True,processed=0,last_error=None)
            paths=[]
            if self.log_root.exists():
                for category in ('PVE','PVP','COMBAT_DEBUG'):
                    paths.extend(self.log_root.glob('*/'+category+'/*.bin'))
            paths.sort(key=lambda p:p.stat().st_mtime,reverse=True)
            self.status['total']=len(paths)
            with self.db() as c:known={r[0]:(r[1],r[2]) for r in c.execute('SELECT path,mtime,size FROM sources')}
            for index,path in enumerate(paths):
                stat=path.stat();key=str(path)
                if known.get(key)!=(stat.st_mtime_ns,stat.st_size):
                    try:
                        raw=path.read_bytes()
                        after=path.stat()
                        if (after.st_mtime_ns,after.st_size)!=(stat.st_mtime_ns,stat.st_size):
                            continue
                        sid,_=self.ingest(raw,path.name,partial=True)
                        with self.db() as c:
                            c.execute('INSERT OR REPLACE INTO sources VALUES(?,?,?,?)',(key,stat.st_mtime_ns,stat.st_size,sid))
                            c.execute('DELETE FROM errors WHERE path=?',(key,))
                    except Exception as exc:
                        with self.db() as c:c.execute('INSERT OR REPLACE INTO errors VALUES(?,?,?)',(key,str(exc)[:200],time.time()))
                self.status['processed']=index+1
            self.status['last_scan']=time.time()
            if not paths:self.status['last_error']='尚未找到 PVE/PVP 日志；可手动导入 .bin 日志。'
        except Exception as exc:
            self.status['last_error']=str(exc)[:200]
        finally:
            self.status['scanning']=False;self.scan_lock.release()

    def watch(self,stop):
        while not stop.is_set():
            if self.status['watching']:self.scan()
            stop.wait(10)

    def list_sessions(self):
        starred=self.stars.ids('clv2')
        with self.db() as c:
            rows=[json.loads(r[0]) for r in c.execute('SELECT summary FROM sessions ORDER BY start DESC')]
        return [dict(row,starred=row['id'] in starred) for row in rows]

    def set_star(self, sid, starred):
        with self.db() as c:
            if not c.execute('SELECT 1 FROM sessions WHERE id=?',(sid,)).fetchone():raise ValueError('战斗记录不存在')
        return self.stars.set('clv2',sid,starred)

    def get(self,sid):
        if not sid.startswith('s_') or not sid[2:].isalnum() or len(sid)>50:raise ValueError('日志编号无效')
        path=self.parsed/(sid+'.json.gz')
        if not path.exists():raise ValueError('找不到这份日志')
        return json.loads(gzip.decompress(path.read_bytes()))

    def names(self):
        self.refresh_catalog()
        result={kind:dict(self.catalog.get('names',{}).get(kind,{})) for kind in ('actors','skills','buffs','npcs','scenes')}
        with self.db() as c:
            for kind,id_,name in c.execute('SELECT kind,id,name FROM names'):result[kind][id_]=name
        return result

    def refresh_catalog(self):
        if not self.catalog_path.exists():return
        stamp=self.catalog_path.stat().st_mtime_ns
        if stamp!=self.catalog_stamp:
            with self.lock:
                catalog=json.loads(self.catalog_path.read_text(encoding='utf-8'))
                self.catalog=apply_display_names(catalog);self.catalog_stamp=stamp

    def save_names(self,data):
        rows=[]
        for kind,values in data.items():
            if kind not in ('actors','skills','buffs','npcs','scenes') or not isinstance(values,dict):raise ValueError('名称表格式无效')
            if len(values)>50000:raise ValueError('名称表过大')
            for id_,name in values.items():
                if not isinstance(name,str) or not 1<=len(name.strip())<=120:raise ValueError('名称须为 1—120 字符')
                if len(str(id_))>80:raise ValueError('名称编号过长')
                rows.append((kind,str(id_),name.strip()))
        with self.db() as c:c.executemany('INSERT OR REPLACE INTO names VALUES(?,?,?)',rows)

    def name_evidence(self):
        self.refresh_catalog()
        evidence={k:dict(v) for k,v in self.catalog.get('provenance',{}).items()}
        with self.db() as c:
            for kind,id_,name in c.execute('SELECT kind,id,name FROM names'):
                evidence.setdefault(kind,{})[id_]={'label':'手动名称','name':name,
                    'original':self.catalog.get('provenance',{}).get(kind,{}).get(id_)}
        return evidence

    def report(self,ids,offsets=None):
        ids=list(dict.fromkeys(ids));offsets=offsets or {}
        if not ids:raise ValueError('未选择日志')
        for key,value in offsets.items():
            if key not in ids or not isinstance(value,(float,int)) or not -86400<=value<=86400:raise ValueError('时间偏移超出范围')
        offsets={k:v for k,v in offsets.items() if v!=0}
        report=merge_sessions([self.get(sid) for sid in ids],offsets)
        report['key']=digest(json.dumps({'ids':sorted(ids),'offsets':offsets},sort_keys=True))
        report['revision']=digest(json.dumps({'sessions':sorted((s['id'],s['content_hash']) for s in report['sessions']),
                                              'offsets':offsets},sort_keys=True))
        report['names']=self.names()
        current,unresolved=current_name_coverage(report,report['names'],self.catalog.get('unresolved',{}))
        report['name_catalog']={'summary':self.catalog.get('summary',{}),'provenance':self.name_evidence(),
                                'current_summary':current,'unresolved':unresolved}
        with self.db() as c:
            report['notes']=[{'id':r[0],'t':r[1],'text':r[2]} for r in c.execute(
                'SELECT id,time,text FROM notes WHERE report_key=? ORDER BY time',(report['key'],))]
        return report

    def import_blob(self,raw,filename):
        if filename.lower().endswith('.zip'):
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                members=[i for i in z.infolist() if not i.is_dir() and i.filename.lower().endswith('.bin')]
                if not members or len(members)>30 or sum(i.file_size for i in members)>MAX_UPLOAD:
                    raise ValueError('日志包最多含 30 份 .bin，解压总大小不得超过 64 MB')
                # No extraction; archive member paths cannot write to the filesystem.
                items=[(z.read(i),Path(i.filename).name) for i in members]
        else:items=[(raw,filename)]
        # Validate every member first; malformed input cannot produce a partial import.
        for content,name in items:normalize(content,name)
        ids,changed=[],0
        for content,name in items:
            sid,new=self.ingest(content,name);ids.append(sid);changed+=int(new)
        return {'ids':list(dict.fromkeys(ids)),'added':changed,'duplicates':len(items)-changed}

    def export_zip(self,ids):
        if not ids or len(ids)>12:raise ValueError('请选择 1—12 份日志')
        out=io.BytesIO()
        with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as z:
            for sid in dict.fromkeys(ids):
                s=self.get(sid);path=self.raw/(s['content_hash']+'.bin')
                z.writestr(sid+'_'+s['file_name'],path.read_bytes())
        return out.getvalue()

    def save_note(self, report_key, t, text):
        if (not isinstance(text,str) or not 1<=len(text.strip())<=1000
                or not isinstance(t,(int,float)) or not 0<=t<86400
                or not isinstance(report_key,str) or len(report_key)!=20):
            raise ValueError('笔记内容或时间无效')
        note={'id':'n_'+secrets.token_hex(8),'t':t,'text':text.strip()}
        with self.db() as c:
            c.execute('INSERT INTO notes VALUES(?,?,?,?)',(note['id'],report_key,t,note['text']))
        return note
