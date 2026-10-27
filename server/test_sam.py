import unittest
import numpy as np
from sam import box1000_to_cxcywh, iou, pick_by_iou, mask_to_polygon

class TestSamHelpers(unittest.TestCase):
    def test_box1000_to_cxcywh_full(self):
        cxcywh = box1000_to_cxcywh([0,0,1000,1000])
        self.assertAlmostEqual(cxcywh[0], 0.5)
        self.assertAlmostEqual(cxcywh[1], 0.5)
        self.assertAlmostEqual(cxcywh[2], 1.0)
        self.assertAlmostEqual(cxcywh[3], 1.0)

    def test_box1000_to_cxcywh_partial(self):
        cxcywh = box1000_to_cxcywh([100,200,300,400])
        self.assertAlmostEqual(cxcywh[0], 0.2)
        self.assertAlmostEqual(cxcywh[1], 0.3)
        self.assertAlmostEqual(cxcywh[2], 0.2)
        self.assertAlmostEqual(cxcywh[3], 0.2)

    def test_iou_identical(self):
        a = [0,0,10,10]
        b = [0,0,10,10]
        self.assertAlmostEqual(iou(a,b), 1.0)

    def test_iou_disjoint(self):
        a = [0,0,5,5]
        b = [10,10,15,15]
        self.assertAlmostEqual(iou(a,b), 0.0)

    def test_iou_partial(self):
        a = [0,0,10,10]
        b = [5,5,15,15]
        # intersection 5x5=25, union 100+100-25=175
        self.assertAlmostEqual(iou(a,b), 25/175)

    def test_pick_by_iou(self):
        boxes = [[0,0,10,10], [20,20,30,30]]
        glimmer = [1,1,9,9]
        idx, best = pick_by_iou(boxes, glimmer)
        self.assertEqual(idx, 0)
        self.assertGreater(best, 0.5)

    def test_mask_to_polygon_rectangle(self):
        w, h = 100, 100
        mask = np.zeros((h,w), dtype=np.uint8)
        mask[20:80, 30:70] = 255
        try:
            import cv2
        except Exception:
            self.skipTest('cv2 not available')
        poly = mask_to_polygon(mask, w, h)
        self.assertTrue(len(poly) > 0)
        # polygon points should be within [0,1]
        for x,y in poly:
            self.assertGreaterEqual(x, 0.0)
            self.assertLessEqual(x, 1.0)
            self.assertGreaterEqual(y, 0.0)
            self.assertLessEqual(y, 1.0)
        # bbox approx
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        self.assertAlmostEqual(min(xs), 0.3, delta=0.05)
        self.assertAlmostEqual(min(ys), 0.2, delta=0.05)

if __name__ == '__main__':
    unittest.main()
