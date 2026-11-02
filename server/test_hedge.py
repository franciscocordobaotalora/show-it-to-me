import os, sys, time, unittest, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('MUSE_API_BASE', 'http://x'); os.environ.setdefault('MUSE_API_KEY', 'k')
import glimmer


class HedgeTests(unittest.TestCase):
    def test_fast_call_is_not_hedged(self):
        calls = []
        def fn():
            calls.append(1); return 'a'
        self.assertEqual(glimmer._hedged(fn, 0.3), 'a')
        time.sleep(0.4)
        self.assertEqual(len(calls), 1)

    def test_slow_first_call_loses_to_second(self):
        calls = []
        def fn():
            calls.append(1)
            n = len(calls)
            time.sleep(2.0 if n == 1 else 0.05)
            return 'slow' if n == 1 else 'fast'
        t = time.time()
        self.assertEqual(glimmer._hedged(fn, 0.2), 'fast')
        self.assertLess(time.time() - t, 1.0)

    def test_failure_of_one_attempt_uses_the_other(self):
        calls = []
        def fn():
            calls.append(1)
            n = len(calls)
            if n == 1:
                time.sleep(0.3); raise RuntimeError('boom')
            time.sleep(0.4); return 'ok'
        self.assertEqual(glimmer._hedged(fn, 0.1), 'ok')

    def test_both_fail_raises(self):
        def fn():
            time.sleep(0.2); raise RuntimeError('boom')
        with self.assertRaises(RuntimeError):
            glimmer._hedged(fn, 0.05)


class ReasoningParamTests(unittest.TestCase):
    def test_reasoning_effort_is_sent_and_system_hack_is_not(self):
        seen = {}
        class R:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s): return b'{"choices":[{"message":{"content":"{}"}}]}'
        def fake_urlopen(req, timeout=None):
            seen['payload'] = json.loads(req.data); return R()
        old = (glimmer.urllib.request.urlopen, glimmer.REASONING_EFFORT, glimmer.HEDGE_S)
        glimmer.urllib.request.urlopen = fake_urlopen; glimmer.REASONING_EFFORT = 'minimal'; glimmer.HEDGE_S = 0
        try:
            glimmer._post_chat([{'role': 'system', 'content': 'S'}, {'role': 'user', 'content': 'U'}], max_tokens=100)
        finally:
            glimmer.urllib.request.urlopen, glimmer.REASONING_EFFORT, glimmer.HEDGE_S = old
        p = seen['payload']
        self.assertEqual(p['reasoning_effort'], 'minimal')
        self.assertNotIn('chat_template_kwargs', p)
        self.assertEqual(p['messages'][0]['content'], 'S')


if __name__ == '__main__':
    unittest.main()
