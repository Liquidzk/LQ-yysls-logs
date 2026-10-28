"""Build names from decoded local client tables and exact localization keys.

Inputs are private extraction products, never distributed. The output contains
only display names, their ID/field provenance and unresolved classifications.
No numeric-prefix, icon-filename or fuzzy-text matching is permitted.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re


def build(documents, locale, observed=None):
    tables = {k: v['rows'] for k, v in documents.items()}
    names = {k: {} for k in ('skills', 'buffs', 'scenes', 'npcs', 'actors')}
    evidence = {k: {} for k in names}
    unresolved = {k: {} for k in names if k != 'actors'}

    def resolve(table, ident, fields):
        row = tables.get(table, {}).get(ident, {})
        if row.get('deleted'): return None
        values = row.get('values', {})
        for field in fields:
            value = values.get(field)
            key = str(value % (1 << 64)) if type(value) is int else None
            if key:
                value = locale.get(key, {})
                value = value.get('text') if isinstance(value, dict) else value
            if not isinstance(value, str): continue
            value = value.strip()
            if not value or len(value) > 120 or '\ufffd' in value or any(ord(c) < 32 for c in value): continue
            # Resource color markers are formatting, not part of a display name.
            value = re.sub(r'#[A-Z]', '', value)
            return value, {'table': table, 'row': ident, 'field': field, 'text_key': key,
                           'resolution': 'ui_label' if field in ('ui_name', 'btn_name') else 'name',
                           'label': '客户端中文资源' if key else '客户端配置原文', 'name': value}

    specs = [('skills', 'skills', ('name', 'ui_name', 'btn_name')),
             ('buffs', 'buff', ('buff_name',)), ('scenes', 'space_info', ('name', 'fb_name')),
             ('npcs', 'entity', ('recount_name', 'target_name'))]
    for kind, table, fields in specs:
        for ident, row in tables.get(table, {}).items():
            result = resolve(table, ident, fields)
            if kind == 'npcs':
                billboard = row.get('values', {}).get('billboard_id')
                result = resolve('entity_billboard', str(billboard), ('name',)) or result
            if result: names[kind][ident], evidence[kind][ident] = result
            else:
                values = row.get('values', {})
                # A partially decoded row cannot prove absence of a name.
                parent_pending = kind == 'skills' and str(values.get('skill_main_id', ident)) != ident
                status = 'pending' if row.get('error') or row.get('unresolved_headers') or parent_pending or any(values.get(f) for f in fields) else 'unnamed'
                unresolved[kind][ident] = {'status': status, 'reason': '名称文本待恢复' if status == 'pending' else '客户端未设置显示名'}
    for _ in range(16):
        changed = False
        for ident, row in tables.get('skills', {}).items():
            if ident in names['skills']: continue
            parent = str(row.get('values', {}).get('skill_main_id', ''))
            if parent not in names['skills'] or evidence['skills'][parent]['resolution'] == 'ui_label': continue
            names['skills'][ident] = names['skills'][parent]
            evidence['skills'][ident] = {'table': 'skills', 'row': ident, 'field': 'skill_main_id', 'via': parent,
                                        'name': names['skills'][parent], 'resolution': 'main_skill', 'label': '主技能名称（保留动作编号）'}
            unresolved['skills'].pop(ident, None); changed = True
        if not changed: break
    summary = {}
    for kind in unresolved:
        ids = (observed or {}).get(kind, {})
        for ident in ids:
            if ident in names[kind] or ident in unresolved[kind]: continue
            placeholder = ident.lstrip('-').isdigit() and int(ident) <= 0
            unresolved[kind][ident] = {'status': 'placeholder' if placeholder else 'pending',
                                      'reason': '日志未填写编号' if placeholder else '当前配置未恢复此编号'}
        positive = {k: v for k, v in ids.items() if k.isdigit() and int(k) > 0}
        summary[kind] = {'catalog_total': len(names[kind]), 'observed_total': len(positive),
                         'observed_mapped': sum(k in names[kind] for k in positive),
                         'event_occurrences': sum(positive.values()),
                         'mapped_event_occurrences': sum(v for k, v in positive.items() if k in names[kind]),
                         'unresolved_types': dict(Counter(unresolved[kind][k]['status'] for k in positive if k not in names[kind]))}
    return {'version': 2, 'generated_at': datetime.now(timezone.utc).isoformat(),
            'scope': '当前客户端全表配置；技能子编号仅通过明确的主技能字段继承',
            'names': names, 'provenance': evidence, 'unresolved': unresolved, 'summary': summary,
            'rules': ['只按精确文本编号关联中文名；无名称、未恢复和占位编号分别标记。',
                      '不根据编号前缀、图标文件名或相似文字猜测名称。']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rows', required=True, type=Path)
    parser.add_argument('--locale', required=True, nargs='+', type=Path)
    parser.add_argument('--observed', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    read = lambda p: json.loads(p.read_text('utf-8'))
    locale = {}
    for file in args.locale: locale.update(read(file))
    result = build(read(args.rows), locale, read(args.observed) if args.observed else {})
    result['inputs'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [args.rows, *args.locale]}
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    print(json.dumps(result['summary'], ensure_ascii=False, indent=2))
