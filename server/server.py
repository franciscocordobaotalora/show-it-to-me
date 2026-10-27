import json, io, threading, base64, re, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_SIZE = 10*1024*1024
MAX_QUESTION = 500

lock = threading.Lock()

class GlimmerError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)

def analyze(data, glimmer_mod, sam_mod):
    # validation
    frameId = data.get('frameId')
    requestId = data.get('requestId')
    question = data.get('question','')
    image = data.get('image')
    if not isinstance(frameId,str) or not frameId or len(frameId)>64:
        return 400, {'error':'invalid_frameId'}
    if not isinstance(requestId,str) or not requestId or len(requestId)>64:
        return 400, {'error':'invalid_requestId'}
    if not isinstance(question,str) or not (1 <= len(question) <= MAX_QUESTION):
        return 400, {'error':'invalid_question'}
    if not isinstance(image,str) or not re.match(r'^data:image/(jpeg|png);base64,', image):
        return 400, {'error':'invalid_image'}
    try:
        b64 = image.split(',',1)[1]
        img_bytes = base64.b64decode(b64, validate=True)
    except Exception:
        return 400, {'error':'invalid_image'}
    if len(img_bytes) > MAX_SIZE:
        return 400, {'error':'image_too_large'}
    t_decode_start = time.time()
    try:
        from PIL import Image, ImageOps
        img = Image.open(io.BytesIO(img_bytes))
        img.verify()
        img = Image.open(io.BytesIO(img_bytes))
        img = ImageOps.exif_transpose(img)
        # resize max side 1280
        max_side = 1280
        w,h = img.size
        if max(w,h) > max_side:
            scale = max_side / max(w,h)
            img = img.resize((int(w*scale), int(h*scale)))
        # re-encode JPEG for model
        buf = io.BytesIO()
        img.save(buf, format='JPEG')
        data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return 400, {'error':'corrupt_image'}
    # reference text
    from reference import get_reference_text, get_part_side, get_part_label
    ref_text = get_reference_text()
    timings = {}
    timings['decode_ms'] = int((time.time() - t_decode_start)*1000)
    t0 = time.time()
    # glimmer pass1
    try:
        p1 = glimmer_mod.pass1(data_url, question, ref_text)
        timings['pass1_ms'] = int((time.time()-t0)*1000)
    except GlimmerError as e:
        if e.code == 'glimmer_timeout':
            return 504, {'error':'glimmer_timeout'}
        if e.code == 'glimmer_bad_json':
            return 502, {'error':'glimmer_bad_json'}
        return 502, {'error':'glimmer_unreachable'}
    except Exception:
        return 502, {'error':'glimmer_unreachable'}
    # enforce reference rules and needs_view validation
    needs_view = p1.get('needs_view')
    if needs_view not in (None, 'flip_board', 'closer'):
        needs_view = None
    targets = p1.get('targets',[])
    for t in targets:
        if t.get('part') == 'microsd_slot' and get_part_side('microsd_slot') == 'underside':
            if p1.get('view') == 'top' or p1.get('view') is None:
                needs_view = 'flip_board'
                targets = [x for x in targets if x.get('part') != 'microsd_slot']
                break
    # SAM segmentation
    regions = []
    sam_status = None
    sam_detail = None
    t_sam_start = time.time()
    try:
        for t in targets:
            try:
                result = sam_mod.segment(img, t)
            except RuntimeError as e:
                import traceback, sys
                traceback.print_exc(file=sys.stderr)
                if 'sam_unavailable' in str(e):
                    sam_status = 'sam_unavailable'
                    sam_detail = str(e)[:200]
                    regions = []
                    break
                else:
                    sam_status = 'sam_error'
                    sam_detail = f'{type(e).__name__}: {e}'[:200]
                    regions = []
                    break
            except Exception as e:
                import traceback, sys
                traceback.print_exc(file=sys.stderr)
                sam_status = 'sam_error'
                sam_detail = f'{type(e).__name__}: {e}'[:200]
                regions = []
                break
            part = t.get('part')
            label = get_part_label(part) if part else part
            if result is None:
                regions.append({
                    'id': t.get('id'),
                    'part': part,
                    'label': label,
                    'polygon': None,
                    'bbox': None,
                    'score': 0.0,
                    'status': 'not_found',
                    'source': 'sam3'
                })
            else:
                regions.append({
                    'id': t.get('id'),
                    'part': part,
                    'label': label,
                    'polygon': result.get('polygon'),
                    'bbox': result.get('bbox'),
                    'score': float(result.get('score', 0.0)),
                    'status': 'observed',
                    'source': 'sam3'
                })
    except Exception as e:
        import traceback, sys
        traceback.print_exc(file=sys.stderr)
        sam_status = 'sam_error'
        sam_detail = f'{type(e).__name__}: {e}'[:200]
        regions = []
    timings['sam_ms'] = int((time.time() - t_sam_start)*1000)
    # glimmer pass2
    t_pass2_start = time.time()
    try:
        explanation = glimmer_mod.pass2(data_url, p1.get('view'), regions, question, ref_text)
        # strip bracketed coordinate lists only, preserve digits/spaces elsewhere
        explanation = re.sub(r'~?\s*\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\]', '', explanation)
        explanation = re.sub(r'\(\s*\d+\s*,\s*\d+\s*\)', '', explanation)
        explanation = re.sub(r'\s+', ' ', explanation).strip()
    except Exception:
        explanation = 'Explanation unavailable'
    timings['pass2_ms'] = int((time.time() - t_pass2_start)*1000)
    timings['total_ms'] = int((time.time() - t_decode_start)*1000)
    provenance = {'glimmer_model':'muse-glimmer-hackathon','sam_model':sam_status,'timings_ms':timings}
    if sam_detail:
        provenance['sam_detail'] = sam_detail
    resp = {
        'frameId': frameId,
        'requestId': requestId,
        'view': p1.get('view'),
        'regions': regions,
        'explanation': explanation,
        'needs_view': needs_view,
        'sources': [],
        'provenance': provenance
    }
    return 200, resp

class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        self.send_response(code)
        self.send_header('Content-Type','application/json')
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def do_GET(self):
        if self.path == '/api/health':
            self._json(200, {'status':'ok'})
        else:
            self.send_error(404)
    def do_POST(self):
        if self.path != '/api/analyze':
            self.send_error(404); return
        if not lock.acquire(blocking=False):
            self._json(429, {'error':'too_many_requests'}); return
        try:
            try:
                if 'Content-Length' not in self.headers:
                    self._json(411, {'error':'length_required'}); return
                length = int(self.headers.get('Content-Length',0))
                if length > 14*1024*1024:
                    self._json(413, {'error':'payload_too_large'}); return
                body = self.rfile.read(length)
                try:
                    data = json.loads(body)
                except:
                    self._json(400, {'error':'invalid_json'}); return
                import glimmer, sam
                status, resp = analyze(data, glimmer, sam)
                self._json(status, resp)
            except Exception:
                import traceback, sys
                traceback.print_exc(file=sys.stderr)
                self._json(500, {'error':'internal'})
        finally:
            lock.release()
    def log_message(self, *args):
        return

def run():
    port = int(os.getenv('SIT_PORT','8895'))
    server = ThreadingHTTPServer(('127.0.0.1',port), Handler)
    server.serve_forever()

if __name__ == '__main__':
    run()
