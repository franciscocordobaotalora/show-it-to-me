"""Offline tests for the hosted SAM 3.1 backend (sam_meta). The Meta call is mocked; masks are real one-bit rasters
encoded with the vendored official codec, so decode, placement and polygon logic are exercised for real."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('META_API_KEY', 'test-key-not-real')
import sam_meta  # noqa: E402
from meta_sam_parser._mask_codec import _encode_raster  # noqa: E402

try:
    import cv2  # noqa: F401
    HAVE_CV2 = True
except Exception:
    HAVE_CV2 = False


def raster_text(box, frame, rows, cols, ones):
    """Build one `<0f>0<|box..|><|mask..|>` match. ones = set of (row, col) that are 1."""
    bits = [1 if (r, c) in ones else 0 for r in range(rows) for c in range(cols)]
    payload = _encode_raster(bits, cols, rows)           # starts with '!' (one_bit)
    x1, y1, x2, y2 = box
    w, h = frame
    return '<0f>0<|box;x1=%d;y1=%d;x2=%d;y2=%d;w=%d;h=%d|><|mask;x=0;y=0;data=%d,%d,%s|>' % (
        x1, y1, x2, y2, w, h, rows, cols, payload)


class FakeImage:
    """Stands in for a PIL image: the backend only needs id(), convert, thumbnail, save and size."""
    def __init__(self, w=200, h=100):
        from PIL import Image
        self.im = Image.new('RGB', (w, h), (120, 120, 120))
    def convert(self, mode):
        return self.im.convert(mode)


BLOCK = {(r, c) for r in range(6) for c in range(10)}     # a 6x10 raster that is all ones


class ParseTests(unittest.TestCase):
    def test_parse_roundtrip_data_is_rows_then_cols(self):
        txt = raster_text((20, 10, 30, 16), (100, 60), 6, 10, BLOCK)
        objs = sam_meta.parse_objects(txt)
        self.assertEqual(len(objs), 1)
        self.assertEqual(objs[0]['box'], (20.0, 10.0, 30.0, 16.0))
        self.assertEqual(objs[0]['frame'], (100, 60))
        self.assertEqual(objs[0]['mask'].shape, (6, 10))
        self.assertTrue(objs[0]['mask'].all())

    def test_empty_text_is_zero_matches(self):
        self.assertEqual(sam_meta.parse_objects(''), [])

    def test_two_matches_paired_in_order(self):
        txt = raster_text((0, 0, 10, 6), (100, 60), 6, 10, BLOCK) + raster_text((50, 20, 60, 26), (100, 60), 6, 10, BLOCK)
        objs = sam_meta.parse_objects(txt)
        self.assertEqual([o['box'][0] for o in objs], [0.0, 50.0])

    def test_full_mask_places_raster_inside_its_box_only(self):
        txt = raster_text((20, 10, 30, 16), (100, 60), 6, 10, BLOCK)
        obj = sam_meta.parse_objects(txt)[0]
        full = sam_meta._full_mask(obj, (200, 120))          # image sent is twice the frame: boxes scale by 2
        self.assertEqual(full.shape, (120, 200))
        self.assertEqual(int(full[24, 50]), 1)               # inside (box is 40..60 x 20..32)
        self.assertEqual(int(full[24, 10]), 0)               # outside
        self.assertEqual(int(full[60, 50]), 0)

    def test_box_prompt_format_and_clamp(self):
        self.assertEqual(sam_meta.build_box_prompt((10.4, 20.6, 50, 80), (200, 100)),
                         '<0f>1<|box;x1=10;y1=21;x2=50;y2=80;w=200;h=100|>')
        self.assertEqual(sam_meta.build_box_prompt((-5, -5, 500, 500), (200, 100)),
                         '<0f>1<|box;x1=0;y1=0;x2=200;y2=100;w=200;h=100|>')


@unittest.skipUnless(HAVE_CV2, 'cv2 not installed here; the Atlas server and sysvenv run these')
class SegmentTests(unittest.TestCase):
    def setUp(self):
        self.img = FakeImage(200, 100)
        self.calls = []
        self._orig = sam_meta._post

    def tearDown(self):
        sam_meta._post = self._orig

    def mock(self, text_reply, box_reply):
        def fake(b64, text, timeout=None):
            self.calls.append(text)
            return box_reply if text.startswith('<0f>') else text_reply
        sam_meta._post = fake

    def test_text_candidate_overlapping_muse_box_is_chosen(self):
        reply = raster_text((80, 30, 120, 60), (200, 100), 6, 10, BLOCK)
        self.mock(reply, '')
        r = sam_meta.segment(self.img, {'sam_prompt': 'metal bracket', 'label': 'bracket', 'box_1000': [400, 300, 600, 600]})
        self.assertIsNotNone(r)
        self.assertEqual(r['selection'], 'text_overlap')
        self.assertGreaterEqual(len(r['polygon']), 3)
        self.assertGreater(r['selection_debug']['text_iou'], 0.9)

    def test_falls_back_to_box_prompt_when_text_finds_nothing(self):
        reply = raster_text((80, 30, 120, 60), (200, 100), 6, 10, BLOCK)
        self.mock('', reply)
        r = sam_meta.segment(self.img, {'sam_prompt': 'tiny port', 'label': 'port', 'box_1000': [400, 300, 600, 600]})
        self.assertEqual(r['selection'], 'box_prompt')
        self.assertTrue(any(c.startswith('<0f>1<|box;') for c in self.calls))

    def test_text_candidate_far_from_muse_box_is_ignored(self):
        far = raster_text((0, 0, 20, 12), (200, 100), 6, 10, BLOCK)
        near = raster_text((80, 30, 120, 60), (200, 100), 6, 10, BLOCK)
        self.mock(far, near)
        r = sam_meta.segment(self.img, {'sam_prompt': 'part', 'label': 'part', 'box_1000': [400, 300, 600, 600]})
        self.assertEqual(r['selection'], 'box_prompt')

    def test_zero_matches_everywhere_returns_none(self):
        self.mock('', '')
        self.assertIsNone(sam_meta.segment(self.img, {'sam_prompt': 'x', 'label': 'x', 'box_1000': [400, 300, 600, 600]}))

    def test_all_calls_failing_raises_sam_error(self):
        def boom(b64, text, timeout=None):
            raise RuntimeError('sam_error: meta call failed: 401')
        sam_meta._post = boom
        with self.assertRaises(RuntimeError) as cm:
            sam_meta.segment(self.img, {'sam_prompt': 'x', 'label': 'x', 'box_1000': [400, 300, 600, 600]})
        self.assertIn('sam_error', str(cm.exception))


class KeyTests(unittest.TestCase):
    def test_load_requires_key(self):
        old = os.environ.pop('META_API_KEY', None)
        try:
            with self.assertRaises(RuntimeError):
                sam_meta.load()
        finally:
            if old is not None:
                os.environ['META_API_KEY'] = old


if __name__ == '__main__':
    unittest.main()
