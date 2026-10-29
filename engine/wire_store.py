"""Indexed, paginated review of retained network observations; no capture here."""
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import threading
from datetime import datetime, timezone
from wire_ledger import ledger_path, fingerprint, iter_records, LedgerReader
from stars import Stars


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


def last_terminal(latest):
    return latest.get('health', {}).get('status') in ('stopped', 'invalid')


class IndexConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class WireStore:
    streams = {'statistics.jsonl': 'counter', 'damage-events.jsonl': 'hit', 'buff-events.jsonl': 'buff',
               'encounter-events.jsonl': 'boundary', 'identity-events.jsonl': 'identity',
               'settlement-details.jsonl': 'settlement', 'action-events.jsonl': 'action',
               'action-reprocessed.jsonl': 'action', 'buff-visibility.jsonl': 'buff'}

    def __init__(self, data, capture_root):
        self.data, self.root = Path(data), Path(capture_root).resolve()
        self.data.mkdir(parents=True, exist_ok=True)
        self.root.mkdir(parents=True, exist_ok=True)
        self.registry = self.data / 'capture-sources.json'
        self.stars = Stars(self.data)
        # v1 remains available to older clients; v2 never stores event JSON twice.
        self.dbpath = self.data / 'capture-index-v2.sqlite3'
        self.lock = threading.RLock()
        self.timeline_cache = {}
        with self.connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS streams(root TEXT,file TEXT,offset INTEGER,ordinal INTEGER,identity TEXT,tail TEXT,mtime INTEGER,size INTEGER,PRIMARY KEY(root,file));
            CREATE TABLE IF NOT EXISTS events(root TEXT,stream TEXT,ordinal INTEGER,ts REAL,kind TEXT,actor TEXT,target TEXT,skill TEXT,buff TEXT,block INTEGER,position INTEGER,length INTEGER,amount,transport INTEGER,invalidation INTEGER,PRIMARY KEY(root,stream,ordinal));
            CREATE INDEX IF NOT EXISTS capture_time ON events(root,ts);
            CREATE INDEX IF NOT EXISTS capture_kind ON events(root,kind,ts);''')

    def connect(self):
        db = sqlite3.connect(self.dbpath, timeout=30, factory=IndexConnection)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        return db

    def roots(self):
        roots = list(self.root.glob('sessions/*/capture'))
        for item in read_json(self.registry, []) or []:
            folder = Path(item)
            if (folder / 'latest.json').is_file() or ledger_path(folder, 'statistics.jsonl').is_file():
                roots.append(folder)
            if ledger_path(folder / 'capture', 'statistics.jsonl').is_file():
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
        if not ((folder / 'latest.json').is_file() or ledger_path(folder, 'statistics.jsonl').is_file()
                or ledger_path(folder / 'capture', 'statistics.jsonl').is_file()
                or list(folder.glob('sessions/*/capture/statistics.jsonl*')) or list(folder.glob('*/capture/statistics.jsonl*'))):
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
            decoded = [(file, read_json(file, {}) or {}) for file in battles]
            decoded.sort(key=lambda item: item[1].get('clock', {}).get('startObservedAt') or '')
            closed = (root / 'completion.json').is_file() or last_terminal(latest)
            for index, (file, battle) in enumerate(decoded):
                battle = self.battle_view(battle, superseded=index + 1 < len(decoded), closed=closed)
                if battle.get('clock', {}).get('startObservedAt'):
                    out.append({'key': self.key(file.parent), 'root': root, 'path': file.parent, 'battle': battle, 'latest': latest})
        return out

    @staticmethod
    def battle_view(battle, superseded=False, closed=False):
        """Repair legacy views from their own timer, without rewriting evidence."""
        clock = dict(battle.get('clock') or {})
        stat = dict(battle.get('statistics') or {})
        timer = stat.get('battleTimer') or {}
        start = clock.get('startObservedAt')
        start_time = timestamp(start)
        if start_time is None: return battle
        matching = start and timer.get('startObservedAt') == start
        status = battle.get('status')
        if matching and timer.get('phase') in ('ended', 'finalized', 'interrupted'):
            end = timestamp(timer.get('endObservedAt'))
            if not clock.get('endObservedAt') and end is not None and end >= start_time:
                clock.update(endObservedAt=timer['endObservedAt'], endReason=timer.get('endReason') or 'retained-timer')
                status = 'interrupted' if timer['phase'] == 'interrupted' else 'ended'
            if timer.get('phase') == 'finalized' and timer.get('durationSeconds', 0):
                stat['timeCostSeconds'] = timer['durationSeconds']
                if timer.get('finalActors'): stat['actors'] = timer['finalActors']
        if start and not clock.get('endObservedAt') and (superseded or closed):
            # An old unclosed attempt must never absorb the rest of a session.
            # This is a review bound, not a claimed server end or clear time.
            last = timestamp(stat.get('observedAt'))
            if last is not None and last >= start_time:
                clock.update(endObservedAt=stat['observedAt'], endReason='last-own-observation', endIncomplete=True)
                status = 'interrupted'
        if matching or stat.get('encounterClock', {}).get('startObservedAt') == start:
            stat['encounterClock'] = clock
        return dict(battle, clock=clock, statistics=stat, status=status)

    def find(self, key):
        result = next((e for e in self.entries() if e['key'] == key), None)
        if not result:
            raise ValueError('捕获记录不存在，请刷新战斗列表')
        return result

    def list(self):
        result = []
        starred = self.stars.ids('capture')
        for e in self.entries():
            b, last = e['battle'], e['latest']
            clock = (b or {}).get('clock', {})
            npc = (b or {}).get('statistics', {}).get('npcNo') or last.get('npcNo')
            templates = {n.get('npcTemplateNo') for n in (clock.get('identityContext') or {}).get('npcs', []) if n.get('npcTemplateNo')}
            result.append({'key': e['key'], 'parentKey': self.key(e['root']), 'kind': 'battle' if b else 'session',
                           'starred': e['key'] in starred,
                           'title': ('战斗' if b else '完整采集会话') + ' · ' + str(npc or '等待目标'), 'npcNo': npc,
                           'npcTemplateNo': next(iter(templates)) if len(templates) == 1 else None,
                           'startedAt': clock.get('startObservedAt') or (read_json(e['root'] / 'manifest.json', {}) or {}).get('startedAt') or last.get('observedAt'),
                           'endedAt': clock.get('endObservedAt'), 'mode': last.get('source', {}).get('mode', 'unknown'),
                           'status': (b or {}).get('status') or last.get('health', {}).get('status', 'unknown')})
        return sorted(result, key=lambda x: x['startedAt'] or '', reverse=True)

    def set_star(self, key, starred):
        entry = self.find(key)
        if not entry['battle']: raise ValueError('请选择一场分段战斗进行收藏')
        return self.stars.set('capture', key, starred)

    def star_latest(self):
        status = self.status()
        if not status['control'].get('binding') or not status['key']:
            raise ValueError('当前没有已绑定的采集会话，请在战斗记录中手动收藏')
        entries = [e for e in self.entries() if e['battle'] and self.key(e['root']) == status['key']]
        timer = status['latest'].get('battleTimer') or {}
        # Never star the preceding fight while the just-ended archive is being
        # published. A terminal timer identifies the exact expected attempt.
        if timer.get('phase') in ('ended', 'finalized', 'interrupted') and timer.get('startObservedAt'):
            entries = [e for e in entries if e['battle'].get('clock', {}).get('startObservedAt') == timer['startObservedAt']]
        entries = [e for e in entries if e['battle'].get('status') in ('ended', 'interrupted')
                   and timestamp(e['battle'].get('clock', {}).get('endObservedAt')) is not None
                   and not e['battle'].get('clock', {}).get('endIncomplete')]
        if not entries: raise ValueError('当前会话尚无已结束并保存的战斗，请稍后再试')
        entry = max(entries, key=lambda e: timestamp(e['battle']['clock']['endObservedAt']))
        return dict(self.stars.set('capture', entry['key'], True),
                    endedAt=entry['battle']['clock']['endObservedAt'])

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

    @staticmethod
    def tail_hash(path, offset):
        with path.open('rb') as stream:
            stream.seek(max(0, offset - 64))
            return hashlib.sha256(stream.read(min(offset, 64))).hexdigest()

    def sync(self, root):
        root_key, more, errors = self.key(root), False, 0
        with self.lock, self.connect() as db:
            rebuilt = ledger_path(root, 'action-reprocessed.jsonl').is_file()
            inactive = 'action-events.jsonl' if rebuilt else 'action-reprocessed.jsonl'
            if db.execute('DELETE FROM events WHERE root=? AND stream=?', (root_key, inactive)).rowcount:
                self.timeline_cache.clear()
            db.execute('DELETE FROM streams WHERE root=? AND file=?', (root_key, inactive))
            for file, kind in self.streams.items():
                if file == inactive: continue
                path = ledger_path(root, file)
                if not path.is_file():
                    if db.execute('DELETE FROM events WHERE root=? AND stream=?', (root_key, file)).rowcount:
                        self.timeline_cache.clear()
                    db.execute('DELETE FROM streams WHERE root=? AND file=?', (root_key, file))
                    continue
                old = db.execute('SELECT * FROM streams WHERE root=? AND file=?', (root_key, file)).fetchone()
                offset, ordinal = (old['offset'], old['ordinal']) if old else (0, 0)
                stat, identity = path.stat(), fingerprint(path)
                size = stat.st_size
                if old and (size < offset or identity != old['identity']
                            or self.tail_hash(path, offset) != old['tail']
                            or size == old['size'] and stat.st_mtime_ns != old['mtime']):
                    db.execute('DELETE FROM events WHERE root=? AND stream=?', (root_key, file))
                    self.timeline_cache.clear()
                    offset, ordinal = 0, 0
                consumed = 0
                for checkpoint, block, position, length, line in iter_records(path, offset):
                    offset = checkpoint; ordinal += 1; consumed += length
                    try:
                        row = json.loads(line)
                        ts = timestamp(row.get('observedAt'))
                        if ts is None or not math.isfinite(ts):
                            errors += 1; continue
                        # Keep the previous validation contract, without retaining
                        # a second serialized copy in SQLite.
                        json.dumps(row, allow_nan=False)
                        actor = row.get('sourceActorHash') or row.get('idHash') or ''
                        target = row.get('targetActorHash') or ''
                        skill = row.get('rawSkillId', row.get('skill_id'))
                        amount = row.get('amount')
                        if type(amount) not in (int, float): amount = None
                        transport = row.get('transportRecordOrdinal')
                        if type(transport) is not int: transport = None
                        # Use SQLite's JSON numeric conversion, as v1 did at
                        # query time, retaining integer/real precision exactly.
                        db.execute("INSERT OR REPLACE INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,json_extract(?,'$'),?,?)",
                                   (root_key, file, ordinal, ts, kind, actor, target,
                                    str(skill) if isinstance(skill, (str, int)) else '', str(row.get('buffNo') or ''),
                                    block, position, length, json.dumps(amount), transport, int(row.get('kind') == 'invalidation')))
                    except (ValueError, TypeError, AttributeError, OverflowError):
                        errors += 1
                more |= consumed >= 32 * 1024 * 1024 and offset < size
                if consumed: self.timeline_cache.clear()
                if offset < size and consumed < 32 * 1024 * 1024 and (root / 'completion.json').is_file():
                    errors += 1  # retain preceding frames, surface a torn closed tail
                db.execute('INSERT OR REPLACE INTO streams VALUES(?,?,?,?,?,?,?,?)',
                           (root_key, file, offset, ordinal, identity, self.tail_hash(path, offset), stat.st_mtime_ns, size))
        return more, errors

    def timeline(self, key, window=3):
        from wire_timeline import dps_curves, buff_intervals, action_rows, action_timing, boss_targets
        from combat import ROOT
        entry = self.find(key)
        if not entry['battle']:
            return {'requiresBattle': True, 'key': key, 'battles': [x for x in self.list() if x['kind'] == 'battle' and x['parentKey'] == key]}
        window = float(window)
        if not math.isfinite(window) or window < .5 or window > 30: raise ValueError('DPS 窗口须为 0.5—30 秒')
        root, battle = entry['root'], entry['battle']
        more, errors = self.sync(root)
        cache_key = (key, window)
        stamps = tuple((p.name, p.stat().st_size, p.stat().st_mtime_ns) for f in self.streams
                       for p in [ledger_path(root, f)] if p.exists())
        signature = (stamps, json.dumps(battle, sort_keys=True), more)
        cached = self.timeline_cache.get(cache_key)
        if not more and cached and cached[0] == signature: return cached[1]
        clock = battle.get('clock', {})
        lower = timestamp(clock.get('startObservedAt'))
        if lower is None: raise ValueError('这份记录没有有效的开战时间，请选择其他战斗')
        upper = timestamp(clock.get('endObservedAt'))
        root_key = self.key(root)
        with self.connect() as db, LedgerReader(root) as reader:
            if upper is None:
                upper = db.execute('SELECT max(ts) FROM events WHERE root=?', (root_key,)).fetchone()[0] or lower
            upper = max(lower, upper)
            snapshots = [reader.event(r) for r in db.execute("SELECT * FROM events WHERE root=? AND kind='counter' AND ts>=? AND ts<=? ORDER BY ts,ordinal", (root_key, lower - 5, upper))]
            # Do not draw a line from a previous encounter's retained counters.
            snapshots = [s for s in snapshots if not s.get('encounterClock', {}).get('startObservedAt') or s['encounterClock']['startObservedAt'] == clock['startObservedAt']]
            buffs = [reader.event(r) for r in db.execute("SELECT * FROM events WHERE root=? AND kind='buff' AND ts<=? ORDER BY ts,transport,CASE WHEN invalidation=1 THEN 0 ELSE 1 END,stream,ordinal", (root_key, upper))]
            actions = [(r['kind'], reader.event(r)) for r in db.execute("SELECT * FROM events WHERE root=? AND ((kind='action' AND ts<=?) OR (kind='hit' AND ts>=? AND ts<=?)) ORDER BY ts,transport,stream,ordinal", (root_key, upper, lower, upper))]
            boundaries = (reader.event(r) for r in db.execute("SELECT * FROM events WHERE root=? AND kind='boundary' AND ts>=? AND ts<=? ORDER BY ts,ordinal", (root_key, lower, upper)))
            catalog = read_json(ROOT / 'boss-entities.json', None) or read_json(ROOT.parent / 'collector/config/boss-entities.json', {})
            bosses = boss_targets(battle, boundaries, catalog)
            settlement = None
            for row in db.execute("SELECT * FROM events WHERE root=? AND kind='settlement' AND ts>=? AND ts<=? ORDER BY ts,ordinal", (root_key, upper, upper + 5)):
                detail = reader.event(row)
                if (detail.get('encounterContext') or {}).get('startObservedAt') == clock['startObservedAt'] and detail.get('timeCostSeconds', 0) > 0:
                    settlement = detail; break
        final = battle.get('statistics', {}) or {}
        if settlement:
            final = {'observedAt': settlement['observedAt'], 'encounterClock': clock,
                     'timeCostSeconds': settlement['timeCostSeconds'], 'npcNo': final.get('npcNo'),
                     'actors': [{'idHash': a['actorHash'], 'damage': a['totals']['damage']} for a in settlement['actors']]}
        if final.get('encounterClock', {}).get('startObservedAt') == clock['startObservedAt'] and timestamp(final.get('observedAt')) is not None and timestamp(final['observedAt']) > upper:
            # The final value is an endpoint; never extend the reception axis.
            final = dict(final, observedAt=datetime.fromtimestamp(upper, tz=timezone.utc).isoformat())
            snapshots.append(final)
        result = {'key': key, 'requiresBattle': False, 'duration': upper - lower,
                  'serverDuration': final.get('timeCostSeconds') or None,
                  'dps': dps_curves(snapshots, lower, upper, window),
                  'buffs': buff_intervals(buffs, lower, upper), 'actions': action_rows(actions, lower, upper),
                  'bossTargets': bosses,
                  'actionTiming': action_timing(actions, lower, upper),
                  'indexing': more, 'skippedRows': errors,
                  'notice': ('结束边界缺失，范围只到本段最后观测，不代表完整战斗时长。' if clock.get('endIncomplete') else '') + '横轴为本机接收时间，结算时长单独显示。Buff 为观测覆盖：条纹表示起止不完整；未观测到不等于没有。'}
        with self.lock:
            if len(self.timeline_cache) >= 8: self.timeline_cache.clear()
            self.timeline_cache[cache_key] = (signature, result)
        return result

    def report(self, key, actor='', kind='all', offset=0, search=''):
        entry = self.find(key); root = entry['root']; more, errors = self.sync(root)
        root_key, battle = self.key(root), entry['battle']
        clock = (battle or {}).get('clock', {})
        lower, upper = timestamp(clock.get('startObservedAt')), timestamp(clock.get('endObservedAt'))
        with self.connect() as db, LedgerReader(root) as reader:
            extent = db.execute('SELECT min(ts),max(ts) FROM events WHERE root=?', (root_key,)).fetchone()
            lower = lower if lower is not None else extent[0] or 0
            upper = upper if upper is not None else extent[1] or lower
            upper = max(lower, upper)
            where, values = 'root=? AND ts>=? AND ts<=?', [root_key, lower, upper]
            counter_rows = db.execute('SELECT * FROM events WHERE ' + where + " AND kind='counter' ORDER BY ts,ordinal", values).fetchall()
            snapshots = [reader.event(r) for r in counter_rows]
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
            # Aggregate the entire selected range, independently of the paginated
            # event list. Notifications are not casts or server final settlement.
            skill_where, skill_values = where + " AND kind='hit'", list(values)
            if actor:
                skill_where += ' AND (actor=? OR target=?)'; skill_values.extend([actor, actor])
            if search:
                skill_where += ' AND skill=?'; skill_values.append(search)
            observed_skills = [dict(row) for row in db.execute('''
                SELECT actor AS sourceActorHash,target AS targetActorHash,skill AS skillId,
                       count(*) AS notificationCount,
                       sum(amount) AS amount,
                       count(amount) AS measuredCount,
                       min(ts) AS firstObservedAt,max(ts) AS lastObservedAt
                FROM events WHERE ''' + skill_where + '''
                GROUP BY actor,target,skill ORDER BY amount DESC,notificationCount DESC''', skill_values)]
            for row in observed_skills:
                row['first'] = row.pop('firstObservedAt') - lower
                row['last'] = row.pop('lastObservedAt') - lower
            # Settlements may arrive after the battle end signal. Require the stored battle anchor when available.
            details = []
            for r in db.execute('SELECT * FROM events WHERE root=? AND kind=? ORDER BY ts DESC', (root_key, 'settlement')):
                item = reader.event(r)
                if battle and (item.get('encounterContext') or {}).get('startObservedAt') != clock.get('startObservedAt'):
                    continue
                details.append(item)
                break
            if battle and details and details[0].get('timeCostSeconds', 0) > 0:
                # Idle snapshots may lose a party member after the fight. The
                # anchored settlement remains the complete final roster/totals.
                latest = dict(latest, timeCostSeconds=details[0]['timeCostSeconds'])
                actors = [{'idHash': a['actorHash'], 'name': identities.get(a['actorHash']) or '玩家 · ' + a['actorHash'][-6:],
                           'damage': a['totals']['damage'], 'heal': a['totals']['heal'], 'absorbDmg': a['totals']['absorb_dmg']}
                          for a in details[0].get('actors', []) if a.get('actorHash') and a.get('totals')]
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
            events = [{'kind': r['kind'], 't': r['ts'] - lower, 'data': reader.event(r)} for r in rows]
        # Names may arrive after a hit. Resolve the retained ID against the
        # session's later authoritative name observation without rewriting raw logs.
        for event in events:
            data = event['data']
            data['sourceActorName'] = identities.get(data.get('sourceActorHash')) or data.get('sourceActorName')
            data['targetActorName'] = identities.get(data.get('targetActorHash')) or data.get('targetActorName')
        step = max(1, len(snapshots) // 300)
        points = [{'t': timestamp(s['observedAt']) - lower, 'damage': sum(a.get('damage', 0) for a in s['actors'])} for s in snapshots[::step]]
        if snapshots and (not points or points[-1]['t'] != timestamp(snapshots[-1]['observedAt']) - lower):
            points.append({'t': timestamp(snapshots[-1]['observedAt']) - lower, 'damage': sum(a.get('damage', 0) for a in snapshots[-1]['actors'])})
        duration = latest.get('timeCostSeconds') or (upper - lower if clock.get('startObservedAt') else None)
        return {'key': key, 'kind': 'battle' if battle else 'session', 'start': lower, 'end': upper, 'duration': duration,
                'clockBasis': 'server-summary' if latest.get('timeCostSeconds') else 'packet-reception' if duration else 'unknown',
                'actors': actors, 'identities': identities, 'counts': stats, 'points': points, 'events': events, 'totalEvents': total,
                'offset': offset, 'settlements': details, 'observedSkills': observed_skills, 'coverage': read_json(root / 'buff-coverage.json', {}),
                'health': entry['latest'].get('health', {}), 'indexing': more, 'skippedRows': errors,
                'notice': ('结束边界缺失，范围只到本段最后观测，不代表完整战斗时长。' if clock.get('endIncomplete') else '') + '网络观测记录；事件时间为本机接收时间。技能通知不等于完整施法，队友私有 Buff 与完整覆盖尚未验证。'}
