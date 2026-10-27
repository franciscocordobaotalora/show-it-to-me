import unittest
from PIL import Image
import glimmer

class TestT03H(unittest.TestCase):
    def test_pick_candidate_payload_contains_image_url(self):
        import urllib.request, json
        captured = {}
        class DummyResp:
            def __enter__(self): return self
            def __exit__(self,*a): pass
            def read(self):
                return json.dumps({'choices':[{'message':{'content':'0'}}]}).encode()
        def fake_urlopen(req, timeout=120):
            captured['body'] = req.data
            return DummyResp()
        orig = urllib.request.urlopen
        urllib.request.urlopen = fake_urlopen
        try:
            glimmer.MUSE_API_BASE = 'http://example.com'
            glimmer.MUSE_API_KEY = 'k'
            img = Image.new('RGB',(10,10),'white')
            res = glimmer.pick_candidate(img, 'desc', 3)
            self.assertEqual(res,0)
            payload = json.loads(captured['body'])
            msgs = payload['messages']
            self.assertIsInstance(msgs[1]['content'], list)
            self.assertEqual(msgs[1]['content'][0]['type'],'image_url')
        finally:
            urllib.request.urlopen = orig

    def test_pick_candidate_out_of_range(self):
        import urllib.request, json
        class DummyResp:
            def __enter__(self): return self
            def __exit__(self,*a): pass
            def read(self):
                return json.dumps({'choices':[{'message':{'content':'5'}}]}).encode()
        def fake_urlopen(req, timeout=120):
            return DummyResp()
        orig = urllib.request.urlopen
        urllib.request.urlopen = fake_urlopen
        try:
            glimmer.MUSE_API_BASE = 'http://example.com'
            glimmer.MUSE_API_KEY = 'k'
            img = Image.new('RGB',(10,10),'white')
            res = glimmer.pick_candidate(img, 'desc', 3)
            self.assertIsNone(res)
        finally:
            urllib.request.urlopen = orig

    def test_pick_candidate_minus_one(self):
        import urllib.request, json
        class DummyResp:
            def __enter__(self): return self
            def __exit__(self,*a): pass
            def read(self):
                return json.dumps({'choices':[{'message':{'content':'-1'}}]}).encode()
        def fake_urlopen(req, timeout=120):
            return DummyResp()
        orig = urllib.request.urlopen
        urllib.request.urlopen = fake_urlopen
        try:
            glimmer.MUSE_API_BASE = 'http://example.com'
            glimmer.MUSE_API_KEY = 'k'
            img = Image.new('RGB',(10,10),'white')
            res = glimmer.pick_candidate(img, 'desc', 3)
            self.assertIsNone(res)
        finally:
            urllib.request.urlopen = orig

if __name__ == '__main__':
    unittest.main()
