import unittest, io, base64, os
from server import analyze
from PIL import Image
import json

def make_data_url():
    img = Image.new('RGB',(10,10),'white')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    b64 = base64.b64encode(buf.getvalue()).decode()
    return 'data:image/png;base64,'+b64

class FakeGlimmer:
    def __init__(self, resp):
        self.resp = resp
    def pass1(self, data_url, question, ref):
        return self.resp
    def pass2(self, *a, **kw):
        return 'fallback answer'

class FakeSamObserved:
    def segment(self, img, target):
        # return small observed mask well within gate
        return {'polygon': [[0.2,0.2],[0.3,0.2],[0.3,0.3]], 'bbox': [0.2,0.2,0.3,0.3], 'score': 0.9, 'selection': 'overlap', 'selection_debug': {}}

class FakeSamNone:
    def segment(self, img, target):
        return None

class FakeSamLarge:
    def segment(self, img, target):
        # bbox area 0.9 => >0.85 should trigger fallback
        return {'polygon': [[0,0],[1,0],[1,1],[0,1]], 'bbox': [0.0,0.0,0.95,0.95], 'score': 0.9, 'selection': 'box_prompt', 'selection_debug': {}}

class TestT09OpenVocabulary(unittest.TestCase):
    def test_generic_returns_open_vocab_fields(self):
        resp = {
            'view':'unknown','is_pi_board': False, 'needs_view': None,
            'answer': 'This is a red mug. It is used for drinking. Handle on the side makes it easy to hold.',
            'targets': [{'id':'0','label':'red mug','sam_prompt':'red ceramic mug','box_1000':[100,100,400,400]}]
        }
        data={'frameId':'f','requestId':'r','question':'What is this?','image':make_data_url()}
        status, body = analyze(data, FakeGlimmer(resp), FakeSamObserved())
        self.assertEqual(status,200)
        self.assertEqual(len(body['regions']),1)
        r=body['regions'][0]
        self.assertEqual(r['label'],'red mug')
        self.assertEqual(r['status'],'observed')
        self.assertIsNotNone(r['polygon'])
        # answer preserved 2-3 sentences
        self.assertIn('red mug', body['explanation'].lower() if 'red mug' in body['explanation'].lower() else body['explanation'])
        self.assertTrue(len(body['explanation'].split('.'))>=2)

    def test_answer_in_question_language(self):
        resp={
            'view':'unknown','is_pi_board': False,
            'answer': 'Ceci est une tasse rouge. Elle sert à boire du café. La poignée facilite la prise en main.',
            'targets': [{'id':'0','label':'tasse rouge','sam_prompt':'tasse rouge en céramique','box_1000':[100,100,200,200]}]
        }
        data={'frameId':'f','requestId':'r','question':'Qu’est-ce que c’est?','image':make_data_url()}
        status, body = analyze(data, FakeGlimmer(resp), FakeSamObserved())
        self.assertEqual(status,200)
        self.assertIn('tasse', body['explanation'].lower())

    def test_is_pi_board_false_no_needs_view(self):
        resp={
            'view':'unknown','is_pi_board': False, 'needs_view':'flip_board',
            'answer': 'Item found.',
            'targets': [{'id':'0','label':'red mug','sam_prompt':'mug','box_1000':[10,10,100,100]}]
        }
        data={'frameId':'f','requestId':'r','question':'where is sd card?','image':make_data_url()}
        status, body = analyze(data, FakeGlimmer(resp), FakeSamObserved())
        self.assertEqual(status,200)
        # when is_pi_board False, needs_view must be None regardless of pass1
        self.assertIsNone(body['needs_view'])

    def test_pi_board_true_uses_optional_boost(self):
        resp={
            'view':'top','is_pi_board': True, 'needs_view': None,
            'answer': 'Power goes to USB-C port on the Pi.',
            'targets': [{'id':'1','part':'usb_c_power_port','label':'USB-C power port','sam_prompt':'usb-c power port','box_1000':[100,100,200,200]}]
        }
        data={'frameId':'f','requestId':'r','question':'Where does power go?','image':make_data_url()}
        status, body = analyze(data, FakeGlimmer(resp), FakeSamObserved())
        self.assertEqual(status,200)
        self.assertEqual(body['regions'][0]['label'],'USB-C power port')
        self.assertEqual(body['regions'][0]['status'],'observed')

    def test_quality_gate_85_fallback_box(self):
        resp={
            'view':'unknown','is_pi_board': False,
            'answer': 'Found red box.',
            'targets': [{'id':'0','label':'red box','sam_prompt':'red box','box_1000':[100,100,300,300]}]
        }
        data={'frameId':'f','requestId':'r','question':'What is this?','image':make_data_url()}
        status, body = analyze(data, FakeGlimmer(resp), FakeSamLarge())
        self.assertEqual(status,200)
        r=body['regions'][0]
        # area 0.9025 >0.85 should fallback to glimmer box dashed outline
        self.assertEqual(r['status'],'fallback_box')
        self.assertEqual(r['source'],'glimmer_box')
        self.assertIsNotNone(r['polygon'])
        self.assertEqual(len(r['polygon']),4)
        # bbox should be from box_1000 normalized
        self.assertAlmostEqual(r['bbox'][0],0.1, places=2)

    def test_sam_none_fallback_box(self):
        resp={
            'view':'unknown','is_pi_board': False,
            'answer': 'This is an item. It looks interesting. See highlighted area.',
            'targets': [{'id':'0','label':'blue bottle','sam_prompt':'blue bottle','box_1000':[50,50,250,350]}]
        }
        data={'frameId':'f','requestId':'r','question':'What is that?','image':make_data_url()}
        status, body = analyze(data, FakeGlimmer(resp), FakeSamNone())
        self.assertEqual(status,200)
        r=body['regions'][0]
        self.assertEqual(r['status'],'fallback_box')
        self.assertIsNotNone(r['bbox'])
        self.assertIsNotNone(r['polygon'])

    def test_never_empty_answer(self):
        resp={
            'view':'unknown','is_pi_board': False,
            'answer': '',
            'targets': []
        }
        data={'frameId':'f','requestId':'r','question':'What is this?','image':make_data_url()}
        status, body = analyze(data, FakeGlimmer(resp), FakeSamObserved())
        self.assertEqual(status,200)
        self.assertTrue(body['explanation'] and len(body['explanation'].strip())>0)

class TestT09UI(unittest.TestCase):
    def test_no_pi5_in_ui(self):
        # check static files have no Pi 5 text
        import pathlib
        base = pathlib.Path(__file__).resolve().parents[1]
        index = (base / 'static' / 'index.html').read_text(encoding='utf-8')
        self.assertNotIn('Pi 5', index)
        self.assertNotIn('pi 5', index.lower().replace('point your camera at anything and ask.', ''))  # allow subtitle
        # title
        self.assertIn('<title>Show It To Me</title>', index)
        # subtitle
        self.assertIn('Point your camera at anything and ask.', index)
        # chips
        self.assertIn('What is this?', index)
        self.assertIn('What is that part called?', index)
        self.assertIn('How does this work?', index)
        self.assertNotIn('SD card', index)
        # footer should not contain Pi 5
        self.assertNotIn('Pi 5', index)

if __name__ == '__main__':
    unittest.main()
