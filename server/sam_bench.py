"""SAM-only benchmark and equivalence check. Run on Atlas (card B) via operator/sam-bench.sh.
Usage: python sam_bench.py [--save baseline.json | --compare baseline.json] [--runs 3]
Same photo + same Glimmer-style boxes every run, so only SAM time and masks vary."""
import sys, os, json, time, statistics
sys.path.insert(0, os.path.dirname(__file__))
from PIL import Image
import sam
FIX = os.path.join(os.path.dirname(__file__), '..', 'fixtures', 'pi5')
CASES = [  # (photo, part, box_1000 hand-marked truth)
    ('Raspberry_Pi_5_Board.jpg', 'fan_connector', [660, 127, 686, 217]),
    ('Raspberry_Pi_5_Board.jpg', 'usb_c_power_port', [182, 707, 255, 805]),
    ('Raspberry_Pi_5_Board.jpg', 'micro_hdmi_port', [311, 703, 369, 809]),
    ('Raspberry_Pi_5_Board.jpg', 'micro_hdmi_port', [422, 703, 478, 809]),
]
def run_once():
    out, t_all = [], {}
    im = Image.open(os.path.join(FIX, CASES[0][0])).convert('RGB'); im.thumbnail((1280, 1280))
    t = time.perf_counter(); s = sam.SamSession(im); t_all['set_image_ms'] = round((time.perf_counter()-t)*1000)
    for i, (_, part, box) in enumerate(CASES):
        t = time.perf_counter()
        r = s.segment({'id': str(i), 'part': part, 'box_1000': box, 'sam_prompt': part})
        t_all[f'segment_{i}_ms'] = round((time.perf_counter()-t)*1000)
        out.append(None if r is None else {'part': part, 'selection': r['selection'], 'score': round(r['score'], 3), 'bbox': [round(v, 3) for v in r['bbox']], 'npoly': len(r['polygon'])})
    t_all['total_ms'] = sum(t_all.values())
    return out, t_all
def bbox_iou(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]); i = max(0, x2-x1)*max(0, y2-y1)
    u = (a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i; return i/u if u else 0
if __name__ == '__main__':
    runs = int(sys.argv[sys.argv.index('--runs')+1]) if '--runs' in sys.argv else 3
    sam._load(); run_once()  # warm-up, not counted
    res = [run_once() for _ in range(runs)]
    tot = [r[1]['total_ms'] for r in res]
    print('regions', json.dumps(res[-1][0])); print('timings_last', json.dumps(res[-1][1]))
    print(f'TOTAL median {statistics.median(tot)} ms over {runs} runs: {tot}')
    if '--save' in sys.argv: json.dump(res[-1][0], open(sys.argv[sys.argv.index('--save')+1], 'w'))
    if '--compare' in sys.argv:
        base = json.load(open(sys.argv[sys.argv.index('--compare')+1])); ok = True
        for b, n in zip(base, res[-1][0]):
            v = bbox_iou(b['bbox'], n['bbox']) if b and n else (1.0 if b == n else 0.0)
            print(b and b['part'], 'bbox IoU vs baseline', round(v, 3)); ok &= v >= 0.9
        print('EQUIVALENT' if ok else 'DIFFERENT'); sys.exit(0 if ok else 1)
