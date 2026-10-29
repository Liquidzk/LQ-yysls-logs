"""Explicit review labels; original client names remain in provenance."""
def apply_display_names(catalog):
    key, name = '98752', '增伤（阴阳）'
    names = catalog.setdefault('names', {}).setdefault('buffs', {})
    evidence = catalog.setdefault('provenance', {}).setdefault('buffs', {})
    original = evidence.get(key, {})
    if original.get('resolution') == 'display_alias': return catalog
    evidence[key] = {**original, 'name': name, 'originalName': names.get(key, '增伤'),
                     'original': original, 'resolution': 'display_alias', 'label': '复盘显示别名'}
    names[key] = name
    return catalog
