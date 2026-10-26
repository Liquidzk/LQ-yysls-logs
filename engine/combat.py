"""CLv2 decoder and event-sourced combat report model. No game process access."""
from __future__ import annotations

import base64
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import zlib

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'vendor'))
import msgpack

SCHEMA = json.loads((ROOT / 'event_schema.json').read_text('utf-8'))
EVENT_NAMES = {int(k): v for k, v in SCHEMA['events'].items()}
KEY = b'netease_hex_xor_encrypt_key'
MAX_FRAME = 32 * 1024 * 1024
MAX_DECODED = 64 * 1024 * 1024


def digest(value):
    return hashlib.sha256(str(value).encode('utf-8')).hexdigest()[:20]


def actor_id(value):
    return 'a_' + digest(value) if value not in (None, '', 0, 'nil') else None


def finite(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def scalar(value):
    if value in ('nil', None):
        return None
    if value == 'true':
        return True
    if value == 'false':
        return False
    n = finite(value)
    if n is not None:
        return int(n) if n.is_integer() else n
    return value


def fields(text):
    """Diagnostic tostring top-level fields; never executes the input."""
    if isinstance(text, dict):
        return text
    if not isinstance(text, str) or not text.startswith('{') or not text.endswith('}'):
        return {}
    start, depth, parts = 1, 0, []
    for i in range(1, len(text) - 1):
        c = text[i]
        if c in '{[(':
            depth += 1
        elif c in '}])':
            depth -= 1
            if depth < 0:
                return {}
        elif c == ',' and depth == 0:
            parts.append(text[start:i]); start = i + 1
    if depth:
        return {}
    parts.append(text[start:-1])
    result = {}
    for p in parts:
        k, sep, v = p.partition(':')
        if sep:
            result[k.strip()] = v.strip()
    return result


def unpack_frame(frame):
    coded = base64.b64decode(frame, validate=True)
    compressed = bytes(v ^ KEY[i % len(KEY)] for i, v in enumerate(coded))
    dec = zlib.decompressobj()
    payload = dec.decompress(compressed, MAX_DECODED + 1)
    if len(payload) > MAX_DECODED or dec.unconsumed_tail or not dec.eof or dec.unused_data:
        raise ValueError('日志压缩块不完整或超过限制')
    return msgpack.unpackb(payload, raw=False, strict_map_key=False,
                           max_str_len=MAX_DECODED, max_bin_len=MAX_DECODED,
                           max_array_len=2000000, max_map_len=200000)


def read_log(raw, allow_partial=False):
    if raw[:4] != b'CLv2':
        raise ValueError('只支持 CLv2 战斗日志（.bin）')
    pos, blocks, complete = 4, [], True
    while pos < len(raw):
        if len(raw) - pos < 4:
            complete = False; break
        size = int.from_bytes(raw[pos:pos + 4], 'big')
        if size <= 0 or size > MAX_FRAME:
            raise ValueError('日志块长度无效')
        if pos + 4 + size > len(raw):
            complete = False; break
        blocks.append(unpack_frame(raw[pos + 4:pos + 4 + size]))
        pos += 4 + size
    if not complete and not allow_partial:
        raise ValueError('文件仍在写入或末尾不完整，请稍后重试')
    metadata, entries = {}, []
    for b in blocks:
        if not isinstance(b, list) or not b:
            raise ValueError('未知日志块结构')
        if b[0] == -3:
            if len(b) != 2 or not isinstance(b[1], dict):
                raise ValueError('会话元数据无效')
            metadata.update(b[1]); continue
        if b[0] == -2:
            _, base, symbols, rows = b
        elif b[0] == -1:
            _, symbols, rows = b; base = None
        else:
            base, symbols, rows = None, None, b
        for row in rows:
            if not isinstance(row, list) or len(row) < 4:
                raise ValueError('事件结构无效')
            if symbols is not None and (not isinstance(row[2], int) or not 1 <= row[2] <= len(symbols)):
                raise ValueError('实体索引无效')
            ts = finite(base + row[0] / 1000 if base is not None else row[0])
            if ts is None:
                raise ValueError('事件时间无效')
            entries.append((ts, row[1], symbols[row[2]-1] if symbols is not None else row[2],
                            EVENT_NAMES.get(row[3], f'unknown_{row[3]}'), row[4:]))
    if not metadata:
        raise ValueError('缺少会话元数据')
    return metadata, entries, complete


def normalize(raw, file_name, allow_partial=False):
    metadata, rows, complete = read_log(raw, allow_partial)
    identity = [metadata.get(k) for k in ('role_id', 'session_id', 'config_name', 'space_id')]
    sid = 's_' + digest(json.dumps(identity, ensure_ascii=False))
    local_candidates = {r[2] for r in rows if r[3] == 'skill_req'}
    local_raw = next(iter(local_candidates)) if len(local_candidates) == 1 else None
    local = actor_id(local_raw)
    actors = {}

    def register(raw_id, kind=None, no=None):
        aid = actor_id(raw_id)
        if aid:
            a = actors.setdefault(aid, {'id': aid, 'kind': 'unknown', 'entity_no': None,
                                        'is_observer': aid == local})
            if kind and kind != 'unknown':
                a['kind'] = kind
            if no is not None:
                a['entity_no'] = no
        return aid

    if local_raw:
        register(local_raw, 'player')
    events = []
    counts = Counter()
    for seq, (ts, frame, raw_actor, name, args) in enumerate(rows):
        aid = register(raw_actor)
        counts[name] += 1
        e = {'seq': seq, 'ts': ts, 'frame': frame, 'actor': aid, 'type': name}
        arg = args[0] if args else None
        if name == 'skill_state_change' and len(args) >= 2:
            e.update(skill=args[0], state=args[1], category='skill')
        elif name == 'apply_skill':
            d = fields(arg); skill = fields(d.get('skill_data', {}))
            e.update(skill=scalar(skill.get('skill_id')), target=register(skill.get('target_id')),
                     identifier=str(skill.get('identifier', '')), ready=scalar(d.get('skeleton_ready')),
                     category='skill', state='SYNC_OBSERVED')
        elif name == 'skill_req' and len(args) >= 3:
            e.update(slot=args[0], skill=args[1], error=args[2], category='input')
        elif name == 'skill_slot_down':
            d = fields(arg)
            e.update(category='input', skill=scalar(d.get('skill_id') or d.get('skill_no')), slot=d.get('slot_id'))
        elif name == 'skill_brk':
            e.update(category='skill', skill=args[0] if args else None,
                     reason=args[2] if len(args)>2 else None, by_skill=args[3] if len(args)>3 else None)
        elif name in ('add_buff', 'remove_buff', 'buff_level_change') and len(args) >= 3:
            e.update(category='buff', target=register(args[0]) or aid, source=register(args[1]),
                     buff=args[2], stacks=scalar(args[3]) if len(args)>3 else None)
        elif name == 'behit_began':
            d = fields(arg)
            kind = scalar(d.get('damage_type'))
            source = register(d.get('fromer_id'))
            fromer = str(d.get('fromer_entity', ''))
            if 'instof Avatar ' in fromer or 'instof PlayerAvatar ' in fromer:
                register(d.get('fromer_id'), 'player')
            elif 'instof Npc ' in fromer:
                register(d.get('fromer_id'), 'npc')
            e.update(category='heal' if kind == 2 else 'damage' if kind == 1 else 'hit',
                     source=source, target=register(d.get('target_id')) or aid,
                     amount=finite(d.get('damage')), damage_type=kind,
                     skill=scalar(d.get('skill_id')), calcpoint=scalar(d.get('calcpoint_id')),
                     attack_type=scalar(d.get('atk_type')), dead=scalar(d.get('self_is_dead')),
                     parsed=bool(d and 'damage' in d))
        elif name == 'hp_change' and len(args) >= 2:
            e.update(category='resource', resource='hp', old=finite(args[0]), value=finite(args[1]))
        elif name in ('zhenqi_change','naili_change') and len(args) >= 2:
            e.update(category='resource', resource='zhenqi' if name=='zhenqi_change' else 'naili',
                     old=finite(args[0]), value=finite(args[1]))
        elif name == 'entity_create' and len(args) >= 4:
            kind = 'npc' if args[3] == 'Npc' else 'player' if args[3] in ('Avatar','PlayerAvatar') else 'object'
            e.update(category='entity', target=register(args[0], kind, args[1]), entity_no=args[1], entity_class=args[3])
        elif name == 'entity_remove' and args:
            e.update(category='entity', target=register(args[0]))
        elif name == 'play_anim':
            d = fields(arg); e.update(category='animation', animation=d.get('anim_name'))
        elif name == 'state_change' and len(args) >= 2:
            e.update(category='state', old=args[0], value=args[1])
        elif name == 'trans_change' and args:
            nums = re.findall(r'-?\d+(?:\.\d+)?', str(args[0]))
            e.update(category='position', position=[float(x) for x in nums[:3]], yaw=args[1] if len(args)>1 else None)
        elif name in ('battle_start','on_disconnected','on_reconnected','enter_space'):
            e.update(category='boundary')
        else:
            # Original diagnostic payload remains in the archived .bin.
            e.update(category='diagnostic')
        events.append(e)
    events.sort(key=lambda e: (e['ts'], e['seq']))
    involvement, skills, given = Counter(), Counter(), Counter()
    for e in events:
        for aid in {e.get('actor'),e.get('source'),e.get('target')} - {None}:
            involvement[aid]+=1
        if e['category']=='skill':skills[e['actor']]+=1
        if e['type']=='add_buff':given[e.get('source')]+=1
    for a in actors.values():
        a['event_count'] = involvement[a['id']]
        a['skill_count'] = skills[a['id']]
        a['buff_given'] = given[a['id']]
    start = events[0]['ts'] if events else finite(metadata.get('start_ts')) or 0
    end = events[-1]['ts'] if events else start
    return {
        'schema':'yanyun-logs/1', 'id':sid, 'file_name':Path(file_name).name,
        'content_hash':hashlib.sha256(raw).hexdigest(), 'complete_file':complete,
        'config':metadata.get('config_name'), 'filter_id':metadata.get('filter_id'),
        'space_key':digest(metadata.get('space_id')) if metadata.get('space_id') else None,
        'observer':local, 'start':start, 'end':end, 'duration':end-start,
        'event_count':len(events), 'raw_event_counts':dict(counts),
        'actors':list(actors.values()), 'events':events, 'decoder_version':SCHEMA['version'],
        'coverage':{'initial_buffs':'unknown', 'outgoing_damage':'not_verified',
                    'team_actions':'partial', 'time_zero':'first_observed_event',
                    'clock':'client_logged_timestamp', 'runtime_schema':'unverified'},
    }


def merge_sessions(sessions, offsets=None):
    """Merge explicitly selected viewpoints; exact cross-view dedup only.

    Occurrence ranks preserve simultaneous repeated hits within one viewpoint.
    Near matches are retained because client receive clocks can differ.
    """
    if not sessions:
        raise ValueError('请选择至少一份日志')
    if len(sessions) > 12:
        raise ValueError('一次最多合并 12 个视角')
    offsets = offsets or {}
    filters = {s.get('filter_id') for s in sessions if s.get('filter_id')}
    if len(filters) > 1:
        raise ValueError('副本编号不同，不能合并为同一场战斗')
    if len(sessions)>1:
        starts = [s['start']+offsets.get(s['id'],0) for s in sessions]
        ends = [s['end']+offsets.get(s['id'],0) for s in sessions]
        if max(starts) > min(ends):
            raise ValueError('日志时间没有交集，请核对场次或调整各视角的时间偏移')
    actors, events, slots, duplicate_count = {}, [], {}, 0
    for session in sessions:
        for a in session['actors']:
            old = actors.setdefault(a['id'], dict(a))
            if a['kind'] != 'unknown': old['kind'] = a['kind']
            old['is_observer'] = old['is_observer'] or a['is_observer']
        occurrences = Counter()
        shift = offsets.get(session['id'],0)
        for original in session['events']:
            e = dict(original); e['ts'] += shift
            # Frame is local to the recording client; it is not a global event ID.
            sigdata = {k:v for k,v in e.items() if k not in ('seq','frame','ts')}
            # Keep sub-millisecond differences: similarity is not proof of identity.
            sigdata['ts'] = e['ts']
            sig = json.dumps(sigdata, sort_keys=True, ensure_ascii=False)
            rank = occurrences[sig]; occurrences[sig]+=1
            key = (sig, rank)
            if key in slots:
                slots[key]['views'].append(session['id']); duplicate_count+=1
            else:
                e['views']=[session['id']]; slots[key]=e; events.append(e)
    events.sort(key=lambda e:(e['ts'], e['views'][0], e['seq']))
    start = min(s['start']+offsets.get(s['id'],0) for s in sessions)
    end = max(s['end']+offsets.get(s['id'],0) for s in sessions)
    for i,e in enumerate(events):
        e['t']=round(e['ts']-start,6);e['id']=i
    report = {'schema':'yanyun-logs/1','start':start,'end':end,'duration':round(max(0,end-start),6),
              'actors':list(actors.values()),'events':events,'duplicate_count':duplicate_count,
              'sessions':[{k:v for k,v in s.items() if k not in ('actors','events')} for s in sessions],
              'offsets':offsets,'multi_view_uncertainty':len(sessions)>1,
              'time_zero':'first_observed_event','initial_buffs':'unknown'}
    report['buff_intervals']=buff_intervals(events,report['duration'])
    report['casts']=cast_intervals(events,report['duration'])
    return report


def buff_intervals(events,duration):
    opened, out = {}, []
    for e in events:
        if e['category']!='buff':continue
        key=(e.get('target'),e.get('source'),e.get('buff'))
        if e['type']=='remove_buff':
            item=opened.pop(key,None)
            if item:
                item.update(end=e['t'],end_known=True,end_event=e['id']);out.append(item)
            else:
                out.append({'target':key[0],'source':key[1],'buff':key[2],
                            'start':e['t'],'end':e['t'],'start_known':False,'end_known':True,
                            'stacks':[],'stack_events':[],'start_event':None,'end_event':e['id'],'ambiguous_refresh':False})
        else:
            if key not in opened:
                opened[key]={'target':key[0],'source':key[1],'buff':key[2],
                             'start':e['t'],'start_known':e['type']=='add_buff',
                             'start_event':e['id'],'end_event':None,
                             'end_known':False,'stacks':[],'stack_events':[],'ambiguous_refresh':False}
            elif e['type']=='add_buff':
                opened[key]['ambiguous_refresh']=True
            opened[key]['stacks'].append([e['t'],e.get('stacks')])
            opened[key]['stack_events'].append([e['id'],e.get('stacks')])
    for item in opened.values():
        item['end']=duration;out.append(item)
    return out


def cast_intervals(events,duration):
    current,out,active_buffs={},[],defaultdict(dict)
    def buff_counts(actor):
        return {'buffs_at_start':len(active_buffs[actor]),
                'external_buffs_at_start':sum(bool(source and source!=actor) for source,_ in active_buffs[actor])}
    for e in events:
        actor=e.get('actor')
        if e['category']=='buff':
            target=e.get('target');key=(e.get('source'),e.get('buff'))
            if e['type']=='remove_buff':active_buffs[target].pop(key,None)
            else:active_buffs[target][key]=e
        if e['type']=='skill_state_change':
            state=e.get('state')
            if state=='SKILL_START':
                if actor in current:
                    old=current.pop(actor);old.update(end=e['t'],end_event=e['id'],end_known=False);out.append(old)
                current[actor]={'id':'c_'+str(e['id']),'actor':actor,'skill':e.get('skill'),'start':e['t'],
                                'start_event':e['id'],'end_event':None,'phase_events':[e['id']],
                                'phases':[[e['t'],state]],'interrupt_events':[],
                                'interrupted':False,'kind':'cast',**buff_counts(actor)}
            elif actor in current:
                cur=current[actor]
                if e.get('skill') in (None,cur['skill']):
                    cur['phases'].append([e['t'],state])
                    cur['phase_events'].append(e['id'])
                    if state=='SKILL_LEAVE':
                        cur.update(end=e['t'],end_event=e['id'],end_known=True);out.append(cur);current.pop(actor)
        elif e['type']=='skill_brk' and actor in current:
            if e.get('skill')==current[actor]['skill']:
                current[actor]['interrupted']=True
                current[actor]['interrupt_events'].append(e['id'])
        elif e['type']=='apply_skill':
            out.append({'id':'c_'+str(e['id']),'actor':actor,'skill':e.get('skill'),'start':e['t'],'end':e['t'],
                        'start_event':e['id'],'end_event':e['id'],'phase_events':[],'interrupt_events':[],
                        'end_known':False,'kind':'sync','ready':e.get('ready'),'phases':[],**buff_counts(actor)})
    for cur in current.values():
        cur.update(end=duration,end_known=False);out.append(cur)
    return sorted(out,key=lambda x:x['start'])
