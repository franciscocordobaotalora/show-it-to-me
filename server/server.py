import json, io, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

MAX_SIZE = 10*1024*1024
MAX_QUESTION = 2000
lock = threading.Lock()
in_flight = False

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/health':
            self.send_response(200)
            self.send_header('Content-Type','application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status':'ok'}).encode())
        else:
            self.send_error(404)

    def do_POST(self):
        global in_flight
        if self.path != '/api/analyze':
            self.send_error(404); return
        if in_flight:
            self.send_response(429); self.end_headers(); return
        in_flight = True
        try:
            length = int(self.headers.get('Content-Length',0))
            if length > MAX_SIZE:
                self.send_response(413); self.end_headers(); return
            body = self.rfile.read(length)
            data = json.loads(body)
            # validation
            frameId = data.get('frameId')
            requestId = data.get('requestId')
            question = data.get('question','')
            image_b64 = data.get('image')
            if not frameId or not requestId or not question:
                self.send_response(400); self.end_headers(); return
            if len(question) > MAX_QUESTION:
                self.send_response(400); self.end_headers(); return
            # placeholder response
            resp = {
                'frameId': frameId,
                'requestId': requestId,
                'view': 'unknown',
                'regions': [],
                'explanation': 'Demo placeholder - real Muse not connected',
                'needs_view': None,
                'sources': [],
                'provenance': {'glimmer_model':'muse-glimmer-hackathon'}
            }
            self.send_response(200)
            self.send_header('Content-Type','application/json')
            self.end_headers()
            self.wfile.write(json.dumps(resp).encode())
        except Exception as e:
            self.send_response(500)
            self.end_headers()
        finally:
            in_flight = False

    def log_message(self, *args):
        return

def run():
    server = ThreadingHTTPServer(('127.0.0.1',8895), Handler)
    server.serve_forever()
