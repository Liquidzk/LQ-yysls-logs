"""Rank missing Buff names by real applications, excluding refresh inflation.

Produces a local aggregate report with no actor names, IDs or packet contents.
Usage: python tools/audit-buff-names.py --events path/to/buff-events.jsonl
       --catalog engine/name_catalog.json --output .local/buff-name-audit.json
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path


def audit(events, catalog):
    totals, operations = Counter(), defaultdict(Counter)
    for event in events:
        ident = event.get('buffNo')
        if type(ident) is not int or ident <= 0: continue
        ident = str(ident)
        totals[ident] += 1
        operations[ident][event.get('kind', 'unknown')] += 1
    names = catalog.get('names', {}).get('buffs', {})
    unresolved = catalog.get('unresolved', {}).get('buffs', {})
    rows = []
    for ident, count in totals.items():
        state = 'mapped' if ident in names else unresolved.get(ident, {}).get('status', 'pending')
        rows.append({'buffId': ident, 'name': names.get(ident), 'status': state,
                     'applications': operations[ident]['apply_candidate'],
                     'snapshots': operations[ident]['snapshot'], 'events': count,
                     'operations': dict(operations[ident])})
    rows.sort(key=lambda r: (-r['applications'], -r['events'], r['buffId']))
    return {'summary': {'distinctBuffs': len(rows), 'byStatus': dict(Counter(r['status'] for r in rows)),
                        'applications': sum(r['applications'] for r in rows),
                        'mappedApplications': sum(r['applications'] for r in rows if r['status'] == 'mapped')},
            'pending': [r for r in rows if r['status'] == 'pending'],
            'unnamed': [r for r in rows if r['status'] == 'unnamed'],
            'mapped': [r for r in rows if r['status'] == 'mapped']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--events', type=Path, required=True)
    parser.add_argument('--catalog', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    with args.events.open(encoding='utf-8') as stream:
        result = audit((json.loads(line) for line in stream if line.strip()),
                       json.loads(args.catalog.read_text('utf-8')))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', 'utf-8')
    print(json.dumps(result['summary'], ensure_ascii=False))
