import unittest
from server import analyze
from PIL import Image
import io, base64

class FakeGlimmer:
    def __init__(self, pass1_resp, raise_error=None):
        self.pass1_resp = pass1_resp
        self.raise_error = raise_error
    def pass1(self, data_url, question, ref):
        if self.raise_error:
            raise self.raise_error
        return self.pass1_resp
    def pass2(self, *args):
        return 'fallback'

class FakeSam:
    def segment(self, img, target):
        part = target.get('part')
        # simulate garbage board mask
        if part == 'board':
            return {'polygon': [[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]], 'bbox': [0.0,0.0,0.9,0.9], 'score':0.9, 'selection':'box_prompt'}
        return {'polygon': [[0.2,0.2],[0.3,0.2],[0.3,0.3]], 'bbox': [0.2,0.2,0.3,0.3], 'score':0.8, 'selection':'overlap'}

def make_data_url():
    img = Image.new('RGB',(10,10),'white')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    b64 = base64.b64encode(buf.getvalue()).decode()
    return 'data:image/png;base64,'+b64

class TestT03J(unittest.TestCase):
    def test_needs_view_empty_regions(self):
        data = {'frameId':'f','requestId':'r','question':'where microsd','image':make_data_url()}
        glimmer = FakeGlimmer({'view':'top','needs_view':'flip_board','targets':[{'id':'1','part':'microsd_slot','sam_prompt':'sd','box_1000':[100,100,200,200]}]})
        status, body = analyze(data, glimmer, FakeSam())
        self.assertEqual(status,200)
        # regions should be empty due to needs_view filter
        self.assertEqual(body['regions'],[])

    def test_quality_gate_large_bbox(self):
        data = {'frameId':'f','requestId':'r','question':'q','image':make_data_url()}
        # large bbox >85% should trigger generic quality gate fallback_box
        glimmer = FakeGlimmer({'view':'top','needs_view':None,'targets':[{'id':'1','part':'board','sam_prompt':'board','box_1000':[100,100,200,200]}]})
        class SamLarge:
            def segment(self, img, target):
                return {'polygon': [[0,0],[1,0],[1,1]], 'bbox': [0.0,0.0,0.95,0.95], 'score':0.9, 'selection':'box_prompt'}
        status, body = analyze(data, glimmer, SamLarge())
        self.assertEqual(status,200)
        # quality gate should reject large bbox -> fallback to Glimmer box dashed outline
        self.assertEqual(body['regions'][0]['status'],'fallback_box')
        self.assertEqual(body['regions'][0]['source'],'glimmer_box')

    def test_quality_gate_small_polygon(self):
        data = {'frameId':'f','requestId':'r','question':'q','image':make_data_url()}
        glimmer = FakeGlimmer({'view':'top','needs_view':None,'targets':[{'id':'1','part':'fan_connector','sam_prompt':'fan','box_1000':[100,100,200,200]}]})
        class SamSmallPoly:
            def segment(self, img, target):
                return {'polygon': [[0.1,0.1],[0.2,0.1]], 'bbox': [0.1,0.1,0.2,0.2], 'score':0.9, 'selection':'overlap'}
        status, body = analyze(data, glimmer, SamSmallPoly())
        self.assertEqual(status,200)
        self.assertEqual(body['regions'][0]['status'],'fallback_box')

    def test_quality_gate_box_prompt_iou(self):
        data = {'frameId':'f','requestId':'r','question':'q','image':make_data_url()}
        glimmer = FakeGlimmer({'view':'top','needs_view':None,'targets':[{'id':'1','part':'fan_connector','sam_prompt':'fan','box_1000':[100,100,200,200]}]})
        class SamBadIoU:
            def segment(self, img, target):
                # bbox far from requested box
                return {'polygon': [[0.1,0.1],[0.2,0.1],[0.2,0.2]], 'bbox': [0.7,0.7,0.8,0.8], 'score':0.9, 'selection':'box_prompt'}
        status, body = analyze(data, glimmer, SamBadIoU())
        self.assertEqual(status,200)
        self.assertEqual(body['regions'][0]['status'],'fallback_box')

    def test_answer_from_pass1(self):
        data = {'frameId':'f','requestId':'r','question':'q','image':make_data_url()}
        glimmer = FakeGlimmer({'view':'top','needs_view':None,'answer':'Fan header found.','targets':[{'id':'1','label':'fan header','sam_prompt':'fan','box_1000':[100,100,200,200]}]})
        status, body = analyze(data, glimmer, FakeSam())
        self.assertEqual(status,200)
        self.assertEqual(body['explanation'],'Fan header found.')

    def test_template_fallback(self):
        data = {'frameId':'f','requestId':'r','question':'q','image':make_data_url()}
        glimmer = FakeGlimmer({'view':'top','needs_view':None,'targets':[]})
        # pass2 will be used as fallback
        status, body = analyze(data, glimmer, FakeSam())
        self.assertEqual(status,200)
        self.assertTrue(body['explanation'])

    def test_selection_debug_present(self):
        data = {'frameId':'f','requestId':'r','question':'q','image':make_data_url()}
        glimmer = FakeGlimmer({'view':'top','needs_view':None,'targets':[{'id':'1','part':'fan_connector','sam_prompt':'fan','box_1000':[100,100,200,200]}]})
        status, body = analyze(data, glimmer, FakeSam())
        self.assertEqual(status,200)
        self.assertIn('selection_debug', body['regions'][0])

    def test_steps_provenance(self):
        data = {'frameId':'f','requestId':'r','question':'q','image':make_data_url()}
        glimmer = FakeGlimmer({'view':'top','needs_view':None,'targets':[]})
        status, body = analyze(data, glimmer, FakeSam())
        self.assertEqual(status,200)
        prov = body['provenance']
        self.assertIn('steps', prov)
        names = [s['name'] for s in prov['steps']]
        self.assertIn('pass1', names)
        self.assertIn('sam', names)

if __name__ == '__main__':
    unittest.main()
