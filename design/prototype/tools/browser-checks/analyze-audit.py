#!/usr/bin/env python3
"""Pixel contrast audit (AT-21): measures text against the pixels actually rendered behind it."""
import json, re, sys
import numpy as np
from PIL import Image

import os
ROOT = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get('SHOTS_DIR', '')).rstrip('/') + '/'
index = json.load(open(ROOT + 'audit/index.json'))
THRESH = 4.5

def parse_color(s):
    s = s.strip()
    m = re.match(r'rgba?\(([^)]+)\)', s)
    if m:
        p = [float(x) for x in re.split(r'[\s,/]+', m.group(1).strip()) if x]
        return p[0], p[1], p[2], (p[3] if len(p) > 3 else 1.0)
    m = re.match(r'color\(srgb ([^)]+)\)', s)
    if m:
        p = [float(x) for x in re.split(r'[\s/]+', m.group(1).strip()) if x]
        return p[0] * 255, p[1] * 255, p[2] * 255, (p[3] if len(p) > 3 else 1.0)
    raise ValueError('unsupported colour: ' + s)

def lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def lum(rgb):  # rgb: (...,3) array 0..255
    l = lin(rgb)
    return 0.2126 * l[..., 0] + 0.7152 * l[..., 1] + 0.0722 * l[..., 2]

def contrast(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = np.maximum(la, lb), np.minimum(la, lb)
    return (hi + 0.05) / (lo + 0.05)

rows = []
cache = {}
for item in index:
    if item['shot'] not in cache:
        cache[item['shot']] = np.asarray(Image.open(ROOT + item['shot']).convert('RGB')).astype(float)
    img = cache[item['shot']]
    H, W, _ = img.shape
    for el in item['elements']:
        r = el['rect']
        x0, y0 = int(np.floor(r['x'])), int(np.floor(r['y']))
        x1, y1 = int(np.ceil(r['x'] + r['w'])), int(np.ceil(r['y'] + r['h']))
        pad = 3
        X0, Y0, X1, Y1 = max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)
        if X1 <= X0 or Y1 <= Y0:
            continue
        mask = np.ones((Y1 - Y0, X1 - X0), bool)
        mask[max(0, y0 - Y0 - 1):y1 - Y0 + 1, max(0, x0 - X0 - 1):x1 - X0 + 1] = False   # keep only the ring around the text
        ring = img[Y0:Y1, X0:X1][mask]
        if len(ring) < 8:
            continue
        r_, g_, b_, a_ = parse_color(el['color'])
        text = np.array([r_, g_, b_])
        med = np.median(ring, axis=0)
        eff_med = text * a_ + med * (1 - a_)
        c_med = float(contrast(eff_med, med))
        eff = text[None, :] * a_ + ring * (1 - a_)
        cs = contrast(eff, ring)
        rows.append({'combo': item['combo'], 'scene': item['scene'], 'label': el['label'], 'text': el['text'], 'median': c_med, 'p5': float(np.percentile(cs, 5)), 'min': float(cs.min())})

fails = [x for x in rows if x['median'] < THRESH]
soft = [x for x in rows if x['median'] >= THRESH and x['p5'] < THRESH]
print(f'{len(rows)} text elements measured in {len(index)} screenshots; below {THRESH}:1 at the median background: {len(fails)}; only the 5th percentile below: {len(soft)}')
by = {}
for x in rows:
    k = (x['scene'], x['label'])
    by.setdefault(k, []).append(x)
print('\ntightest measured contrast per element kind (median background):')
for (scene, label), xs in sorted(by.items(), key=lambda kv: min(v['median'] for v in kv[1])):
    w = min(xs, key=lambda v: v['median'])
    print(f"  {w['median']:5.2f}  {scene:9s} {label:24s} worst in {w['combo']}  ('{w['text']}')")
if fails:
    print('\nBELOW THRESHOLD:')
    for x in sorted(fails, key=lambda v: v['median'])[:40]:
        print(f"  {x['median']:5.2f} (p5 {x['p5']:.2f})  {x['combo']:24s} {x['scene']:9s} {x['label']:24s} '{x['text']}'")
json.dump(rows, open(ROOT + 'audit/rows.json', 'w'))
