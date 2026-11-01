import unittest, os, json, struct, tempfile, urllib.error
import server

def make_wav(duration_ms=1000, sample_rate=16000):
    n=int(sample_rate*duration_ms/1000)
    header=bytearray(44)
    header[0:4]=b'RIFF'
    struct.pack_into('<I', header, 4, 36 + n*2)
    header[8:12]=b'WAVE'
    header[12:16]=b'fmt '
    struct.pack_into('<I', header, 16, 16)
    struct.pack_into('<H', header, 20, 1)
    struct.pack_into('<H', header, 22, 1)
    struct.pack_into('<I', header, 24, sample_rate)
    struct.pack_into('<I', header, 28, sample_rate*2)
    struct.pack_into('<H', header, 32, 2)
    struct.pack_into('<H', header, 34, 16)
    header[36:40]=b'data'
    struct.pack_into('<I', header, 40, n*2)
    pcm=b'\x00\x00'*n
    return bytes(header)+pcm

class TestTranscribe(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.mktemp()
        os.environ['SIT_EVENT_LOG']=self.tmp
    def tearDown(self):
        if 'SIT_EVENT_LOG' in os.environ: del os.environ['SIT_EVENT_LOG']
        try: os.unlink(self.tmp)
        except: pass
    def test_success(self):
        def fake(wav_bytes, key):
            self.assertEqual(key,'test-key')
            return {'transcript':'hello world','audioDurationMs':1000}
        wav=make_wav(500)
        code, body = server.handle_transcribe_request(wav, 'test-key', forward_fn=fake)
        self.assertEqual(code,200)
        self.assertEqual(body['transcript'],'hello world')
        self.assertIn('ms', body)
        if os.path.exists(self.tmp):
            txt=open(self.tmp).read()
            self.assertNotIn('test-key', txt)
    def test_meta_400(self):
        def fake(wav_bytes, key):
            raise urllib.error.HTTPError('url',400,'bad', None, None)
        wav=make_wav(500)
        code, body = server.handle_transcribe_request(wav, 'k', forward_fn=fake)
        self.assertEqual(code,400)
    def test_timeout(self):
        def fake(wav_bytes, key):
            raise TimeoutError('timed out')
        wav=make_wav(500)
        code, body = server.handle_transcribe_request(wav, 'k', forward_fn=fake)
        self.assertEqual(code,504)
        self.assertIn('transcribe_timeout', body['error'])
    def test_key_missing(self):
        wav=make_wav(200)
        code, body = server.handle_transcribe_request(wav, None)
        self.assertEqual(code,503)
        self.assertIn('error', body)
        self.assertIn('message', body)
    def test_too_large(self):
        wav=b'x'*(2*1024*1024+10)
        code, body = server.handle_transcribe_request(wav, 'k')
        self.assertEqual(code,413)

if __name__=='__main__':
    unittest.main()
