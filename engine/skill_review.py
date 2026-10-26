"""Inspection of observed actions. Temporal overlap never proves damage attribution."""
from collections import defaultdict
import math


def union_seconds(segments):
    total,end=0.0,float('-inf')
    for start,stop in sorted(segments):
        if stop<=start:continue
        total+=max(0,stop-max(start,end));end=max(end,stop)
    return total


def review_cast(report,cast_id):
    cast=next((c for c in report['casts'] if c['id']==cast_id),None)
    if cast is None:raise ValueError('找不到这次动作，请重新打开战斗记录')
    start_id=cast['start_event'];end_id=cast['end_event']
    stop_id=end_id if end_id is not None else len(report['events'])
    actor=cast['actor'];duration=max(0,cast['end']-cast['start'])
    groups={}
    for b in report['buff_intervals']:
        if b['target']!=actor or b['start_event'] is None:continue
        active=b['start_event']<start_id and (b['end_event'] is None or b['end_event']>start_id)
        overlap=b['start_event']<stop_id and (b['end_event'] is None or b['end_event']>start_id)
        if not active and (cast['kind']=='sync' or not overlap):continue
        key=(b['source'],b['buff'])
        g=groups.setdefault(key,{'buff':b['buff'],'source':b['source'],'target':actor,
            'external':bool(b['source'] and b['source']!=actor),'active_at_start':False,
            'stacks_at_start':None,'partial':False,'segments':[]})
        if active:
            g['active_at_start']=True
            prior=[stack for event_id,stack in b['stack_events'] if event_id<start_id]
            g['stacks_at_start']=prior[-1] if prior else None
        g['partial']|=not b['start_known'] or not b['end_known'] or b['ambiguous_refresh']
        g['segments'].append([max(cast['start'],b['start']),min(cast['end'],b['end'])])
    buffs=[]
    for g in groups.values():
        g['seconds']=round(union_seconds(g.pop('segments')),6)
        g['coverage']=g['seconds']/duration if duration>0 else None
        g['partial']|=not cast['end_known']
        buffs.append(g)
    buffs.sort(key=lambda b:(not b['active_at_start'],not b['external'],str(b['buff']),str(b['source'])))
    window=[e for e in report['events'] if start_id<=e['id']<stop_id] if cast['kind']=='cast' else []
    # Exact skill IDs are kept separate: child skills and delayed hits cannot be
    # assigned to a particular cast from these logs alone.
    matches=[e for e in window if actor and e.get('source')==actor and e.get('skill')==cast['skill']
             and isinstance(cast['skill'],(int,float)) and cast['skill']>0
             and e['category'] in ('damage','heal') and isinstance(e.get('amount'),(int,float))
             and math.isfinite(e['amount']) and e['amount']>=0
             and (e['category']=='heal' or e.get('target') and e['target']!=actor)]
    def metric(category):
        found=[e for e in matches if e['category']==category]
        value=sum(e['amount'] for e in found) if found else None
        return {'amount':value,'records':len(found),
                'per_second':value/duration if value is not None and cast['end_known'] and duration>0 else None}
    players={a['id'] for a in report['actors'] if a['kind']=='player' or a.get('is_observer')}
    peers=[c['id'] for c in report['casts'] if c['kind']=='cast' and c['actor'] in players and c['actor']!=actor
           and c['start_event']<start_id and (c['end_event'] is None or c['end_event']>start_id)]
    nearby=[e['id'] for e in report['events'] if cast['start']-2<=e['t']<=cast['end']+2
            and e['category'] in ('skill','buff','damage','heal','resource','boundary')
            and (actor and actor in (e.get('actor'),e.get('source'),e.get('target'))
                 or e['category']=='skill' and e.get('actor') in players)]
    siblings=[c['id'] for c in report['casts'] if c['actor']==actor and c['kind']==cast['kind']]
    index=siblings.index(cast_id)
    return {'cast':cast,'buffs':buffs,'peers':peers,'damage':metric('damage'),'heal':metric('heal'),
            'matching_events':[e['id'] for e in matches], 'nearby_events':nearby[:200],
            'nearby_total':len(nearby),'initial_buffs_unknown':True,
            'multi_view_uncertainty':report.get('multi_view_uncertainty',False),
            'previous':siblings[index-1] if index else None,
            'next':siblings[index+1] if index+1<len(siblings) else None,
            'report_revision':report['revision']}


def current_name_coverage(report,names,unresolved):
    """Coverage of the opened report, including IDs first seen after catalog build."""
    ids={k:defaultdict(int) for k in ('skills','buffs','scenes','npcs')}
    for e in report['events']:
        for kind,field in (('skills','skill'),('buffs','buff')):
            if e.get(field) is not None:ids[kind][str(e[field])]+=1
    for s in report['sessions']:
        if s.get('filter_id') is not None:ids['scenes'][str(s['filter_id'])]+=1
    for a in report['actors']:
        if a.get('entity_no') is not None:ids['npcs'][str(a['entity_no'])]+=1
    summary={};missing={k:dict(v) for k,v in unresolved.items()}
    for kind,counts in ids.items():
        s={'observed_total':len(counts),'observed_mapped':0,'observed_unnamed':0,
           'observed_pending':0,'observed_placeholders':0,'event_occurrences':sum(counts.values()),'mapped_event_occurrences':0}
        for ident,count in counts.items():
            if ident in names.get(kind,{}):
                s['observed_mapped']+=1;s['mapped_event_occurrences']+=count;continue
            entry=missing.setdefault(kind,{}).get(ident)
            if entry is None:
                placeholder=ident.lstrip('-').isdigit() and int(ident)<=0
                entry={'status':'placeholder' if placeholder else 'pending',
                       'reason':'日志占位编号，没有对应名称' if placeholder else '本场出现的编号尚未收录，名称待核对'}
                missing[kind][ident]=entry
            status=entry.get('status','pending')
            s[{'unnamed':'observed_unnamed','placeholder':'observed_placeholders'}.get(status,'observed_pending')]+=1
        summary[kind]=s
    return summary,missing
