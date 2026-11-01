import unittest, os, tempfile, urllib.error
import server

class TestSpeak(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.mktemp()
        os.environ['SIT_EVENT_LOG']=self.tmp
    def tearDown(self):
        if 'SIT_EVENT_LOG' in os.environ: del os.environ['SIT_EVENT_LOG']
        try: os.unlink(self.tmp)
        except: pass
    def test_success_stream(self):
        pcm=b'\x00\x01'*48000
        def fake(text, base, token):
            self.assertEqual(token,'tok123')
            return 200, {}, pcm
        code, body, _ = server.handle_speak_request('Hello world.', 'tok123', 'http://x', forward_fn=fake)
        self.assertEqual(code,200)
        self.assertEqual(body['pcm'], pcm)
        if os.path.exists(self.tmp):
            txt=open(self.tmp).read()
            self.assertNotIn('tok123', txt)
    def test_401(self):
        def fake(text, base, token):
            raise urllib.error.HTTPError('url',401,'unauth',None,None)
        code, body, _ = server.handle_speak_request('hi','tok','http://x', forward_fn=fake)
        self.assertEqual(code,502)
    def test_timeout(self):
        def fake(text, base, token):
            raise TimeoutError('timeout')
        code, body, _ = server.handle_speak_request('hi','tok','http://x', forward_fn=fake)
        self.assertEqual(code,504)
    def test_over_length(self):
        code, body, _ = server.handle_speak_request('a'*401,'tok','http://x')
        self.assertEqual(code,400)
        self.assertIn('error', body)

if __name__=='__main__':
    unittest.main()
