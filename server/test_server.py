import unittest, json, base64, io
from server import analyze
from reference import get_part_side

class FakeGlimmer:
    def __init__(self, response, raise_error=None):
        self.response = response
        self.raise_error = raise_error
    def pass1(self, data_url, question, ref):
        if self.raise_error:
            raise self.raise_error
        return self.response
    def pass2(self, view, targets, question):
        return 'explanation'

class FakeSam:
    def segment(self, img, prompt):
        return []

def make_data_url():
    from PIL import Image
    img = Image.new('RGB',(10,10),'white')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    b64 = base64.b64encode(buf.getvalue()).decode()
    return 'data:image/png;base64,'+b64

class TestAnalyze(unittest.TestCase):
    def test_valid(self):
        data = {'frameId':'f1','requestId':'r1','question':'q','image':make_data_url()}
        status, body = analyze(data, FakeGlimmer({'view':'top','needs_view':None,'targets':[]}), FakeSam())
        self.assertEqual(status,200)
        self.assertEqual(body['frameId'],'f1')

    def test_invalid_frameId(self):
        data = {'frameId':'','requestId':'r1','question':'q','image':make_data_url()}
        status, body = analyze(data, FakeGlimmer({}), FakeSam())
        self.assertEqual(status,400)

    def test_microsd_needs_view(self):
        data = {'frameId':'f','requestId':'r','question':'where microsd','image':make_data_url()}
        glimmer = FakeGlimmer({'view':'top','needs_view':None,'targets':[{'id':'1','part':'microsd_slot'}]})
        status, body = analyze(data, glimmer, FakeSam())
        self.assertEqual(body['needs_view'],'flip_board')

    def test_sam_unavailable(self):
        class BadSam:
            def segment(self, img, prompt):
                raise RuntimeError('sam_unavailable')
        data = {'frameId':'f','requestId':'r','question':'q','image':make_data_url()}
        status, body = analyze(data, FakeGlimmer({'view':'top','needs_view':None,'targets':[]}), BadSam())
        self.assertEqual(status,200)
        self.assertEqual(body['regions'],[])

if __name__ == '__main__':
    unittest.main()
