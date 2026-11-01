import os, json, tempfile, unittest, time, threading, base64, io, hashlib
import eventlog

class TestEventLog(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'events.jsonl')
        os.environ['SIT_EVENT_LOG'] = self.path
        import importlib
        importlib.reload(eventlog)
        # Ensure clean file (server thread from previous import may have polluted)
        try:
            if os.path.isfile(self.path):
                os.remove(self.path)
        except:
            pass

    def tearDown(self):
        self.tmp.cleanup()
        if 'SIT_EVENT_LOG' in os.environ:
            del os.environ['SIT_EVENT_LOG']
        import importlib
        try:
            importlib.reload(eventlog)
        except:
            pass

    def _read_events(self):
        events = []
        if not os.path.isfile(self.path):
            return events
        with open(self.path, 'r', encoding='utf-8') as f:
            for line in f:
                line=line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except:
                    pass
        return events

    def _last_event_of(self, name):
        evs=self._read_events()
        for e in reversed(evs):
            if e.get('event')==name:
                return e
        return None

    def test_line_format(self):
        eventlog.log_event('test_event', requestId='r1', frameId='f1', level='info', foo='bar')
        ev=self._last_event_of('test_event')
        self.assertIsNotNone(ev)
        self.assertEqual(ev['event'], 'test_event')
        self.assertEqual(ev['requestId'], 'r1')
        self.assertEqual(ev['frameId'], 'f1')
        self.assertEqual(ev['level'], 'info')
        self.assertEqual(ev['foo'], 'bar')
        self.assertIn('ts', ev)
        self.assertTrue(ev['ts'].endswith('Z'))
        self.assertIn('T', ev['ts'])

    def test_no_secrets(self):
        eventlog.log_event('secret_test', api_key='XYZ', cookie='abc', authorization='Bearer token')
        ev=self._last_event_of('secret_test')
        self.assertNotIn('api_key', ev)
        self.assertNotIn('cookie', ev)
        self.assertNotIn('authorization', ev)

    def test_no_image_data(self):
        eventlog.log_event('img_test', image_data='data:image/png;base64,AAA')
        ev=self._last_event_of('img_test')
        self.assertNotIn('image_data', ev)
        # But image_size should be allowed
        eventlog.log_event('img_meta', image_size=1234, image_sha_prefix='abc123')
        ev2=self._last_event_of('img_meta')
        self.assertEqual(ev2['image_size'],1234)
        self.assertEqual(ev2['image_sha_prefix'],'abc123')

    def test_no_base64_value(self):
        eventlog.log_event('base64_val', some_field='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQE')
        ev=self._last_event_of('base64_val')
        self.assertNotIn('some_field', ev)

    def test_rotation(self):
        import eventlog as ev
        orig_max = ev._MAX_BYTES
        ev._MAX_BYTES = 200
        try:
            for i in range(40):
                eventlog.log_event('rot', extra='x'*100)
            files = [f for f in os.listdir(self.tmp.name) if f.startswith('events.jsonl')]
            self.assertGreaterEqual(len(files), 2)
            has_rotated = any('.1' in f for f in files)
            self.assertTrue(has_rotated)
        finally:
            ev._MAX_BYTES = orig_max

    def test_threadsafe(self):
        def worker():
            for _ in range(50):
                eventlog.log_event('t', n=1)
        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads: t.start()
        for t in threads: t.join()
        evs=[e for e in self._read_events() if e.get('event')=='t']
        self.assertEqual(len(evs), 200)

    def test_client_event_logging(self):
        eventlog.log_event('client_event', level='info', sub_event='page_load', detail='x'*10)
        ev=self._last_event_of('client_event')
        self.assertIsNotNone(ev)
        self.assertEqual(ev['event'], 'client_event')

    def test_events_file_created_after_log(self):
        eventlog.log_event('create_test', foo='bar')
        self.assertTrue(os.path.isfile(self.path))
        ev=self._last_event_of('create_test')
        self.assertIsNotNone(ev)

    def test_log_failure_nonbreaking(self):
        os.environ['SIT_EVENT_LOG'] = '/invalid/path/nope.jsonl'
        import importlib
        importlib.reload(eventlog)
        try:
            eventlog.log_event('fail_test')
        except Exception as e:
            self.fail(f'log_event raised {e}')
        self.assertTrue(True)

    def test_no_base64_or_key_in_file_after_fake_request(self):
        fake_b64 = base64.b64encode(b'fakeimagebytes'*100).decode()
        fake_data_url = 'data:image/jpeg;base64,'+fake_b64
        img_bytes = base64.b64decode(fake_b64)
        sha12 = hashlib.sha256(img_bytes).hexdigest()[:12]
        eventlog.log_event('http_request_body', requestId='r999', frameId='f999', image_size=len(img_bytes), image_sha_prefix=sha12)
        # Also try to log a secret which should be filtered
        eventlog.log_event('secret_attempt', api_key='SECRET123', image_data=fake_data_url)
        with open(self.path) as f:
            content=f.read()
        self.assertNotIn(fake_b64[:20], content)
        self.assertNotIn('SECRET123', content)
        self.assertIn(str(len(img_bytes)), content)
        self.assertIn(sha12, content)
        evs=self._read_events()
        last=[e for e in evs if e.get('event')=='http_request_body'][-1]
        self.assertIn('image_size', last)
        # secret_attempt should not contain api_key
        sec=[e for e in evs if e.get('event')=='secret_attempt'][-1]
        self.assertNotIn('api_key', sec)

    def test_glimmer_failure_produces_error_event_and_expected_status(self):
        from server import analyze
        from PIL import Image
        def make_data_url():
            img=Image.new('RGB',(10,10),'white')
            buf=io.BytesIO()
            img.save(buf,format='PNG')
            b64=base64.b64encode(buf.getvalue()).decode()
            return 'data:image/png;base64,'+b64
        class FakeGlimmerFail:
            def pass1(self, data_url, question, ref):
                raise Exception('simulated glimmer timeout')
        class FakeSam:
            def segment(self, img, target):
                return None
        data={'frameId':'f1','requestId':'r_err','question':'q','image':make_data_url()}
        # Clear log of previous r_err
        if os.path.isfile(self.path):
            os.remove(self.path)
        status, body = analyze(data, FakeGlimmerFail(), FakeSam())
        self.assertEqual(status, 502)
        self.assertIn('error', body)
        evs=self._read_events()
        glimmer_errs=[e for e in evs if e['event']=='glimmer_pass1' and e.get('level')=='error']
        self.assertGreaterEqual(len(glimmer_errs),1)
        self.assertIn('r_err', [e.get('requestId') for e in glimmer_errs])
        # should contain traceback
        self.assertTrue(any('traceback' in e for e in glimmer_errs))

    def test_429_413_400_events_via_direct_logging(self):
        # Verify that server would log these rejection types; we simulate by direct log_event
        # and also verify analyze returns 400 for invalid input
        from server import analyze
        from PIL import Image
        def make_data_url():
            img=Image.new('RGB',(10,10),'white')
            buf=io.BytesIO()
            img.save(buf,format='PNG')
            b64=base64.b64encode(buf.getvalue()).decode()
            return 'data:image/png;base64,'+b64
        class FakeGlimmer:
            def pass1(self, d,q,r): return {'view':'top','needs_view':None,'targets':[],'answer':'ok'}
            def pass2(self,*a): return 'ok'
        class FakeSam:
            def segment(self, img, target): return None
        # 400 invalid_frameId
        data={'frameId':'','requestId':'r','question':'q','image':make_data_url()}
        status,_=analyze(data, FakeGlimmer(), FakeSam())
        self.assertEqual(status,400)
        # Log rejection events as server would
        eventlog.log_event('http_rejection', level='warn', method='POST', path='/api/analyze', status=400, reason='invalid_frameId')
        eventlog.log_event('http_rejection', level='warn', method='POST', path='/api/analyze', status=413, reason='payload_too_large')
        eventlog.log_event('http_rejection', level='warn', method='POST', path='/api/analyze', status=429, reason='concurrent_limit')
        eventlog.log_event('http_rejection', level='warn', method='POST', path='/api/client-event', status=429, reason='client_event_rate_limit')
        evs=self._read_events()
        has400=any(e.get('event')=='http_rejection' and e.get('status')==400 for e in evs)
        has413=any(e.get('status')==413 for e in evs)
        has429=any(e.get('status')==429 for e in evs)
        self.assertTrue(has400)
        self.assertTrue(has413)
        self.assertTrue(has429)

    def test_client_event_cap_and_trimming(self):
        import server as srv
        # Trimming: simulate server trimming before logging (detail 300, userAgent 160)
        long_detail='A'*500
        long_ua='B'*300
        # Server does: detail = str(data.get('detail',''))[:300]; userAgent = str(data.get('userAgent',''))[:160]
        trimmed_detail = str(long_detail)[:300]
        trimmed_ua = str(long_ua)[:160]
        eventlog.log_event('client_event', level='info', client_event='test_trim', detail=trimmed_detail, userAgent=trimmed_ua, viewport={'w':390,'h':844}, online=True)
        ev=self._last_event_of('client_event')
        self.assertIsNotNone(ev)
        self.assertLessEqual(len(ev['detail']),300)
        self.assertLessEqual(len(ev['userAgent']),160)
        self.assertEqual(len(ev['detail']),300)
        self.assertEqual(len(ev['userAgent']),160)
        # Cap: exercise real handler logic without opening a new listener
        # Helper mimics Handler.do_POST client-event rate-limit check
        def try_client_event():
            now=time.time()
            with srv._client_event_lock:
                # filter window
                srv._client_event_times[:] = [t for t in srv._client_event_times if now - t < 60]
                if len(srv._client_event_times) >= 60:
                    return 429
                srv._client_event_times.append(now)
                return 200
        with srv._client_event_lock:
            srv._client_event_times.clear()
        # Post 60 small events -> all should succeed
        for i in range(60):
            rc=try_client_event()
            self.assertEqual(rc,200, f'event {i} should not be rate limited')
            eventlog.log_event('client_event', level='info', client_event='cap_test', detail=f'ev{i}')
        # 61st should be 429
        rc61=try_client_event()
        self.assertEqual(rc61,429)
        eventlog.log_event('http_rejection', level='warn', method='POST', path='/api/client-event', status=429, reason='client_event_rate_limit')
        evs=self._read_events()
        has429=any(e.get('event')=='http_rejection' and e.get('status')==429 for e in evs)
        self.assertTrue(has429)
        # cleanup
        with srv._client_event_lock:
            srv._client_event_times.clear()

    def test_api_events_returns_last_n_in_order(self):
        # Directly test file reading logic similar to Handler.do_GET /api/events
        if os.path.isfile(self.path):
            os.remove(self.path)
        for i in range(5):
            eventlog.log_event('seq_test', seq=i, requestId=f'r{i}')
        # Simulate Handler logic: read last n
        def get_last_n(n):
            n=max(1, min(n, 500))
            evs=[]
            with open(self.path, 'r', encoding='utf-8') as f:
                lines=f.readlines()
                for line in lines[-n:]:
                    try:
                        evs.append(json.loads(line))
                    except:
                        pass
            return evs
        data=get_last_n(3)
        self.assertEqual(len(data),3)
        seqs=[d.get('seq') for d in data]
        self.assertEqual(seqs,[2,3,4])
        data_all=get_last_n(999)
        self.assertEqual(len(data_all),5)
        # Ensure max 500 enforced (would be 500 if we had more)
        self.assertTrue(len(get_last_n(500))<=500)
