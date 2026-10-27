import json, io, threading, base64, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

MAX_SIZE = 10*1024*1024
MAX_QUESTION = 500

lock = threading.Lock()

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
            self._json(429, {'error':'too_many_requests'})
            return
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
            frameId = data.get('frameId')
            requestId = data.get('requestId')
            question = data.get('question','')
            image = data.get('image')
            if not isinstance(frameId,str) or not frameId or len(frameId)>64:
                self._json(400, {'error':'invalid_frameId'}); return
            if not isinstance(requestId,str) or not requestId or len(requestId)>64:
                self._json(400, {'error':'invalid_requestId'}); return
            if not isinstance(question,str) or not (1 <= len(question) <= MAX_QUESTION):
                self._json(400, {'error':'invalid_question'}); return
            if not isinstance(image,str) or not re.match(r'^data:image/(jpeg|png);base64,', image):
                self._json(400, {'error':'invalid_image'}); return
            try:
                b64 = image.split(',',1)[1]
                img_bytes = base64.b64decode(b64, validate=True)
            except:
                self._json(400, {'error':'invalid_image'}); return
            if len(img_bytes) > MAX_SIZE:
                self._json(400, {'error':'image_too_large'}); return
            # PIL validation
            try:
                from PIL import Image, ImageOps
                img = Image.open(io.BytesIO(img_bytes))
                img.verify()
                img = Image.open(io.BytesIO(img_bytes))
                img = ImageOps.exif_transpose(img)
            except Exception:
                self._json(400, {'error':'corrupt_image'}); return
            # placeholder response
            resp = {
                'frameId': frameId,
                'requestId': requestId,
                'view': 'unknown',
                'regions': [],
                'explanation': 'Placeholder - real Glimmer not wired in test',
                'needs_view': None,
                'sources': [],
                'provenance': {'glimmer_model':'muse-glimmer-hackathon','sam_model':None}
            }
            self._json(200, resp)
        except Exception as e:
            self._json(500, {'error':'internal'})
        finally:
            lock.release()

    def log_message(self, *args):
        return
