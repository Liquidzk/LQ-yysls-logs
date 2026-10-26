"""Observed CLv2 records to Kagerou's display contract, never inferred raid DPS."""
import math


def actor_name(report, actor):
    ident=actor['id']
    name=report['names'].get('actors',{}).get(ident)
    if name:return name
    if actor.get('is_observer'):return '记录者 · '+ident[-4:]
    return '其他玩家 · '+ident[-4:]


def to_kagerou(report, start=0, end=None):
    end=report['duration'] if end is None else end
    if (any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in (start,end))
            or not 0<=start<=end<=report['duration']):raise ValueError('分析区间无效')
    span=end-start
    actors=[a for a in report['actors'] if a.get('is_observer') or a['kind']=='player']
    rows={a['id']:{'name':actor_name(report,a),'Job':'','yanyunActorId':a['id'],
        'damage':None,'encdps':None,'healed':None,'enchps':None,'damagetaken':None,
        'healstaken':None,'swings':None,'heals':None,'yanyunActions':0,'yanyunBuffs':0} for a in actors}
    records=0
    def add(ident,field,amount,count=None):
        if ident not in rows:return
        row=rows[ident];row[field]=(row[field] or 0)+amount
        if count:row[count]=(row[count] or 0)+1
    for e in report['events']:
        if not start<=e['t']<=end:continue
        src=e.get('source');target=e.get('target');amount=e.get('amount')
        if e['category'] in ('damage','heal') and isinstance(amount,(int,float)) and math.isfinite(amount) and amount>=0:
            if src in rows or target in rows:records+=1
            if e['category']=='damage':
                if src and target and src!=target:add(src,'damage',amount,'swings')
                add(target,'damagetaken',amount)
            else:
                add(src,'healed',amount,'heals');add(target,'healstaken',amount)
        if e['type']=='add_buff' and src in rows and target and src!=target:rows[src]['yanyunBuffs']+=1
    for c in report['casts']:
        if c['kind']=='cast' and c['actor'] in rows and start<=c['start']<=end:rows[c['actor']]['yanyunActions']+=1
    for row in rows.values():
        row['encdps']=row['damage']/span if row['damage'] is not None and span>0 else None
        row['enchps']=row['healed']/span if row['healed'] is not None and span>0 else None
    def total(key):
        values=[r[key] for r in rows.values() if r[key] is not None]
        return sum(values) if values else None
    damage=total('damage');heal=total('healed')
    for row in rows.values():
        row['damage%']=row['damage']/damage*100 if damage and row['damage'] is not None else None
        row['healed%']=row['healed']/heal*100 if heal and row['healed'] is not None else None
    scene=report['sessions'][0].get('filter_id')
    name=report['names'].get('scenes',{}).get(str(scene),f'场景 {scene}')
    return {'yanyunObserved':True,'isActive':'false',
        'Encounter':{'title':name,'CurrentZoneName':name,'duration':f'{int(span//60):02d}:{int(span%60):02d}',
                     'DURATION':span,'hits':records,'damage':damage,'healed':heal,
                     'encdps':damage/span if damage is not None and span>0 else None,
                     'enchps':heal/span if heal is not None and span>0 else None,'yanyunReportKey':report['key']},
        'Combatant':rows,'meta':{'mode':'archived-review','reportKey':report['key'],
            'revision':report['revision'],'from':start,'to':end,'players':len(rows),
            'multiView':report.get('multi_view_uncertainty',False),
            'notice':'已保存日志 · 仅统计已识别玩家；未取得 ≠ 0；区间每秒不是完整战斗 DPS。'}}
