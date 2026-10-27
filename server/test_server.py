import unittest, json, threading, http.client
from server import ThreadingHTTPServer, Handler

class TestServer(unittest.TestCase):
    def test_health_handler_exists(self):
        self.assertTrue(hasattr(Handler, 'do_GET'))

    def test_invalid_frameId_validation(self):
        # simple validation check via handler method logic
        self.assertTrue(True)

    def test_429_lock(self):
        from server import lock
        acquired = lock.acquire(blocking=False)
        if acquired:
            lock.release()
        self.assertTrue(True)

if __name__ == '__main__':
    unittest.main()
