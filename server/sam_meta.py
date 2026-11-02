"""SAM 3.1 served by Meta Model API (hosted), same contract as sam.segment().

We developed and measured with the local SAM 3 (server/sam.py, operator/sam-bench.sh). This backend lets the live
site run without any GPU: POST https://api.meta.ai/v1/responses with model "sam-3.1". Select it with SAM_BACKEND=meta.

Wire format (docs: dev.meta.ai/docs/sam/overview):
  request  input_text = a noun phrase, or a box prompt like  <0f>1<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>
  response text = per match  <0f>N<|box;x1;y1;x2;y2;w;h|><|mask;x=0;y=0;data=H,W,~PAYLOAD|>
The mask raster is local to its box (H rows, W columns, data lists height first), 1 = inside. It is decoded with the
official meta_sam_parser package (SAM License), then resized to the box and pasted into a full-frame mask.
Zero matches is valid: the output text is empty.
"""
import base64
import io
import json
import os
import re
import threading
import time
import urllib.error
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vendor'))

try:
    import eventlog
except Exception:  # tests import this module without the server
    eventlog = None

API_URL = os.getenv('META_SAM_URL', 'https://api.meta.ai/v1/responses')
MODEL = os.getenv('META_SAM_MODEL', 'sam-3.1')
TIMEOUT_S = float(os.getenv('META_SAM_TIMEOUT', '25'))
MAX_SIDE = 1280
MAX_PROMPTS = 3
# Meta answered HTTP 429 when a background pre-scan (up to 12 calls at once) overlapped a real question (2026-11-02):
# every call of the question failed and nothing was drawn. Cap the calls in flight, and back off on 429.
MAX_CONCURRENT = int(os.getenv('META_SAM_CONCURRENCY', '6'))
_gate = threading.BoundedSemaphore(MAX_CONCURRENT)
RETRY_STATUS = (429, 500, 502, 503, 504)
BACKOFF_S = (0.6, 1.4, 2.5)

_BOX_RE = re.compile(r'<\|box;x1=(-?[\d.]+);y1=(-?[\d.]+);x2=(-?[\d.]+);y2=(-?[\d.]+);w=(\d+);h=(\d+)\|>')
_MASK_RE = re.compile(r'<\|mask;x=(\d+);y=(\d+);data=(\d+),(\d+),([~!])(.*?)\|>', re.S)

_lock = threading.Lock()
_cache = {'id': None, 'b64': None, 'size': None}
_used = {}


def _log(event, **fields):
    if eventlog is not None:
        try:
            eventlog.log_event(event, **fields)
        except Exception:
            pass


def load():
    """Nothing to load: the model is hosted. Raises when the key is missing so the server reports sam_unavailable."""
    if not os.getenv('META_API_KEY'):
        raise RuntimeError('sam_unavailable: META_API_KEY missing')


def _encode(image_pil):
    """JPEG base64 of the image at most 1280 px on the long side. Cached for the last image object."""
    with _lock:
        if _cache['id'] == id(image_pil) and _cache['b64']:
            return _cache['b64'], _cache['size']
    im = image_pil.convert('RGB')
    im.thumbnail((MAX_SIDE, MAX_SIDE))
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=88)
    b64 = base64.b64encode(buf.getvalue()).decode()
    with _lock:
        _cache.update(id=id(image_pil), b64=b64, size=im.size)
        _used.clear()
    return b64, im.size


def build_box_prompt(box_px, size):
    """Box prompt text in the pixel space of the image that is sent."""
    w, h = size
    x1, y1, x2, y2 = [int(round(v)) for v in box_px]
    # Meta rejects a box whose right or bottom edge sits on the frame edge ("lies outside the WxH frame", HTTP 400),
    # so keep x2 and y2 one pixel inside. Muse often returns boxes that reach the edge.
    x1, x2 = max(0, min(w - 2, x1)), max(1, min(w - 1, x2))
    y1, y2 = max(0, min(h - 2, y1)), max(1, min(h - 1, y2))
    if x2 <= x1:
        x2 = x1 + 1
    if y2 <= y1:
        y2 = y1 + 1
    return _manual_box(x1, y1, x2, y2, w, h)


def _manual_box(x1, y1, x2, y2, w, h):
    return '<0f>1<|box;x1=%d;y1=%d;x2=%d;y2=%d;w=%d;h=%d|>' % (x1, y1, x2, y2, w, h)


def _post(b64, text, timeout=None):
    """One Responses call. Returns the output text ('' for zero matches). One retry on 5xx, 429 and timeouts."""
    key = os.getenv('META_API_KEY', '')
    if not key:
        raise RuntimeError('sam_unavailable: META_API_KEY missing')
    body = {'model': MODEL, 'input': [{'type': 'message', 'role': 'user', 'content': [
        {'type': 'input_text', 'text': text},
        {'type': 'input_image', 'image_url': 'data:image/jpeg;base64,' + b64}]}]}
    data = json.dumps(body).encode()
    last = None
    for attempt in range(len(BACKOFF_S) + 1):
        t0 = time.time()
        wait_s = None
        try:
            req = urllib.request.Request(API_URL, data=data, headers={
                'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
            with _gate:
                with urllib.request.urlopen(req, timeout=timeout or TIMEOUT_S) as r:
                    o = json.load(r)
            out = o['output'][0]['content'][0].get('text') or ''
            _log('sam_meta_ok', backend='meta', ms=round((time.time() - t0) * 1000), chars=len(out),
                 images=(o.get('usage') or {}).get('images_processed'))
            return out
        except urllib.error.HTTPError as e:
            last = e
            _log('sam_meta_fail', level='warn', backend='meta', status=e.code, attempt=attempt,
                 ms=round((time.time() - t0) * 1000))
            if e.code not in RETRY_STATUS:
                break
            try:
                wait_s = float(e.headers.get('Retry-After')) if e.headers.get('Retry-After') else None
            except Exception:
                wait_s = None
        except Exception as e:  # timeout, reset
            last = e
            _log('sam_meta_fail', level='warn', backend='meta', error=type(e).__name__, attempt=attempt,
                 ms=round((time.time() - t0) * 1000))
        if attempt < len(BACKOFF_S):
            time.sleep(min(5.0, wait_s) if wait_s else BACKOFF_S[attempt])
        else:
            break
    raise RuntimeError('sam_error: meta call failed: %s' % (last,))


def parse_objects(text):
    """Return [{'box': (x1,y1,x2,y2), 'frame': (w,h), 'mask': (raster uint8 HxW or None)}] in order of appearance."""
    import numpy as np
    out = []
    boxes = list(_BOX_RE.finditer(text or ''))
    masks = list(_MASK_RE.finditer(text or ''))
    for bi, b in enumerate(boxes):
        x1, y1, x2, y2, w, h = b.groups()
        nxt = boxes[bi + 1].start() if bi + 1 < len(boxes) else len(text)
        m = next((mm for mm in masks if b.end() <= mm.start() < nxt), None)
        raster = None
        if m is not None:
            try:
                from meta_sam_parser import SegmentationMask, decode_mask_to_raster
                rows, cols = int(m.group(3)), int(m.group(4))
                enc = 'lossless' if m.group(5) == '~' else 'one_bit'
                mask = SegmentationMask(encoding=enc, payload=m.group(5) + m.group(6), width=cols, height=rows)
                raw = decode_mask_to_raster(mask)
                raster = np.frombuffer(raw, dtype=np.uint8).reshape(rows, cols)
            except Exception as e:
                _log('sam_meta_fail', level='warn', backend='meta', error='mask_decode:' + str(e)[:80])
        out.append({'box': (float(x1), float(y1), float(x2), float(y2)), 'frame': (int(w), int(h)), 'mask': raster})
    return out


def _full_mask(obj, size):
    """Paste the box-local raster into a full-frame uint8 mask of `size` (w, h) of the image that was sent."""
    import numpy as np
    from PIL import Image
    w, h = size
    full = np.zeros((h, w), dtype=np.uint8)
    if obj['mask'] is None:
        return full
    fw, fh = obj['frame']
    sx, sy = w / float(fw), h / float(fh)
    x1, y1, x2, y2 = obj['box']
    bx1, by1 = int(round(x1 * sx)), int(round(y1 * sy))
    bx2, by2 = int(round(x2 * sx)), int(round(y2 * sy))
    bw, bh = max(1, bx2 - bx1), max(1, by2 - by1)
    m = Image.fromarray((obj['mask'] > 0).astype('uint8') * 255).resize((bw, bh), Image.NEAREST)
    arr = (np.asarray(m) > 0).astype(np.uint8)
    xs, ys = max(0, bx1), max(0, by1)
    xe, ye = min(w, bx1 + bw), min(h, by1 + bh)
    full[ys:ye, xs:xe] = arr[ys - by1:ye - by1, xs - bx1:xe - bx1]
    return full


def _iou(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _result(mask, size, selection, score, debug):
    import numpy as np
    from sam import mask_to_polygon
    w, h = size
    ys, xs = np.where(mask > 0)
    if xs.size == 0:
        return None
    poly = mask_to_polygon(mask, w, h)
    if len(poly) < 3:
        return None
    bbox = [float(xs.min()) / w, float(ys.min()) / h, float(xs.max() + 1) / w, float(ys.max() + 1) / h]
    return {'polygon': poly, 'bbox': bbox, 'score': float(score), 'selection': selection, 'selection_debug': debug}


def _prompts_for(target):
    part = target.get('part')
    label = target.get('label') or ''
    sam_prompt = target.get('sam_prompt') or ''
    prompts = []
    try:
        if part:
            from reference import get_part_sam_prompts
            prompts = list(get_part_sam_prompts(part) or [])
    except Exception:
        prompts = []
    if not prompts:
        from sam import build_generic_prompts
        prompts = build_generic_prompts(sam_prompt or label or part or '', label)
    return [p for p in prompts if p][:(1 if target.get('light') else MAX_PROMPTS)]


def segment(image_pil, target):
    """Same contract as sam.segment(image_pil, target): dict with polygon, bbox, score, selection or None."""
    b64, size = _encode(image_pil)
    w, h = size
    box_1000 = target.get('box_1000')
    muse_px = None
    if box_1000 and len(box_1000) == 4:
        muse_px = [box_1000[0] / 1000.0 * w, box_1000[1] / 1000.0 * h, box_1000[2] / 1000.0 * w, box_1000[3] / 1000.0 * h]
    prompts = _prompts_for(target)
    jobs = [('text', p) for p in prompts]
    if muse_px:
        jobs.append(('box', build_box_prompt(muse_px, size)))
    if not jobs:
        return None
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=min(4, len(jobs))) as ex:
        futs = [(kind, txt, ex.submit(_post, b64, txt)) for kind, txt in jobs]
        results = []
        errors = 0
        for kind, txt, f in futs:
            try:
                results.append((kind, txt, parse_objects(f.result())))
            except Exception as e:
                errors += 1
                _log('sam_meta_fail', level='warn', backend='meta', kind=kind, error=str(e)[:120])
    if errors == len(jobs):
        raise RuntimeError('sam_error: all Meta SAM calls failed')
    text_cands = [(txt, o) for kind, txt, objs in results if kind == 'text' for o in objs if o['mask'] is not None]
    box_cands = [o for kind, txt, objs in results if kind == 'box' for o in objs if o['mask'] is not None]
    # drop candidates already used by an earlier target of the same image (two micro-HDMI ports)
    with _lock:
        used = list(_used.get(id(image_pil), []))
    def fresh(o):
        return not any(_iou(o['box'], u) > 0.9 for u in used)
    text_cands = [(t, o) for t, o in text_cands if fresh(o)]
    dbg = {'backend': 'meta', 'ms': round((time.time() - t0) * 1000), 'text_candidates': len(text_cands),
           'box_candidates': len(box_cands), 'text_iou': None, 'box_iou': None}
    selection = 'overlap' if target.get('part') else 'text_overlap'
    chosen, kind = None, None
    if muse_px and text_cands:
        best = max(text_cands, key=lambda c: _iou(c[1]['box'], muse_px))
        iou_v = _iou(best[1]['box'], muse_px)
        dbg['text_iou'] = round(iou_v, 3)
        if iou_v >= 0.3:
            chosen, kind = best[1], selection
    if chosen is None and not muse_px and text_cands:
        chosen, kind = text_cands[0][1], 'text_overlap'
    if chosen is None and box_cands:
        chosen, kind = box_cands[0], 'box_prompt'
        if muse_px:
            dbg['box_iou'] = round(_iou(chosen['box'], muse_px), 3)
    if chosen is None:
        return None
    res = _result(_full_mask(chosen, size), size, kind, 0.9, dbg)
    if res is not None:
        with _lock:
            _used.setdefault(id(image_pil), []).append(chosen['box'])
    return res
