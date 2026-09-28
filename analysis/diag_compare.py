"""比較兩次 extract 的結果(標註讀值率、區域數、零件是否有限高、對位參數)。
用法: py diag_compare.py <dirA> <dirB>
"""
import json, os, sys, collections

def load(d):
    g = lambda n: json.load(open(os.path.join(d, n), encoding='utf-8'))
    return g('meta.json'), g('zones.json'), g('labels.json'), g('components.json')

def stats(d):
    meta, zones, labels, comps = load(d)
    zval = {}
    for l in labels:
        if l.get('zoneId') and l['value'] is not None:
            zval.setdefault(l['zoneId'], []).append(l['value'])
    zone_value = {k: min(v) for k, v in zval.items()}
    lab_zone = {l['zoneId'] for l in labels if l.get('zoneId')}
    judged = sum(1 for c in comps if c.get('zoneId') in zone_value)
    return {
        'zones': len(zones),
        'zones_面積>=100': sum(1 for z in zones if (z.get('areaMm2') or 0) >= 100),
        'zones_有H值': sum(1 for z in zones if z['id'] in zone_value),
        'zones_無標註': sum(1 for z in zones if z['id'] not in lab_zone),
        'labels': len(labels),
        'labels_自動讀出': sum(1 for l in labels if l['value'] is not None),
        'labels_待人工': sum(1 for l in labels if l['value'] is None),
        'labels_未關聯到區': sum(1 for l in labels if not l.get('zoneId')),
        '零件總數': len(comps),
        '零件_有區': sum(1 for c in comps if c.get('zoneId')),
        '零件_有限高': judged,
        'reg': {v: (r['mirror'], r['tx'], r['ty'], r['fitErrMm']) for v, r in meta['registration'].items() if isinstance(r, dict)},
        'flagged_reads': collections.Counter(l['read'] for l in labels if l['value'] is None).most_common(8),
    }

a, b = stats(sys.argv[1]), stats(sys.argv[2])
keys = [k for k in a if k not in ('reg', 'flagged_reads')]
w = max(len(k) for k in keys)
print(f'{"":{w}}  {"舊":>8}  {"新":>8}   差')
for k in keys:
    d = b[k] - a[k]
    print(f'{k:{w}}  {a[k]:>8}  {b[k]:>8}   {d:+d}' if isinstance(a[k], int) else f'{k:{w}}  {a[k]}  {b[k]}')
print('\n對位(mirror, tx, ty, fitErrMm)')
for v in a['reg']:
    print(f'  {v}\n    舊 {a["reg"][v]}\n    新 {b["reg"].get(v)}')
print('\n待人工讀值 舊:', a['flagged_reads'])
print('待人工讀值 新:', b['flagged_reads'])
