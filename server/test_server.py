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

    def test_contract_segment_receives_target_dict(self):
        class RecordingSam:
            def __init__(self):
                self.calls = []
            def segment(self, img, target):
                self.calls.append((img, target))
                assert isinstance(target, dict)
                assert 'part' in target
                assert 'sam_prompt' in target
                # return different results per target
                if target.get('id') == 'a':
                    return {'polygon': [[0.1,0.1],[0.2,0.1],[0.2,0.2]], 'bbox': [0.1,0.1,0.2,0.2], 'score': 0.8}
                return None
        rec = RecordingSam()
        data = {'frameId':'f','requestId':'r','question':'q','image':make_data_url()}
        targets = [
            {'id':'a','part':'fan_connector','sam_prompt':'fan','box_1000':[100,100,200,200]},
            {'id':'b','part':'usb_c_power_port','sam_prompt':'usb','box_1000':None}
        ]
        glimmer = FakeGlimmer({'view':'top','needs_view':None,'targets':targets})
        status, body = analyze(data, glimmer, rec)
        self.assertEqual(status,200)
        self.assertEqual(len(body['regions']),2)
        r0 = body['regions'][0]
        self.assertEqual(r0['id'],'a')
        self.assertEqual(r0['status'],'observed')
        self.assertEqual(r0['source'],'sam3')
        self.assertIsNotNone(r0['polygon'])
        self.assertAlmostEqual(r0['score'],0.8)
        r1 = body['regions'][1]
        self.assertEqual(r1['id'],'b')
        self.assertEqual(r1['status'],'not_found')
        self.assertIsNone(r1['polygon'])
        self.assertEqual(len(rec.calls),2)

    def test_sam_error_status(self):
        class BoomSam:
            def segment(self, img, target):
                raise RuntimeError('boom')
        data = {'frameId':'f','requestId':'r','question':'q','image':make_data_url()}
        glimmer = FakeGlimmer({'view':'top','needs_view':None,'targets':[{'id':'1','part':'board','sam_prompt':'board'}]})
        status, body = analyze(data, glimmer, BoomSam())
        self.assertEqual(status,200)
        self.assertEqual(body['regions'],[])
        self.assertEqual(body['provenance']['sam_model'],'sam_error')

if __name__ == '__main__':
    unittest.main()
