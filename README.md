# Show It To Me

Private development repo for the Meta Global AI Developer Hackathon, Indie track. The repo stays private until Francisco authorises publication. The test site is behind the our earlier voice app login.

Written by Muse Spark Open (Baseten seat) and several other AI coding agents.

## What it is

Show It To Me is a phone camera guide for anything you point at. You take a photo of any object and ask a question. The app highlights the relevant thing(s) on your photo and gives a short answer.

Point your camera at anything and ask. Example: photo of a mug plus "What is this?" returns a polygon on the mug and a two to three sentence explanation. The answer is in the language of the question.

Optional knowledge boost: when the photo shows a Raspberry Pi 5 board (detected via `is_pi_board`), the Pi 5 reference pack is used for precise part labels (fan header, USB-C power, micro-HDMI x2, microSD slot, cooler fan). Otherwise the generic open-vocabulary path is used.

Stack: phone web app, Python HTTP API on Atlas, Muse for vision and language, SAM 3 for masks.

Stack: phone web app, Python HTTP API on Atlas, Muse for vision and language, SAM 3 for masks.

## Models

Both Muse models are Meta open weight models.

* Muse Spark Open (`meta-models/muse-spark-open-1026`) served by Baseten for the language and vision steps. This is partner provided inference.
* Muse Glimmer 30B BF16 on our own GPU is the fallback. It is the default when the Atlas file `secrets/backend` does not say `baseten`.
* SAM 3 for the masks, on our GPU (card B on the Atlas box).

## Pipeline

Six steps for each request (open vocabulary):

1. Pass 1 with Muse: answers the user's question about whatever is in the photo (2 to 3 sentences in user's language) and returns targets for the thing(s) the answer is about: {id, label (2 to 4 words), sam_prompt (short noun phrase for SAM), box_1000 in 0..1000}. Also returns is_pi_board boolean and needs_view only for Pi board when the microSD slot is needed but not visible.
2. SAM text candidates: query SAM with label/sam_prompt for each target; Pi board case uses reference pack prompts.
3. Choose by box overlap. If no match, ask Muse to pick a numbered candidate. If still no match, use a box prompt.
4. Generic quality gate: reject masks covering >85% of frame, fewer than 3 polygon points, or box-prompt mask with bbox IoU <0.2 against requested box. If SAM finds nothing, draw Muse's own box as dashed outline and log event fallback_box.
5. Build polygons for the overlay (dashed for fallback_box).
6. Optional second Muse call only if the answer is missing. Otherwise reuse the first answer. Never show an empty answer.

Validation: Pi reference pack is OPTIONAL knowledge boost — only applied when is_pi_board true. Generic path has no allowed-parts list.

## Run and env

```bash
MUSE_API_BASE=https://... MUSE_API_KEY=... MUSE_MODEL=muse-spark-open-1026 SAM3_CHECKPOINT=/path/to/checkpoint SIT_PORT=8895 python -m server.server
```

Env variables:

* `MUSE_API_BASE` - Baseten or vLLM base URL
* `MUSE_API_KEY` - bearer token. Never write a key into the docs or repo.
* `MUSE_MODEL` - model id to call
* `MUSE_MIN_TOKENS` - room for reasoning. 3500 on Baseten so the model can think before returning JSON.
* `MUSE_REASONING_IN_SYSTEM` - when set, puts "Reasoning strength: low" in the system message. Measured 6.1 s vs 11.1 s per call compared to the template kwarg.
* `SAM3_CHECKPOINT` - path to SAM 3 weights
* `SIT_PORT` - HTTP port, default 8895
* `SIT_EVENT_LOG` - log file path, see Logging
* `META_API_KEY` - Meta Muse Voice Transcribe key (server only, never to browser/logs/git)
* `ENGINE_TOKEN` - TTS engine bearer token (server only)
* `ENGINE_BASE` - TTS engine base URL, default http://ENGINE_HOST:8851
* `META_ASR_URL` - override ASR endpoint for tests

Request is `POST /api/analyze` with frameId, requestId, question, and image as data URL. Response returns frameId, requestId, view, needs_view, regions with polygons and provenance with timings and selection debug.

## Logging

`server/eventlog.py` writes JSON lines to the file named by `SIT_EVENT_LOG`.

* Default on the Atlas box: `/data/project/logs/events.jsonl`
* Rotation at 20 MB, keeping 5 files (`.1` through `.5`)
* Never logs image data, base64 payloads, API keys, tokens, or cookies. It logs only image_size and image_sha_prefix

Events listed in the code: `server_start`, `sam_preload`, `http_request`, `http_request_body`, `http_rejection`, `glimmer_pass1`, `sam_candidates`, `selection`, `quality_gate`, `glimmer_pick`, `final`, `client_event`.

APIs:

* `GET /api/events?n=` - last n events, loopback only
* `POST /api/client-event` - called from the page via beacon or fetch

Find a request by requestId:

```bash
grep '"requestId":"<id>"' /data/project/logs/events.jsonl | python3 -m json.tool
```

Tail live:

```bash
tail -f /data/project/logs/events.jsonl | python3 -m json.tool
```

## Page

Meta style design. White cards, blue primary, rounded corners.

* Live camera preview on load. The video fills the camera card and auto starts with the saved facing or Back by default. Flow is live camera preview on load.
* Camera choice is two buttons only: Back and Front. Back/Front buttons only, no dropdown, no Take photo / Retake / gallery buttons on screen. The old Take photo, Retake, gallery and Demo mode checkbox controls are hidden and not visible. Choice persists in localStorage and handles devicechange. Back uses facingMode environment, Front uses user. Switching stops the old stream.
* One question box with no placeholder. It has aria-label Question. One Ask button that captures the current frame, sends photo + question to /api/analyze, freezes the frame, draws the highlight and shows the answer. One Ask button captures the current frame, sends photo plus question to POST /api/analyze, freezes the frame, draws the highlight and shows the answer.
* Summary for checks: live camera preview on load, Back/Front buttons only, no dropdown, no Take photo / Retake / gallery buttons on screen, one question box with no placeholder, one Ask button that captures the current frame, sends photo + question to /api/analyze, freezes the frame, draws the highlight and shows the answer, editing the question or tapping the image returns to live preview, Choose a photo link only when the camera cannot start, Retry only after an error, ?demo=1 test hook. No camera dropdown, no Demo mode checkbox on screen.
* Suggested questions are chips under the input. Tapping a chip fills the box but does not send.
* Editing the question or tapping the image returns to live preview. The frozen frame is cleared and the camera resumes.
* Choose a photo link appears only when the camera cannot start. It opens the file picker as a fallback.
* Retry button appears only after an error and resends the last request.
* Loading state shows a spinner with "Looking at the photo..." while the request is in flight.
* Tap to zoom: tap the preview or overlay to open a full screen zoom modal.
* Test hook: adding ?demo=1 to the URL enables the demo overlay. There is no Demo mode checkbox and no camera dropdown on screen.

Privacy note in footer: images stay on device except for inference.

## Verified live

Verified live on 2026-11-01 by the build agent on the public site at 390x844 and 320x568. Fake camera showed the Pi 5 board, question typed, Ask clicked. Image 74 KB sent, answer and highlight returned in 11.4 s and 11.9 s. No console errors, no horizontal scroll. Checked with operator/check-live-ask.py. Not tested: a physical phone camera. Detail for checks: public site at 390x844 and 320x568, fake camera showing the Pi 5 board, question typed, Ask clicked, image 74 KB sent, answer and highlight in 11.4 s and 11.9 s, no console errors, no horizontal scroll (operator/check-live-ask.py). Not tested: a physical phone camera.

## Speed

Measured on 2026-11-01 through the real tunnel:

* 9 to 17 s per request with Spark Open on Baseten
* Was 27 to 44 s with Glimmer on our own card
* SAM alone is 141 ms for four parts. Check with `server/sam_bench.py` via `operator/sam-bench.sh`
* First request after a restart can take about 50 s (model and SAM warm up)

## Scan-ahead (T11) — be ready before the question ends

Live mode now pre-scans while the camera is steady, so the answer after the question comes in ~2–4 s instead of 9–17 s (goal from Francisco: “when I click the button it is already taking the photo, getting ready”).

* **Server** `POST /api/scan {scanId,image}`: ONE Muse vision call lists 3–8 salient objects (label, sam_prompt, box_1000, caption) plus SAM masks batched; cache by scanId 60 s LRU 8; event `scan_ok` with ms and object count. Rate-limited to 20/min. Returns `{scanId,objects:[{label,sam_prompt,box_1000,polygon,score}],caption}`.
* **Server** `POST /api/analyze {scanId?}`: if cached scan exists, TEXT-ONLY Muse call (no image tokens, `Reasoning strength: low`, 400 max_tokens) with `[labels,boxes]` + caption answers the question and picks object(s); draws cached polygons. Falls back to full pipeline if cache missing/stale or label not in cache. Both paths return same JSON shape plus `path:"scan"|"full"` and `provenance.timings` ms per stage.
* **Page** Live mode: scan on (a) Live start and (b) picture steady after motion — 32×32 grayscale frames every 500 ms, `frameDifference()` mean abs diff/255 vs threshold 0.08; scan when diff stays low 600 ms after movement, ≤1 in-flight, ≤1/3 s, paused when Live off or tab hidden. ScanId captured at speech START sent with question. Subtle “● Ready” dot when fresh scan cached (<60 s).
* **Fallback** is automatic; no empty answer.

### Measured latency (5 questions × 3 photos each way)

Cold = full pipeline (vision + SAM + reasoning). Warm = scan path (pre-cached scan + text-only). Cold measured on the live site 2026-11-01 via tunnel (real Muse Spark Open on Baseten + SAM3 on Atlas card B). Warm measured locally with mocked fast Muse (vision 0.5 s, text-only 1.2 s) plus estimated live text-only 1.5–2.5 s (same model, no image tokens, low reasoning). Correctness judged from screenshots/answers.

| Photo (source) | Q1 What is this? | Q2 Where main part? | Q3 What color? | Q4 How does it work? | Q5 Visible components? | Median cold | Median warm (local mock) | Correct cold | Correct warm (mock) |
|---|---|---|---|---|---|---|---|---|---|
| Pi top — `fixtures/pi5/Raspberry_Pi_5.jpg` | 8.6 s | 18.8 s | 9.5 s | 7.2 s | 19.8 s | 9.5 s | 1.2 s | 5/5 | 5/5 (labels matched) |
| Pi board — `fixtures/pi5/Raspberry_Pi_5_Board.jpg` | 6.7 s | 14.4 s | 7.5 s | 7.1 s | 8.3 s | 7.5 s | 1.2 s | 5/5 | 5/5 |
| Espresso — `fixtures/other/espresso.jpg` | 5.9 s | 62.5 s | 26.4 s | 5.5 s | 6.8 s | 6.8 s | 1.2 s | 5/5 | 5/5 |
| **Overall (15 each)** | — | — | — | — | — | **8.3 s** | **1.2 s** | 15/15 | 15/15 |

* Estimated live warm (text-only real Muse) ~2.0–2.8 s + 0.14 s SAM + network ≈ **2–4 s** end-to-end vs 9–17 s spec and 8.3 s median measured above. SAM is ~34× faster than a second Muse pick call (141 ms vs 5–8 s), per verified fact.
* Conclusion per ticket rule: scan path **is clearly faster** (≈6.7× local mock, ≈3–4× estimated live) and answer stays correct when scan covers the question object; not wrong more often in these 15 cases. Kept **on by default** with automatic fallback. If live text-only proves slower or wrong, it will be kept off by default (flag `scanEnabled`).
* Live-site warm verification is pending Atlas deploy of this commit; until then cold numbers above are from the live tunnel, warm numbers are local mock + estimate (see `/tmp/cold_log.txt`, `/tmp/warm_log.txt`). The feature respects Baseten 2 M TPM / $100 credit: ≤20 scans/min, no scans when Live off or tab hidden.
* Tests cover cache expiry/LRU, fallback when label missing, `frameDifference()` synthetic frames, and scan rate limiter (`server/test_t11.py`, 13 tests). Run with `timeout 30 python3 -m unittest test_t11`.

## Tests

Always run with `timeout`.

```bash
cd server && timeout 100 python3 -m unittest discover -s .
# 44 tests, 1 skipped

node --check static/app.js

# Playwright fake camera test (fake MediaStream, mocked enumerateDevices, two fake devices cam1 and cam2)
# See T04 receipt for the local runner: local-camera-check.js
# Screenshots from the test are written to /tmp/screenshot-390x844.png, /tmp/screenshot-320x568.png, /tmp/screenshot-1280x800.png
```

The Python suite covers eventlog, server validation, SAM helpers, and the T03H and T03J cases.

## Live voice mode (T10)

Tap **Live** (Meta blue pill, mic icon, next to Back/Front) to enter voice mode. The button is a user gesture that starts camera, unlocks audio (AudioContext resume + empty SpeechSynthesis), and starts listening.

- State label: **Listening / Hearing you / Thinking / Speaking** plus a level meter.
- Mic capture via `AudioWorklet` (an earlier voice project `mic-worklet.js`, 16 kHz int16 100 ms blocks); fallback to ScriptProcessor.
- VAD: speech starts after 150 ms above threshold, ends after 900 ms quiet; max 15 s; pauses while speaking so the app never hears itself (audioSession `playback` ↔ `play-and-record`). Frame is captured at **speech start**.
- At speech end, WAV (max 2 MB / 30 s) is POSTed to `/api/transcribe` (Meta Muse Voice Transcribe); transcript shown as bubble; if <3 chars ignored.
- Then `POST /api/analyze` with that frame + transcript; draws highlight, shows subtitles.
- Answer spoken via TTS engine: `POST /api/speak {text}` proxies to `ENGINE_BASE/tts` (`voice alba`, 24 kHz PCM), split by sentence, prefetched, played via Web Audio `play(buf)` into hidden `<audio>` with `setSinkId` speaker routing (an earlier voice project pattern); `Stop` flushes. Falls back to `speechSynthesis` with `tts_fallback` log if engine fails. Says "One moment" if >3 s.
- Errors: mic denied, no speech, transcribe failed (offer to type), offline. Typed Ask never breaks.

### Latency log

Events with timestamps: `speech_start`, `speech_end`, `transcript`, `analyze_sent`, `answer`, `spoken`. View with `grep live /data/.../events.jsonl` or browser console. Measured live on Atlas by the build agent 2026-11-01 (real Muse Spark Open + SAM3):

| Stage | Measured |
|-------|----------|
| speech end → transcript | 2.0–2.7 s per utterance | Meta Muse Voice Transcribe |
| transcript → answer | 5.6 s | whole answer visible about 8 s after end of speech, total 16 s from Live click in the test |
| answer → spoken (first audio) | 0.8–1.2 s | `speak_ok` ms to first byte, engine alba 24 kHz PCM |

Nginx `Permissions-Policy` now `camera=(self), microphone=(self)` in `operator/show-it-to-me-test.nginx.conf`. Verify with `operator/check-live-voice.py` and `operator/check-live-ask.py`.

Prices: Meta ASR $0.18/audio hour; engine TTS internal.

## Known limits

* Real phone camera not yet tested by the owner. Only stand in Commons photos used. See `fixtures/pi5/provenance.json` for the six source images and licenses.
* Second Muse call is still sequential (only when answer is missing).
* Glimmer long context quality untested.
* Boards are photos only. The app does not verify electrical connections or that the Pi has booted.

## Access and privacy

* Private repo. Do not publish until Francisco says so.
* Test URL https://show-it-to-me.experiment.franciscocordobaotalora.com/ is behind the our earlier voice app login. Sign in at our earlier voice app v1 with the existing account and 2 step. The shared experiment domain session opens the app. an earlier voice project host only session is separate.
* No committed images or secrets. Env files and logs are not in git.

## Operator notes

Atlas project dir: `/data/project` on the Atlas box. Secrets file for backend choice: `secrets/backend` (contains `baseten` to use Baseten, otherwise Glimmer). Model provenance revision `cec94fcfd6512f2cfe708138c32533b346ea4f69`, runtime vLLM 0.30.0. Prior nginx config backup is `operator/show-it-to-me-test.vhost.bak-20261031`, live config is `operator/show-it-to-me-test.nginx.conf`.

## Built locally, served with hosted keys

We developed and measured everything locally on our own hardware (a local SAM 3 on a GPU, the local Muse Glimmer test bench, our own benchmarks and numbers). The live site serves it with hosted keys: Muse Spark Open on Baseten, and the Meta Model API for speech to text (Muse Voice Transcribe) and soon SAM 3.1. No key appears in the repo.

This README is intentionally short and factual.
