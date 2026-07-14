# -*- coding: utf-8 -*-
"""Export the extraction results as a board dataset for the web app.

Reads:  zones.json, check_results.json, hlabel_values.json, board_bbox.json
Writes: ../server/data/ux3607/{meta,zones,components}.json

The server's TS rules engine reclassifies components live from
(h, allowed, placeholder) — Python only decides zone membership.
"""
import sys, io, json, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'server', 'data', 'ux3607')
os.makedirs(OUT, exist_ok=True)

VIEWS = {'TOP_LIMIT': (40, 445, 345, 610), 'BOT_LIMIT': (445, 445, 800, 610)}

zones_raw = json.load(open(os.path.join(HERE, 'zones.json'), encoding='utf-8'))
results = json.load(open(os.path.join(HERE, 'check_results.json'), encoding='utf-8'))

# ---- zones: dedupe by (view, zone_id); min value wins (Dennis d1) ----
by_zone = {}
for z in zones_raw:
    if 'zone_id' not in z or not z.get('polygon'):
        continue
    key = (z['view'], z['zone_id'])
    rec = by_zone.get(key)
    if rec is None:
        by_zone[key] = {
            'view': z['view'], 'value': z['value'], 'polygon': z['polygon'],
            'areaMm2': z.get('area_mm2'), 'labels': [z['value']],
        }
    else:
        rec['labels'].append(z['value'])
        rec['value'] = min(rec['value'], z['value'])
zones = []
for i, ((view, zid), rec) in enumerate(sorted(by_zone.items())):
    zones.append({
        'id': f'{view[:3].lower()}-{zid}',
        'view': view,
        'value': rec['value'],
        'conflict': len(set(rec['labels'])) > 1,
        'labelValues': sorted(set(rec['labels'])),
        'areaMm2': rec['areaMm2'],
        'polygon': rec['polygon'],
    })

# explicit zones from Dennis's rulings (d2 IR boxes, d4 circle)
import math
def rect_poly(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
def circle_poly(cx, cy, r, n=24):
    return [[round(cx + r*math.cos(2*math.pi*k/n), 2),
             round(cy + r*math.sin(2*math.pi*k/n), 2)] for k in range(n)]
zones += [
    {'id': 'top-ir1', 'view': 'TOP_LIMIT', 'value': 0.85, 'conflict': False,
     'labelValues': [0.85], 'areaMm2': 18.1, 'explicit': True,
     'polygon': rect_poly(82.9, 532.4, 87.1, 536.7)},
    {'id': 'top-ir2', 'view': 'TOP_LIMIT', 'value': 0.85, 'conflict': False,
     'labelValues': [0.85], 'areaMm2': 17.2, 'explicit': True,
     'polygon': rect_poly(262.1, 527.6, 266.3, 531.7)},
    {'id': 'top-d4circle', 'view': 'TOP_LIMIT', 'value': 0, 'conflict': False,
     'labelValues': [0], 'areaMm2': 45.4, 'explicit': True,
     'polygon': circle_poly(74.48, 549.82, 3.8)},
]

# ---- components ----
components = []
for r in results:
    components.append({
        'id': r['id'],
        'footprint': r['footprint'],
        'side': 'top' if r['view'] == 'TOP_LIMIT' else 'bottom',
        'view': r['view'],
        'h': r['h'],
        'allowed': r['allowed'],          # zone H (min rule applied); null = no labelled zone
        'zoneConflict': r.get('conflict_zone', False),
        'placeholder': r['status'] == 'placeholder',
        'box': r['dxf_box'],              # [x0,y0,x1,y1] in DXF sheet mm
    })

meta = {
    'boardId': 'ux3607',
    'title': 'UX3607 NVL MB',
    'dxf': 'ux3607_nvl_mb_dxf_20260625.dxf',
    'stp': '0616_1839_top_and_bottom.stp',
    'board': {'width': 241.95, 'depth': 121.15, 'thickness': 0.776},
    'views': {v: list(bb) for v, bb in VIEWS.items()},
    'extractedAt': '2026-07-12',
    'decisionsApplied': [
        'd1: 同區多標註取較低 H 值',
        'd2: IR SENSOR 方框即 H=0.85 區',
        'd3: 跨線 H=0.5 屬細長條帶',
        'd4: 左條帶 H=0 僅限圓內',
        'd5: 板邊開放缺口不判定',
    ],
    'pendingDecisions': ['d6: H=0 大區語義(預設以獨立清單呈現)'],
    'registration': {
        'TOP_LIMIT': {'tx': -261.69, 'ty': 697.56, 'mirror': False},
        'BOT_LIMIT': {'tx': 1059.58, 'ty': 688.73, 'mirror': True},
        'accuracyMm': 1.0,
    },
}

json.dump(zones, open(os.path.join(OUT, 'zones.json'), 'w', encoding='utf-8'))
json.dump(components, open(os.path.join(OUT, 'components.json'), 'w', encoding='utf-8'))
json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print(f'zones: {len(zones)}, components: {len(components)} -> {OUT}')
