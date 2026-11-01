import json, io, threading, base64, re, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import eventlog

MAX_SIZE = 10*1024*1024
MAX_QUESTION = 500

lock = threading.Lock()

sam_state = {'status':'ready'}
_client_event_times = []
_client_event_lock = threading.Lock()

def _preload_sam():
    start = time.time()
    eventlog.log_event('sam_preload', level='info', stage='start')
    try:
        import sam
        sam._load()
        sam_state['status'] = 'ready'
        eventlog.log_event('sam_preload', level='info', stage='ready', seconds=round(time.time()-start,3))
    except Exception as e:
        sam_state['status'] = 'failed'
        import traceback
        eventlog.log_event('sam_preload', level='error', stage='failed', seconds=round(time.time()-start,3), error=str(e), traceback=traceback.format_exc()[:2000])

threading.Thread(target=_preload_sam, daemon=True).start()

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
    from reference import get_reference_text, get_part_side, get_part_label, get_part_visual, get_part_sam_prompts
    ref_text = get_reference_text()
    ref_text = f"Image size: {img.width} x {img.height} pixels\n{ref_text}"
    timings = {}
    timings['decode_ms'] = int((time.time() - t_decode_start)*1000)
    t0 = time.time()
    # glimmer pass1
    try:
        p1 = glimmer_mod.pass1(data_url, question, ref_text)
        timings['pass1_ms'] = int((time.time()-t0)*1000)
        eventlog.log_event('glimmer_pass1', requestId=requestId, frameId=frameId, ms=timings['pass1_ms'], finish_reason=p1.get('finish_reason'), tokens=p1.get('tokens'), needs_view=p1.get('needs_view'))
    except GlimmerError as e:
        import traceback
        eventlog.log_event('glimmer_pass1', requestId=requestId, frameId=frameId, level='error', error=e.code, error_msg=str(e), traceback=traceback.format_exc()[:2000])
        if e.code == 'glimmer_timeout':
            return 504, {'error':'glimmer_timeout'}
        if e.code == 'glimmer_bad_json':
            return 502, {'error':'glimmer_bad_json'}
        return 502, {'error':'glimmer_unreachable'}
    except Exception as e:
        import traceback
        eventlog.log_event('glimmer_pass1', requestId=requestId, frameId=frameId, level='error', error='exception', error_msg=str(e), traceback=traceback.format_exc()[:2000])
        return 502, {'error':'glimmer_unreachable'}
    # enforce reference rules and needs_view validation
    needs_view = p1.get('needs_view')
    if needs_view not in (None, 'flip_board', 'closer'):
        needs_view = None
    targets = p1.get('targets',[])
    q_lower = question.lower()
    microsd_mentioned = any(k in q_lower for k in ['microsd','micro sd','sd card','memory card','storage card'])
    has_microsd_target = any(t.get('part') == 'microsd_slot' for t in targets)
    if (microsd_mentioned or has_microsd_target) and get_part_side('microsd_slot') == 'underside':
        view = p1.get('view')
        if view == 'top' or view is None:
            needs_view = 'flip_board'
            targets = [x for x in targets if x.get('part') != 'microsd_slot']
    # real refinement
    def box_iou(a,b):
        x1 = max(a[0],b[0]); y1 = max(a[1],b[1]); x2 = min(a[2],b[2]); y2 = min(a[3],b[3])
        inter = max(0,x2-x1)*max(0,y2-y1)
        area_a = max(0,a[2]-a[0])*max(0,a[3]-a[1])
        area_b = max(0,b[2]-b[0])*max(0,b[3]-b[1])
        union = area_a + area_b - inter
        return inter/union if union else 0.0
    for t in targets:
        if t.get('box_1000'):
            part = t.get('part')
            try:
                prompts = get_part_sam_prompts(part)
            except Exception:
                prompts = []
            if prompts:
                t['refined'] = False
                eventlog.log_event('glimmer_pick', requestId=requestId, frameId=frameId, part=part, refined=False, reason='has_sam_prompt')
                continue
            desc = get_part_visual(part)
            refined_box = None
            if desc and hasattr(glimmer_mod, 'refine_box'):
                try:
                    refined_box = glimmer_mod.refine_box(img, t['box_1000'], desc)
                except Exception as e:
                    import traceback
                    eventlog.log_event('glimmer_pick', requestId=requestId, frameId=frameId, part=part, level='error', error=str(e), traceback=traceback.format_exc()[:2000])
                    refined_box = None
                if refined_box:
                    # validate
                    orig = t['box_1000']
                    rx1,ry1,rx2,ry2 = refined_box
                    if rx2>rx1 and ry2>ry1:
                        area_orig = max(0,orig[2]-orig[0])*max(0,orig[3]-orig[1])
                        area_ref = max(0,rx2-rx1)*max(0,ry2-ry1)
                        if area_orig>0 and area_ref<=4*area_orig and box_iou(orig,refined_box)>0.1:
                            t['box_1000'] = refined_box
                            t['refined'] = True
                            eventlog.log_event('glimmer_pick', requestId=requestId, frameId=frameId, part=part, refined=True)
                            continue
                        else:
                            eventlog.log_event('glimmer_pick', requestId=requestId, frameId=frameId, part=part, refined=False, reason='validation_failed')
                            t['refined'] = False
                            continue
                    else:
                        eventlog.log_event('glimmer_pick', requestId=requestId, frameId=frameId, part=part, refined=False, reason='invalid_box')
                        t['refined'] = False
                        continue
                else:
                    eventlog.log_event('glimmer_pick', requestId=requestId, frameId=frameId, part=part, refined=False, reason='no_refined_box')
            else:
                eventlog.log_event('glimmer_pick', requestId=requestId, frameId=frameId, part=part, refined=False, reason='no_desc_or_refine')
            t['refined'] = False
    # SAM segmentation
    regions = []
    sam_status = None
    sam_detail = None
    t_sam_start = time.time()
    eventlog.log_event('sam_candidates', requestId=requestId, frameId=frameId, count=len(targets), prompt=question[:200])
    # wait for SAM preload
    if sam_state['status'] == 'loading':
        wait_start = time.time()
        while sam_state['status'] == 'loading' and time.time() - wait_start < 5:
            time.sleep(0.05)
    if sam_state['status'] == 'unavailable':
        sam_status = 'sam_unavailable'
        sam_detail = 'SAM preload failed'
    else:
        try:
            for t in targets:
                try:
                    result = sam_mod.segment(img, t)
                except RuntimeError as e:
                    import traceback, sys
                    traceback.print_exc(file=sys.stderr)
                    tb=traceback.format_exc()[:2000]
                    if 'sam_unavailable' in str(e):
                        sam_status = 'sam_unavailable'
                        sam_detail = str(e)[:200]
                        regions = []
                        eventlog.log_event('sam_candidates', requestId=requestId, frameId=frameId, level='error', part=t.get('part'), error=str(e), traceback=tb)
                        break
                    else:
                        sam_status = 'sam_error'
                        sam_detail = f'{type(e).__name__}: {e}'[:200]
                        regions = []
                        eventlog.log_event('sam_candidates', requestId=requestId, frameId=frameId, level='error', part=t.get('part'), error=str(e), traceback=tb)
                        break
                except Exception as e:
                    import traceback, sys
                    traceback.print_exc(file=sys.stderr)
                    tb=traceback.format_exc()[:2000]
                    sam_status = 'sam_error'
                    sam_detail = f'{type(e).__name__}: {e}'[:200]
                    regions = []
                    eventlog.log_event('sam_candidates', requestId=requestId, frameId=frameId, level='error', part=t.get('part'), error=str(e), traceback=tb)
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
                    'source': 'sam3',
                    'refined': t.get('refined', False),
                    'selection': 'none'
                })
                else:
                    # quality gate
                    bbox = result.get('bbox')
                    polygon = result.get('polygon')
                    selection = result.get('selection', 'box_prompt')
                    # compute IoU for logging if box available
                    sel_iou = None
                    if selection == 'box_prompt' and t.get('box_1000') and bbox:
                        try:
                            box1000 = t.get('box_1000')
                            req_bbox = [box1000[0]/1000.0, box1000[1]/1000.0, box1000[2]/1000.0, box1000[3]/1000.0]
                            x1 = max(bbox[0], req_bbox[0]); y1 = max(bbox[1], req_bbox[1])
                            x2 = min(bbox[2], req_bbox[2]); y2 = min(bbox[3], req_bbox[3])
                            inter = max(0.0, x2-x1) * max(0.0, y2-y1)
                            area_a = max(0.0, bbox[2]-bbox[0]) * max(0.0, bbox[3]-bbox[1])
                            area_b = max(0.0, req_bbox[2]-req_bbox[0]) * max(0.0, req_bbox[3]-req_bbox[1])
                            union = area_a + area_b - inter
                            sel_iou = inter/union if union>0 else 0.0
                        except Exception:
                            sel_iou = None
                    eventlog.log_event('selection', requestId=requestId, frameId=frameId, part=part, selection_mode=selection, box_iou=round(sel_iou,3) if sel_iou is not None else None)
                    reject = False
                    # bbox area >60% unless board overlap/marks
                    if bbox:
                        area = max(0.0, bbox[2]-bbox[0]) * max(0.0, bbox[3]-bbox[1])
                        if area > 0.6 and not (part == 'board' and selection in ('overlap','marks')):
                            reject = True
                    # polygon points <3
                    if polygon and len(polygon) < 3:
                        reject = True
                    # box_prompt IoU <0.2
                    iou_val = 1.0
                    if selection == 'box_prompt' and t.get('box_1000') and bbox:
                        box1000 = t.get('box_1000')
                        req_bbox = [box1000[0]/1000.0, box1000[1]/1000.0, box1000[2]/1000.0, box1000[3]/1000.0]
                        # iou
                        x1 = max(bbox[0], req_bbox[0]); y1 = max(bbox[1], req_bbox[1])
                        x2 = min(bbox[2], req_bbox[2]); y2 = min(bbox[3], req_bbox[3])
                        inter = max(0.0, x2-x1) * max(0.0, y2-y1)
                        area_a = max(0.0, bbox[2]-bbox[0]) * max(0.0, bbox[3]-bbox[1])
                        area_b = max(0.0, req_bbox[2]-req_bbox[0]) * max(0.0, req_bbox[3]-req_bbox[1])
                        union = area_a + area_b - inter
                        iou_val = inter/union if union>0 else 0.0
                        if iou_val < 0.2:
                            reject = True
                    eventlog.log_event('quality_gate', requestId=requestId, frameId=frameId, part=part, kept=not reject, reason='iou' if iou_val<0.2 else ('area' if bbox and max(0.0,bbox[2]-bbox[0])*max(0.0,bbox[3]-bbox[1])>0.6 else 'polygon' if polygon and len(polygon)<3 else 'ok'))
                    if reject:
                        result = None
                    if result is None:
                        regions.append({
                        'id': t.get('id'),
                        'part': part,
                        'label': label,
                        'polygon': None,
                        'bbox': None,
                        'score': 0.0,
                        'status': 'not_found',
                        'source': 'sam3',
                        'refined': t.get('refined', False),
                        'selection': 'none'
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
                        'source': 'sam3',
                        'refined': t.get('refined', False),
                        'selection': result.get('selection', 'box_prompt'),
                        'selection_debug': result.get('selection_debug', {})
                    })

        except Exception as e:
            import traceback, sys
            traceback.print_exc(file=sys.stderr)
            sam_status = 'sam_error'
            sam_detail = f'{type(e).__name__}: {e}'[:200]
            regions = []
    timings['sam_ms'] = int((time.time() - t_sam_start)*1000)
    # rule 1a: when needs_view is set, drop regions for parts needing view and board outline
    if needs_view:
        regions = [r for r in regions if r.get('part') not in ('microsd_slot','board')]
    # answer from pass1, no separate pass2 unless missing
    answer = p1.get('answer')
    if not answer:
        # fallback to pass2 for backward compatibility / tests
        try:
            explanation = glimmer_mod.pass2(data_url, p1.get('view'), regions, question, ref_text)
            explanation = re.sub(r'~?\s*\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\]', '', explanation)
            explanation = re.sub(r'\(\s*\d+\s*,\s*\d+\s*\)', '', explanation)
            explanation = re.sub(r'\b[a-z]+_[a-z_]+\b', '', explanation)
            explanation = re.sub(r'\s+', ' ', explanation).strip()
            answer = explanation
        except Exception:
            labels = [r.get('label') for r in regions if r.get('status')=='observed']
            if labels:
                answer = 'Found ' + ', '.join(labels) + '.'
            else:
                answer = 'No parts identified.'
    explanation = answer
    timings['total_ms'] = int((time.time() - t_decode_start)*1000)
    timings['pass2_ms'] = 0
    steps = [
        {'name':'decode','ms':timings.get('decode_ms')},
        {'name':'pass1','ms':timings.get('pass1_ms')},
        {'name':'sam','ms':timings.get('sam_ms')},
        {'name':'total','ms':timings.get('total_ms')}
    ]
    provenance = {'glimmer_model':'muse-glimmer-hackathon','sam_model':sam_status,'timings_ms':timings,'steps':steps}
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
    eventlog.log_event('final', requestId=requestId, frameId=frameId, status=200, regions_count=len(regions), total_ms=timings.get('total_ms'))
    return 200, resp

class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        self.send_response(code)
        self.send_header('Content-Type','application/json')
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode())

    def _log_http(self, method, path, status, start, content_length, xff):
        ms = int((time.time() - start) * 1000)
        eventlog.log_event('http_request', level='info', method=method, path=path, status=status, ms=ms, content_length=content_length, x_forwarded_for=xff)

    def do_GET(self):
        start = time.time()
        method = 'GET'
        path_full = self.path
        path = path_full.split('?')[0]
        xff = self.headers.get('X-Forwarded-For')
        status = 200
        try:
            if path == '/api/health':
                self._json(200, {'status':'ok','sam': sam_state['status']})
                status = 200
            elif path == '/api/events':
                if self.client_address[0] != '127.0.0.1' or xff:
                    self._json(403, {'error':'forbidden'})
                    status = 403
                    if xff:
                        eventlog.log_event('http_rejection', level='warn', method=method, path=path, status=403, reason='x_forwarded_for_present')
                    else:
                        eventlog.log_event('http_rejection', level='warn', method=method, path=path, status=403, reason='not_loopback')
                else:
                    import urllib.parse
                    qs = urllib.parse.parse_qs(urllib.parse.urlparse(path_full).query)
                    try:
                        n = int(qs.get('n',[100])[0])
                    except:
                        n = 100
                    n = max(1, min(n, 500))
                    log_path = os.getenv('SIT_EVENT_LOG', '/data/project/logs/events.jsonl')
                    events = []
                    try:
                        with open(log_path, 'r', encoding='utf-8') as f:
                            lines = f.readlines()
                            for line in lines[-n:]:
                                try:
                                    events.append(json.loads(line))
                                except:
                                    pass
                    except FileNotFoundError:
                        events = []
                    self._json(200, events)
                    status = 200
            else:
                self.send_error(404)
                status = 404
                eventlog.log_event('http_rejection', level='warn', method=method, path=path, status=404, reason='not_found')
        except Exception as e:
            import traceback
            status = 500
            eventlog.log_event('http_rejection', level='error', method=method, path=path, status=500, reason=str(e), traceback=traceback.format_exc()[:2000])
            self.send_error(500)
        finally:
            self._log_http(method, path, status, start, self.headers.get('Content-Length'), xff)

    def do_POST(self):
        start = time.time()
        method = 'POST'
        path = self.path.split('?')[0]
        xff = self.headers.get('X-Forwarded-For')
        status = 200
        content_length = self.headers.get('Content-Length')
        try:
            if path == '/api/client-event':
                # rate limit 60 per minute
                now = time.time()
                with _client_event_lock:
                    global _client_event_times
                    _client_event_times = [t for t in _client_event_times if now - t < 60]
                    if len(_client_event_times) >= 60:
                        self._json(429, {'error':'rate_limited'})
                        status = 429
                        eventlog.log_event('http_rejection', level='warn', method=method, path=path, status=429, reason='client_event_rate_limit')
                        return
                    _client_event_times.append(now)
                # read body max 4KB
                try:
                    length = int(self.headers.get('Content-Length',0))
                except:
                    length = 0
                if length > 4096:
                    self._json(413, {'error':'payload_too_large'})
                    status = 413
                    eventlog.log_event('http_rejection', level='warn', method=method, path=path, status=413, reason='client_event_too_large')
                    return
                body = self.rfile.read(length)
                try:
                    data = json.loads(body)
                except:
                    self._json(400, {'error':'invalid_json'})
                    status = 400
                    eventlog.log_event('http_rejection', level='warn', method=method, path=path, status=400, reason='invalid_json')
                    return
                event = data.get('event')
                detail = str(data.get('detail',''))[:300]
                userAgent = str(data.get('userAgent',''))[:160]
                viewport = data.get('viewport')
                online = bool(data.get('online'))
                eventlog.log_event('client_event', level='info', client_event=event, detail=detail, userAgent=userAgent, viewport=viewport, online=online)
                self._json(200, {'ok':True})
                status = 200
                return
            if path != '/api/analyze':
                self.send_error(404)
                status = 404
                eventlog.log_event('http_rejection', level='warn', method=method, path=path, status=404, reason='not_found')
                return
            if not lock.acquire(blocking=False):
                self._json(429, {'error':'too_many_requests'})
                status = 429
                eventlog.log_event('http_rejection', level='warn', method=method, path=path, status=429, reason='concurrent_limit')
                return
            try:
                if 'Content-Length' not in self.headers:
                    self._json(411, {'error':'length_required'})
                    status = 411
                    eventlog.log_event('http_rejection', level='warn', method=method, path=path, status=411, reason='length_required')
                    return
                length = int(self.headers.get('Content-Length',0))
                if length > 14*1024*1024:
                    self._json(413, {'error':'payload_too_large'})
                    status = 413
                    eventlog.log_event('http_rejection', level='warn', method=method, path=path, status=413, reason='payload_too_large')
                    return
                body = self.rfile.read(length)
                try:
                    data = json.loads(body)
                except:
                    self._json(400, {'error':'invalid_json'})
                    status = 400
                    eventlog.log_event('http_rejection', level='warn', method=method, path=path, status=400, reason='invalid_json')
                    return
                import glimmer, sam
                requestId = data.get('requestId')
                frameId = data.get('frameId')
                # log image size and sha prefix if present
                image = data.get('image','')
                img_bytes = None
                sha_prefix = None
                img_size = None
                if isinstance(image,str) and image.startswith('data:image'):
                    try:
                        import hashlib
                        b64 = image.split(',',1)[1]
                        img_bytes_raw = base64.b64decode(b64)
                        img_size = len(img_bytes_raw)
                        sha_prefix = hashlib.sha256(img_bytes_raw).hexdigest()[:12]
                    except:
                        pass
                eventlog.log_event('http_request_body', level='info', requestId=requestId, frameId=frameId, image_size=img_size, image_sha_prefix=sha_prefix)
                status_code, resp = analyze(data, glimmer, sam)
                self._json(status_code, resp)
                status = status_code
            except Exception:
                import traceback, sys
                traceback.print_exc(file=sys.stderr)
                self._json(500, {'error':'internal'})
                status = 500
                eventlog.log_event('http_rejection', level='error', method=method, path=path, status=500, reason='internal_exception')
        finally:
            try:
                lock.release()
            except:
                pass
            self._log_http(method, path, status, start, content_length, xff)
    def log_message(self, *args):
        return

def run():
    port = int(os.getenv('SIT_PORT','8895'))
    env_names = [k for k in os.environ if k.startswith('SIT_') or k.startswith('MUSE_') or k.startswith('SAM')]
    eventlog.log_event('server_start', level='info', port=port, env_names=env_names)
    server = ThreadingHTTPServer(('127.0.0.1',port), Handler)
    server.serve_forever()

if __name__ == '__main__':
    run()
