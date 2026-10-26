"""Indexed, paginated review of retained network observations; no capture here."""
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import threading
from datetime import datetime


def read_json(path, default=None):
    try:
        if path.stat().st_size > 32 * 1024 * 1024:
            return default
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return default


def timestamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (TypeError, AttributeError, ValueError):
        return None


class WireStore:
    streams = {'statistics.jsonl': 'counter', 'damage-events.jsonl': 'hit', 'buff-events.jsonl': 'buff',
               'encounter-events.jsonl': 'boundary', 'identity-events.jsonl': 'identity',
               'settlement-details.jsonl': 'settlement'}

    def __init__(self, data, capture_root):
        self.data, self.root = Path(data), Path(capture_root).resolve()
        self.data.mkdir(parents=True, exist_ok=True)
        self.root.mkdir(parents=True, exist_ok=True)
        self.registry = self.data / 'capture-sources.json'
        self.dbpath = self.data / 'capture-index.sqlite3'
        self.lock = threading.RLock()
        with self.connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS streams(root TEXT,file TEXT,offset INTEGER,ordinal INTEGER,PRIMARY KEY(root,file));
            CREATE TABLE IF NOT EXISTS events(root TEXT,stream TEXT,ordinal INTEGER,ts REAL,kind TEXT,actor TEXT,target TEXT,skill TEXT,buff TEXT,payload TEXT,PRIMARY KEY(root,stream,ordinal));
            CREATE INDEX IF NOT EXISTS capture_time ON events(root,ts);
            CREATE INDEX IF NOT EXISTS capture_kind ON events(root,kind,ts);''')

    def connect(self):
        db = sqlite3.connect(self.dbpath, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        return db

    def roots(self):
        roots = list(self.root.glob('sessions/*/capture'))
        for item in read_json(self.registry, []) or []:
            folder = Path(item)
            if (folder / 'latest.json').is_file() or (folder / 'statistics.jsonl').is_file():
                roots.append(folder)
            if (folder / 'capture' / 'statistics.jsonl').is_file():
                roots.append(folder / 'capture')
            roots.extend(folder.glob('sessions/*/capture'))
            roots.extend(folder.glob('*/capture'))
        return sorted({p.resolve() for p in roots if p.is_dir()})

    def add_source(self, folder):
        folder = Path(folder).resolve()
        if not folder.is_dir():
            raise ValueError('请选择捕获记录目录')
        if folder.name == 'battles' or (folder / 'battle.json').is_file():
            folder = folder.parent if folder.name == 'battles' else folder.parent.parent
        if not ((folder / 'latest.json').is_file() or (folder / 'statistics.jsonl').is_file()
                or (folder / 'capture' / 'statistics.jsonl').is_file()
                or list(folder.glob('sessions/*/capture/statistics.jsonl')) or list(folder.glob('*/capture/statistics.jsonl'))):
            raise ValueError('未找到捕获记录。请选择 capture、会话目录或包含 sessions 的目录。')
        with self.lock:
            rows = read_json(self.registry, []) or []
            if str(folder) not in rows:
                rows.append(str(folder))
            self.registry.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
        return {'ok': True}

    @staticmethod
    def key(path):
        return hashlib.sha256(str(path).encode()).hexdigest()[:24]

    def entries(self):
        out = []
        for root in self.roots():
            latest = read_json(root / 'latest.json', {}) or {}
            battles = sorted(root.glob('battles/*/battle.json'))
            # Keep the whole session available even when encounter boundaries are incomplete.
            out.append({'key': self.key(root), 'root': root, 'path': root, 'battle': None, 'latest': latest})
            for file in battles:
                battle = read_json(file, {}) or {}
                if battle.get('clock', {}).get('startObservedAt'):
                    out.append({'key': self.key(file.parent), 'root': root, 'path': file.parent, 'battle': battle, 'latest': latest})
        return out

    def find(self, key):
        result = next((e for e in self.entries() if e['key'] == key), None)
        if not result:
            raise ValueError('捕获记录不存在，请刷新战斗列表')
        return result

    def list(self):
        result = []
        for e in self.entries():
            b, last = e['battle'], e['latest']
            clock = (b or {}).get('clock', {})
            npc = (b or {}).get('statistics', {}).get('npcNo') or last.get('npcNo')
            result.append({'key': e['key'], 'kind': 'battle' if b else 'session',
                           'title': ('战斗' if b else '完整采集会话') + ' · ' + str(npc or '等待目标'), 'npcNo': npc,
                           'startedAt': clock.get('startObservedAt') or (read_json(e['root'] / 'manifest.json', {}) or {}).get('startedAt') or last.get('observedAt'),
                           'endedAt': clock.get('endObservedAt'), 'mode': last.get('source', {}).get('mode', 'unknown'),
                           'status': (b or {}).get('status') or last.get('health', {}).get('status', 'unknown')})
        return sorted(result, key=lambda x: x['startedAt'] or '', reverse=True)

    def status(self):
        control = read_json(self.root / 'control.json', {}) or {}
        service = read_json(self.root / 'service.json', {}) or {}
        latest, health = {}, {}
        candidate = service.get('latestPath')
        if candidate:
            path = Path(candidate).resolve()
            if path.is_relative_to(self.root) and path.name == 'latest.json':
                latest = read_json(path, {}) or {}
                health = read_json(path.parent / 'health.json', {}) or {}
        return {'control': control, 'service': {k: service.get(k) for k in ('message', 'detail', 'at', 'binding')},
                'latest': latest, 'health': health, 'key': self.key(Path(candidate).resolve().parent) if candidate and latest else None}

    def sync(self, root):
        root_key, more, errors = self.key(root), False, 0
        with self.lock, self.connect() as db:
            for file, kind in self.streams.items():
                path = root / file
                if not path.is_file():
                    continue
                old = db.execute('SELECT offset,ordinal FROM streams WHERE root=? AND file=?', (root_key, file)).fetchone()
                offset, ordinal = (old['offset'], old['ordinal']) if old else (0, 0)
                size = path.stat().st_size
                if size < offset:
                    db.execute('DELETE FROM events WHERE root=? AND stream=?', (root_key, file)); offset, ordinal = 0, 0
                limit = offset + 32 * 1024 * 1024
                with path.open('rb') as stream:
                    stream.seek(offset)
                    while stream.tell() < size and stream.tell() < limit:
                        line = stream.readline(4 * 1024 * 1024 + 1)
                        if not line.endswith(b'\n'):
                            if len(line) > 4 * 1024 * 1024:
                                raise ValueError('捕获记录包含超大行，无法解析')
                            break  # producer has not completed this line
                        offset = stream.tell(); ordinal += 1
                        try:
                            row = json.loads(line)
                            ts = timestamp(row.get('observedAt'))
                            if ts is None or not math.isfinite(ts):
                                errors += 1; continue
                            actor = row.get('sourceActorHash') or row.get('idHash') or ''
                            target = row.get('targetActorHash') or ''
                            skill = row.get('rawSkillId', row.get('skill_id'))
                            db.execute('INSERT OR REPLACE INTO events VALUES(?,?,?,?,?,?,?,?,?,?)',
                                       (root_key, file, ordinal, ts, kind, actor, target, str(skill) if isinstance(skill, (str, int)) else '',
                                        str(row.get('buffNo') or ''), json.dumps(row, ensure_ascii=False, allow_nan=False)))
                        except (ValueError, TypeError, AttributeError):
                            errors += 1
                more |= offset >= limit and offset < size
                db.execute('INSERT OR REPLACE INTO streams VALUES(?,?,?,?)', (root_key, file, offset, ordinal))
        return more, errors

    def report(self, key, actor='', kind='all', offset=0, search=''):
        entry = self.find(key); root = entry['root']; more, errors = self.sync(root)
        root_key, battle = self.key(root), entry['battle']
        clock = (battle or {}).get('clock', {})
        lower, upper = timestamp(clock.get('startObservedAt')), timestamp(clock.get('endObservedAt'))
        with self.connect() as db:
            extent = db.execute('SELECT min(ts),max(ts) FROM events WHERE root=?', (root_key,)).fetchone()
            lower = lower if lower is not None else extent[0] or 0
            upper = upper if upper is not None else extent[1] or lower
            upper = max(lower, upper)
            where, values = 'root=? AND ts>=? AND ts<=?', [root_key, lower, upper]
            counter_rows = db.execute('SELECT payload FROM events WHERE ' + where + " AND kind='counter' ORDER BY ts,ordinal", values).fetchall()
            snapshots = [json.loads(r[0]) for r in counter_rows]
            latest = snapshots[-1] if snapshots else (battle or {}).get('statistics', {}) or entry['latest']
            # Final counters can arrive after the end signal. Only accept a
            # snapshot explicitly associated with this battle's start anchor.
            final = (battle or {}).get('statistics') or {}
            if final.get('encounterClock', {}).get('startObservedAt') == clock.get('startObservedAt') and clock.get('startObservedAt'):
                latest = final
            identities = (read_json(root / 'identities.json', {}) or {}).get('names', [])
            identities = {r['idHash']: r.get('name', '') for r in identities if r.get('idHash')}
            actors = [{**a, 'name': identities.get(a.get('idHash')) or a.get('name') or '玩家 · ' + str(a.get('idHash', ''))[-6:]} for a in latest.get('actors', [])]
            stats = {r['kind']: r['n'] for r in db.execute('SELECT kind,count(*) n FROM events WHERE ' + where + ' GROUP BY kind', values)}
            # Settlements may arrive after the battle end signal. Require the stored battle anchor when available.
            details = []
            for r in db.execute('SELECT payload FROM events WHERE root=? AND kind=? ORDER BY ts DESC', (root_key, 'settlement')):
                item = json.loads(r[0])
                if battle and (item.get('encounterContext') or {}).get('startObservedAt') != clock.get('startObservedAt'):
                    continue
                details.append(item)
                break
            if kind != 'all':
                if kind not in set(self.streams.values()):
                    raise ValueError('未知事件类别')
                where += ' AND kind=?'; values.append(kind)
            else:
                where += " AND kind NOT IN ('counter','identity')"
            if actor:
                where += ' AND (actor=? OR target=?)'; values.extend([actor, actor])
            if search:
                where += ' AND (skill=? OR buff=?)'; values.extend([search, search])
            total = db.execute('SELECT count(*) FROM events WHERE ' + where, values).fetchone()[0]
            offset = max(0, int(offset))
            rows = db.execute('SELECT * FROM events WHERE ' + where + ' ORDER BY ts,stream,ordinal LIMIT 100 OFFSET ?', [*values, offset]).fetchall()
        events = [{'kind': r['kind'], 't': r['ts'] - lower, 'data': json.loads(r['payload'])} for r in rows]
        step = max(1, len(snapshots) // 300)
        points = [{'t': timestamp(s['observedAt']) - lower, 'damage': sum(a.get('damage', 0) for a in s['actors'])} for s in snapshots[::step]]
        if snapshots and (not points or points[-1]['t'] != timestamp(snapshots[-1]['observedAt']) - lower):
            points.append({'t': timestamp(snapshots[-1]['observedAt']) - lower, 'damage': sum(a.get('damage', 0) for a in snapshots[-1]['actors'])})
        duration = latest.get('timeCostSeconds') or (upper - lower if clock.get('startObservedAt') else None)
        return {'key': key, 'kind': 'battle' if battle else 'session', 'start': lower, 'end': upper, 'duration': duration,
                'clockBasis': 'server-summary' if latest.get('timeCostSeconds') else 'packet-reception' if duration else 'unknown',
                'actors': actors, 'identities': identities, 'counts': stats, 'points': points, 'events': events, 'totalEvents': total,
                'offset': offset, 'settlements': details, 'coverage': read_json(root / 'buff-coverage.json', {}),
                'health': entry['latest'].get('health', {}), 'indexing': more, 'skippedRows': errors,
                'notice': '网络观测记录；事件时间为本机接收时间。技能通知不等于完整施法，队友私有 Buff 与完整覆盖尚未验证。'}
