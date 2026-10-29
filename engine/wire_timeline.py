"""Replay timelines from retained observations, independent of event pagination."""
from collections import defaultdict
from datetime import datetime
import math


def ts(value):
    try: return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, AttributeError, TypeError): return None


def number(value):
    return type(value) in (float, int) and math.isfinite(value)


def boss_targets(battle, events, catalog):
    """Only exact known Boss templates; adds and unknown NPCs stay separate."""
    targets = {}
    def add(row):
        ident, template = row.get('actorHash'), row.get('npcTemplateNo')
        meta = catalog.get('entities', {}).get(str(template))
        if ident and meta and ':' not in ident:
            targets[ident] = {'actorHash': ident, 'npcTemplateNo': template,
                              'group': meta.get('group'), 'role': meta.get('role')}
    clock, stat = battle.get('clock', {}), battle.get('statistics', {})
    for row in (clock.get('identityContext') or {}).get('npcs', []): add(row)
    if stat.get('encounterClock', {}).get('startObservedAt') == clock.get('startObservedAt'):
        for row in (stat.get('bossHealth') or {}).get('rows', []): add(row)
    for event in events:
        if event.get('kind') == 'npc-health' and event.get('available'): add(event)
        elif event.get('kind') == 'encounter-identity' and event.get('spaceHash') == clock.get('spaceHash'):
            for row in event.get('npcs', []): add(row)
    return sorted(targets.values(), key=lambda r: (str(r['group'] or r['npcTemplateNo']), r['role'] != 'body', r['actorHash']))


def dps_curves(snapshots, start, end, window=3):
    """Uniform rate between cumulative snapshots; rolling window integral.

    First positive counters without a zero baseline, resets, roster gaps and
    snapshot gaps >5s are unknown. They are never turned into damage spikes.
    """
    span = max(0, end - start)
    window = min(30, max(.5, float(window)))
    segments, prior = defaultdict(list), {}
    last_npc = None
    # Last snapshot at an identical reception timestamp supersedes earlier
    # counters at that timestamp, including a final post-stop correction.
    unique = {ts(s.get('observedAt')): s for s in snapshots if ts(s.get('observedAt')) is not None}
    for at, snapshot in sorted(unique.items()):
        at = ts(snapshot.get('observedAt'))
        if at is None or at > end: continue
        npc = snapshot.get('npcNo')
        if last_npc is not None and npc != last_npc: prior.clear()
        last_npc = npc
        present = set()
        step_parts = []
        for actor in snapshot.get('actors', []):
            ident, damage = actor.get('idHash'), actor.get('damage')
            if not ident or not number(damage) or damage < 0: continue
            present.add(ident)
            previous = prior.get(ident)
            if previous:
                before, value = previous
                if 0 < at - before <= 5 and damage >= value:
                    left, right = max(start, before), min(end, at)
                    if right > left:
                        part = (left - start, right - start, (damage - value) / (at - before))
                        segments[ident].append(part); step_parts.append(part)
                # Equal-time packets do not erase an unallocated delta.
                if at == before and damage >= value: continue
            prior[ident] = (at, damage)
        # Membership changes make the transition unknown, but do not erase
        # the entire fight's team curve before/after the transition.
        if present == set(prior) and len(step_parts) == len(present) and len({(a,b) for a,b,_ in step_parts}) == 1:
            a,b,_ = step_parts[0]
            segments['__team__'].append((a,b,sum(p[2] for p in step_parts)))
        prior = {k: v for k, v in prior.items() if k in present}
    # A bounded number of chart points, but every snapshot contributes to them.
    step = max(.5, span / 1200)
    times = [round(i * step, 6) for i in range(int(span / step) + 1)]
    if not times or times[-1] < span: times.append(span)
    series = {}
    for ident, parts in segments.items():
        points = []
        cursor = 0
        for at in times:
            left = max(0, at - window); width = at - left
            while cursor < len(parts) and parts[cursor][1] <= left: cursor += 1
            amount = covered = 0.0
            for a, b, rate in parts[cursor:]:
                if a >= at: break
                overlap = max(0, min(at, b) - max(left, a))
                covered += overlap; amount += overlap * rate
            points.append(amount / width if width > 0 and covered >= width - 1e-5 else None)
        series[ident] = points
    team = series.pop('__team__', [None] * len(times))
    return {'times': times, 'team': team, 'actors': series, 'window': window,
            'basis': '服务器累计伤害差分；快照间按均匀速率分配，滑动窗口平均。缺失或重置区间断线。'}


def buff_intervals(events, start, end):
    active, spans = {}, []

    def close(key, at, reason):
        old = active.pop(key, None)
        if old is None: return
        a, b = max(start, old['at']), min(end, at)
        if b <= a: return
        spans.append({'buffId': old['buffId'], 'actor': old['actor'], 'source': old['source'],
                      'start': a - start, 'end': b - start, 'stacks': old['stacks'],
                      'leftUnknown': old['leftUnknown'] or old['at'] < start,
                      'rightUnknown': reason in ('range-end', 'invalidation'), 'endReason': reason,
                      'visibility': old['visibility'], 'instance': key[2]})

    for event in events:
        at = ts(event.get('observedAt'))
        if at is None or at > end: continue
        actor = event.get('targetActorHash')
        if event.get('kind') == 'invalidation':
            for key in list(active):
                if not actor or key[0] == actor: close(key, at, 'invalidation')
            continue
        ident, instance = event.get('buffNo'), event.get('buffInstanceHash')
        if not actor or not instance: continue
        key = (actor, event.get('bag'), instance)
        kind = event.get('kind')
        if kind == 'remove_candidate': close(key, at, 'observed-remove'); continue
        if kind not in ('apply_candidate', 'snapshot', 'update', 'field_patch'): continue
        if ident is None: continue
        old = active.get(key)
        value = {'at': at, 'buffId': str(ident), 'actor': actor, 'source': event.get('sourceActorHash'),
                 'stacks': event.get('charge_level', event.get('level')), 'visibility': event.get('visibility', ''),
                 'leftUnknown': kind != 'apply_candidate'}
        if old:
            if all(old[k] == value[k] for k in ('buffId', 'source', 'stacks')) and kind not in ('apply_candidate', 'snapshot'): continue
            close(key, at, 'observed-change')
            value['leftUnknown'] = False
        active[key] = value
    for key in list(active): close(key, end, 'range-end')
    groups = defaultdict(list)
    for row in spans: groups[(row['actor'], row['buffId'])].append(row)
    lanes = []
    duration = max(0, end - start)
    for (actor, ident), rows in groups.items():
        union = []
        for row in sorted(rows, key=lambda x: x['start']):
            if union and row['start'] <= union[-1][1]: union[-1][1] = max(union[-1][1], row['end'])
            else: union.append([row['start'], row['end']])
        covered = sum(b - a for a, b in union)
        lanes.append({'actor': actor, 'buffId': ident, 'intervals': rows, 'union': union,
                      'coveredSeconds': covered, 'coverage': covered / duration if duration else None})
    return lanes


def action_rows(events, start, end):
    result = []
    for kind, data in events:
        at = ts(data.get('observedAt'))
        if at is None or not start <= at <= end: continue
        result.append({'t': at - start, 'actor': data.get('sourceActorHash'), 'target': data.get('targetActorHash'),
                       'skillId': data.get('rawSkillId'), 'kind': data.get('actionKind', 'hit') if kind == 'action' else 'hit',
                       'amount': data.get('amount'), 'sequence': data.get('sequence'),
                       'record': data.get('transportRecordOrdinal'), 'subIndex': data.get('syncSubIndex'),
                       'identifier': data.get('identifierHash'), 'segment': data.get('segment'),
                       'endReason': data.get('endReason')})
    return result


def action_timing(events, start, end):
    """Pair observed queue instances; gaps are review candidates, never movement.

    Replacements, AOI loss and range ends truncate uncertain spans. A hit does
    not end a cast. Old captures without end observations stay uncertain.
    """
    active, last_end, spans, gaps = {}, {}, [], []
    epoch = defaultdict(int)

    def close(slot, at, known, reason):
        row = active.pop(slot, None)
        if row is None: return
        known = bool(known and at >= row['at'])
        if at >= start and row['at'] <= end:
            a, b = max(start, row['at']), min(end, at)
            start_known = row['startKnown'] and row['at'] >= start
            end_known = known and at <= end
            spans.append({'actor': row['actor'], 'skillId': row['skillId'], 'identifier': row['identifier'],
                          'start': a-start, 'end': b-start, 'startKnown': start_known, 'endKnown': end_known,
                          'duration': at-row['at'] if start_known and end_known else None,
                          'observedSeconds': max(0,b-a), 'endReason': reason,
                          'target': row['target'], 'record': row['record'], 'epoch': epoch[row['actor']],
                          'gapBefore': row['gapBefore'], 'phases': row['phases']})
        if known: last_end[slot] = (at, row['skillId'])
        else: last_end.pop(slot, None)

    ordered = sorted(enumerate(events), key=lambda item: (ts(item[1][1].get('observedAt')) or 0,
        item[1][1].get('transportRecordOrdinal') or 0, item[0]))
    for _, (kind, data) in ordered:
        if kind != 'action': continue
        at = ts(data.get('observedAt'))
        if at is None or at > end: continue
        actor, action = data.get('sourceActorHash'), data.get('actionKind')
        if action == 'visibility':
            affected = {k[0] for k in set(active)|set(last_end)} if not actor else {actor}
            for slot in list(active):
                if slot[0] in affected: close(slot, at, False, data.get('endReason') or 'visibility')
            for slot in list(last_end):
                if slot[0] in affected: last_end.pop(slot)
            for who in affected: epoch[who] += 1
            continue
        if not actor: continue
        slot = (actor, data.get('queue') or 'skill')
        ident, skill = data.get('identifierHash'), data.get('rawSkillId')
        current = active.get(slot)
        if action in ('cast', 'snapshot'):
            if current and ident and ident == current['identifier'] and skill == current['skillId']: continue
            ambiguous = bool(current and current['skillId'] == skill)
            if current: close(slot, at, False, 'next-action')
            gap = None
            previous = last_end.pop(slot, None)
            if action == 'cast' and previous and start <= previous[0] <= at:
                gap = at-previous[0]
                if gap > 1e-6:
                    gaps.append({'actor': actor, 'start': previous[0]-start, 'end': at-start,
                                 'duration': gap, 'previousSkill': previous[1], 'nextSkill': skill})
            active[slot] = {'actor': actor, 'skillId': skill, 'identifier': ident, 'at': at,
                            'startKnown': action == 'cast', 'target': data.get('targetActorHash'),
                            'record': data.get('transportRecordOrdinal'), 'gapBefore': gap,
                            'ambiguous': ambiguous, 'phases': []}
        elif action in ('end','boundary') and current:
            matches = skill == current['skillId'] and (not ident or ident == current['identifier'])
            if matches:
                known = action == 'end' and data.get('endConfirmed') is not False and (bool(ident) or not current['ambiguous'])
                close(slot, at, known, data.get('endReason') or 'server-skill-end')
        elif action == 'segment' and current and skill == current['skillId'] and at >= start:
            current['phases'].append({'t': at-start, 'segment': data.get('segment')})
    for slot in list(active): close(slot, end, False, 'range-end')
    spans.sort(key=lambda r:(r['start'],r['record'] or 0,r['actor']))
    counts = defaultdict(int)
    for row in spans:
        counts[row['actor']] += 1
        row['order'] = counts[row['actor']]
        row['id'] = row['actor'] + ':' + str(row['order'])
    summaries = {}
    for actor, count in counts.items():
        rows = [r for r in spans if r['actor'] == actor]
        pauses = [r['duration'] for r in gaps if r['actor'] == actor]
        summaries[actor] = {'actions': count, 'completeActions': sum(r['duration'] is not None for r in rows),
                            'observedActionSeconds': sum(r['duration'] or 0 for r in rows),
                            'gapSeconds': sum(pauses), 'gapCount':len(pauses), 'longestGap':max(pauses,default=0)}
    return {'spans':spans,'gaps':gaps,'actors':summaries,
            'basis':'同步动作从队列建立到同一条目移除，使用收包时间；不等同客户端动画帧或前后摇。条纹表示起止不完整。空档只表示相邻动作之间未观测到技能占用，需结合机制、走位与命中复查。'}
