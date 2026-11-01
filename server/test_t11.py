import unittest, json, base64, io, time
from unittest.mock import MagicMock

def make_data_url(color='white', size=(10,10)):
    from PIL import Image
    img = Image.new('RGB', size, color)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    b64 = base64.b64encode(buf.getvalue()).decode()
    return 'data:image/png;base64,'+b64

class FakeGlimmerScan:
    def __init__(self, scan_resp=None, answer_resp=None, raise_scan=None, raise_answer=None):
        self._scan_resp = scan_resp
        self._answer_resp = answer_resp
        self.raise_scan = raise_scan
        self.raise_answer = raise_answer
        self.scan_calls = 0
        self.answer_calls = 0
    def scan(self, data_url):
        self.scan_calls+=1
        if self.raise_scan:
            raise self.raise_scan
        return self._scan_resp
    def scan_answer(self, objects, caption, question):
        self.answer_calls+=1
        if self.raise_answer:
            raise self.raise_answer
        return self._answer_resp
    def pass1(self, *a, **kw):
        return {'view':'top','needs_view':None,'targets':[{'id':'x','label':'fallback target','sam_prompt':'target','box_1000':[100,100,200,200]}], 'answer':'Fallback answer.'}
    def pass2(self, *a, **kw):
        return 'fallback'

class FakeSamScan:
    def __init__(self, polygon=None):
        self.calls=[]
        self._poly = polygon or [[0.1,0.1],[0.2,0.1],[0.2,0.2]]
    def segment(self, img, target):
        self.calls.append(target)
        return {'polygon': self._poly, 'bbox':[0.1,0.1,0.2,0.2], 'score':0.9}

class TestScanCache(unittest.TestCase):
    def test_cache_set_get(self):
        import server
        server._scan_cache.clear()
        server._scan_times.clear()
        fake_glim = FakeGlimmerScan(scan_resp={'caption':'a scene','objects':[
            {'label':'red mug','sam_prompt':'mug','box_1000':[100,100,300,400]},
            {'label':'blue book','sam_prompt':'book','box_1000':[400,400,600,600]},
            {'label':'green bottle','sam_prompt':'bottle','box_1000':[10,10,80,80]},
        ]})
        fake_sam = FakeSamScan()
        data = {'scanId':'s1','image': make_data_url()}
        status, body = server.handle_scan_request(data, fake_glim, fake_sam)
        self.assertEqual(status,200)
        self.assertEqual(body['scanId'],'s1')
        self.assertGreaterEqual(len(body['objects']),3)
        # cached hit should not call glimmer again
        fake_glim2 = FakeGlimmerScan(scan_resp={'caption':'should not be used','objects':[]})
        fake_glim2.scan_calls=0
        status2, body2 = server.handle_scan_request({'scanId':'s1','image': make_data_url()}, fake_glim2, fake_sam)
        self.assertEqual(status2,200)
        self.assertEqual(fake_glim2.scan_calls,0)
        self.assertEqual(body2['caption'],'a scene')

    def test_cache_expiry(self):
        import server, time
        server._scan_cache.clear()
        server._scan_times.clear()
        # set entry with old ts
        server._scan_cache_set('old', {'scanId':'old','objects':[],'caption':'old'})
        # manually age it
        server._scan_cache['old']['ts'] = time.time() - 61
        # get should return None and remove
        v = server._scan_cache_get('old')
        self.assertIsNone(v)
        # fresh entry should remain
        server._scan_cache_set('fresh', {'scanId':'fresh','objects':[],'caption':'fresh'})
        v2 = server._scan_cache_get('fresh')
        self.assertIsNotNone(v2)

    def test_cache_lru_eviction(self):
        import server
        server._scan_cache.clear()
        server._scan_times.clear()
        for i in range(9):
            server._scan_cache_set(f'id{i}', {'scanId':f'id{i}','objects':[],'caption':f'c{i}'})
        self.assertEqual(len(server._scan_cache), 8)
        # oldest should be evicted (id0)
        self.assertNotIn('id0', server._scan_cache)
        self.assertIn('id8', server._scan_cache)

    def test_rate_limiter_blocks_after_20(self):
        import server
        server._scan_times.clear()
        server._scan_cache.clear()
        fake_glim = FakeGlimmerScan(scan_resp={'caption':'c','objects':[{'label':'a','sam_prompt':'a','box_1000':[0,0,100,100]}]})
        fake_sam = FakeSamScan()
        # 20 should succeed
        for i in range(20):
            st,_ = server.handle_scan_request({'scanId':f's{i}','image': make_data_url()}, fake_glim, fake_sam)
            self.assertNotEqual(st,429)
        # 21st should be rate limited
        st,_ = server.handle_scan_request({'scanId':'s21','image': make_data_url()}, fake_glim, fake_sam)
        self.assertEqual(st,429)

    def test_frame_diff_identical(self):
        import server
        a = [100]*1024
        b = [100]*1024
        self.assertAlmostEqual(server.frame_diff(a,b), 0.0, places=4)

    def test_frame_diff_opposite(self):
        import server
        a = [0]*1024
        b = [255]*1024
        self.assertAlmostEqual(server.frame_diff(a,b), 1.0, places=4)

    def test_frame_diff_partial(self):
        import server
        a = [0]*1024
        b = [0]*512 + [255]*512
        # half differs fully => 0.5
        self.assertAlmostEqual(server.frame_diff(a,b), 0.5, places=3)

    def test_frame_diff_threshold(self):
        import server
        # identical low diff below threshold should not trigger movement
        a = [100]*1024
        b = [110]*1024  # diff 10/255 ~0.039 <0.08
        diff = server.frame_diff(a,b)
        self.assertLess(diff, server.SCAN_FRAME_THRESHOLD)
        # larger diff > threshold
        c = [200]*1024
        diff2 = server.frame_diff(a,c)
        self.assertGreater(diff2, server.SCAN_FRAME_THRESHOLD)

class TestScanFallback(unittest.TestCase):
    def test_scan_path_success(self):
        import server
        server._scan_cache.clear()
        server._scan_times.clear()
        fake_glim = FakeGlimmerScan(scan_resp={'caption':'scene with mugs','objects':[
            {'label':'red mug','sam_prompt':'mug','box_1000':[100,100,300,400]},
            {'label':'blue book','sam_prompt':'book','box_1000':[400,400,600,600]},
            {'label':'green bottle','sam_prompt':'bottle','box_1000':[10,10,80,80]},
        ]}, answer_resp={'answer':'It is a red mug for drinking.','selected':['red mug']})
        fake_sam = FakeSamScan()
        # populate cache via scan
        st, body = server.handle_scan_request({'scanId':'scanA','image': make_data_url()}, fake_glim, fake_sam)
        self.assertEqual(st,200)
        # now analyze with scanId should use fast path
        data = {'frameId':'f1','requestId':'r1','question':'what is the mug?','image': make_data_url(), 'scanId':'scanA'}
        st2, resp = server.analyze(data, fake_glim, fake_sam)
        self.assertEqual(st2,200)
        self.assertEqual(resp.get('path'),'scan')
        self.assertIn('scan', resp.get('provenance',{}).get('path',''))
        self.assertEqual(len(resp['regions']),1)
        self.assertEqual(resp['regions'][0]['label'],'red mug')

    def test_fallback_when_label_missing(self):
        import server
        server._scan_cache.clear()
        server._scan_times.clear()
        fake_glim = FakeGlimmerScan(scan_resp={'caption':'scene','objects':[
            {'label':'red mug','sam_prompt':'mug','box_1000':[100,100,300,400]},
            {'label':'blue book','sam_prompt':'book','box_1000':[400,400,600,600]},
        ]}, answer_resp={'answer':'It is unknown item','selected':['green bottle']})  # not in cache
        fake_sam = FakeSamScan()
        st, body = server.handle_scan_request({'scanId':'scanB','image': make_data_url()}, fake_glim, fake_sam)
        self.assertEqual(st,200)
        data = {'frameId':'f1','requestId':'r1','question':'what?','image': make_data_url(), 'scanId':'scanB'}
        st2, resp = server.analyze(data, fake_glim, fake_sam)
        # should fallback to full path
        self.assertEqual(st2,200)
        self.assertEqual(resp.get('path'),'full')

    def test_fallback_when_cache_missing(self):
        import server
        server._scan_cache.clear()
        server._scan_times.clear()
        fake_glim = FakeGlimmerScan(scan_resp={'caption':'c','objects':[]}, answer_resp={'answer':'a','selected':['x']})
        fake_sam = FakeSamScan()
        data = {'frameId':'f1','requestId':'r1','question':'what?','image': make_data_url(), 'scanId':'nonexistent'}
        st2, resp = server.analyze(data, fake_glim, fake_sam)
        self.assertEqual(st2,200)
        self.assertEqual(resp.get('path'),'full')

    def test_fallback_when_stale(self):
        import server, time
        server._scan_cache.clear()
        server._scan_times.clear()
        fake_glim = FakeGlimmerScan(scan_resp={'caption':'c','objects':[
            {'label':'red mug','sam_prompt':'mug','box_1000':[100,100,300,400]},
        ]}, answer_resp={'answer':'a','selected':['red mug']})
        fake_sam = FakeSamScan()
        st,_ = server.handle_scan_request({'scanId':'stale','image': make_data_url()}, fake_glim, fake_sam)
        self.assertEqual(st,200)
        # age cache
        server._scan_cache['stale']['ts'] = time.time() - 61
        data = {'frameId':'f1','requestId':'r1','question':'q','image': make_data_url(), 'scanId':'stale'}
        st2, resp = server.analyze(data, fake_glim, fake_sam)
        self.assertEqual(resp.get('path'),'full')

    def test_scan_answer_no_image_tokens(self):
        import glimmer, urllib.request, json
        captured={}
        class DummyResp:
            def __enter__(self): return self
            def __exit__(self,*a): pass
            def read(self): return json.dumps({'choices':[{'message':{'content': json.dumps({'answer':'It is a mug','selected':['mug']})}}]}).encode()
        def fake_urlopen(req, timeout=60):
            captured['body']=req.data
            return DummyResp()
        orig=urllib.request.urlopen
        urllib.request.urlopen=fake_urlopen
        try:
            glimmer.MUSE_API_BASE='http://example.com'
            glimmer.MUSE_API_KEY='k'
            objs=[{'label':'mug','box_1000':[100,100,200,200]}]
            glimmer.scan_answer(objs,'a caption','what is this?')
            payload=json.loads(captured['body'])
            msgs=payload['messages']
            # ensure no image_url in messages
            for m in msgs:
                content=m.get('content')
                if isinstance(content, list):
                    for part in content:
                        self.assertNotEqual(part.get('type'),'image_url')
                elif isinstance(content, str):
                    self.assertNotIn('base64', content)
        finally:
            urllib.request.urlopen=orig

if __name__=='__main__':
    unittest.main()
