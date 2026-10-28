"""Replay timelines from retained observations, independent of event pagination."""
from collections import defaultdict
from datetime import datetime
import math


def ts(value):
    try: return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, AttributeError, TypeError): return None


def number(value):
    return type(value) in (float, int) and math.isfinite(value)


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
                       'identifier': data.get('identifierHash'), 'segment': data.get('segment')})
    return result
