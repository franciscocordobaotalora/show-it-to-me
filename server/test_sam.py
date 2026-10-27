import unittest

class TestSam(unittest.TestCase):
    def test_import_skip(self):
        import unittest
        self.skipTest('SAM real import skipped in CI')

if __name__ == '__main__':
    unittest.main()
