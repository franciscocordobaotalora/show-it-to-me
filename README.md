# Show It To Me

Private development repo for the Meta Global AI Developer Hackathon, Indie track. The repo stays private until Francisco authorises publication. The test site is behind the our earlier voice app login.

Written by Muse Spark Open (Baseten seat) and several other AI coding agents.

## What it is

Show It To Me is a phone camera guide for a Raspberry Pi 5. You take a photo of the board and ask a question. The app highlights the relevant part on your photo and gives a short answer.

Supported parts: fan header (the 4 pin FAN socket), USB-C power port, micro-HDMI x2 (two ports), microSD slot, and cooler fan.

Example: photo plus "Where does the power go?" returns a polygon on the USB-C port and a one or two sentence answer.

Stack: phone web app, Python HTTP API on Atlas, Muse for vision and language, SAM 3 for masks.

## Models

Both Muse models are Meta open weight models.

* Muse Spark Open (`meta-models/muse-spark-open-1026`) served by Baseten for the language and vision steps. This is partner provided inference.
* Muse Glimmer 30B BF16 on our own GPU is the fallback. It is the default when the Atlas file `secrets/backend` does not say `baseten`.
* SAM 3 for the masks, on our GPU (card B on the Atlas box).

## Pipeline

Six steps for each request:

1. Pass 1 with Muse: view (top, underside, unknown), targets (part, sam_prompt, box in 0..1000), answer (up to two sentences), and needs_view if the board must be flipped or moved closer.
2. SAM text candidates: query SAM with prompts like "port" or "white connector" for each target.
3. Choose by box overlap. If no match, ask Muse to pick a numbered candidate. If still no match, use a box prompt.
4. Quality gate: drop low quality masks.
5. Build polygons for the overlay.
6. Optional second Muse call only if the answer is missing. Otherwise reuse the first answer.

Validation enforces the reference pack and the needs_view rule for the microSD slot (underside).

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

* Live camera preview starts on load. The video fills the camera card and auto starts with the saved facing or Back by default.
* Camera choice is two buttons only: Back and Front. No dropdown, no Take photo, no Retake, no gallery buttons on screen. The old Take photo, Retake, gallery and Demo mode checkbox controls are hidden and not visible. Choice persists in localStorage and handles devicechange. Back uses facingMode environment, Front uses user. Switching stops the old stream.
* One question box with no placeholder. It has aria-label Question. One Ask button captures the current frame, sends photo plus question to POST /api/analyze, freezes the frame, draws the highlight and shows the answer.
* Suggested questions are chips under the input. Tapping a chip fills the box but does not send.
* Editing the question or tapping the image returns to live preview. The frozen frame is cleared and the camera resumes.
* Choose a photo link appears only when the camera cannot start. It opens the file picker as a fallback.
* Retry button appears only after an error and resends the last request.
* Loading state shows a spinner with "Looking at the photo..." while the request is in flight.
* Tap to zoom: tap the preview or overlay to open a full screen zoom modal.
* Test hook: adding ?demo=1 to the URL enables the demo overlay. There is no Demo mode checkbox and no camera dropdown on screen.

Privacy note in footer: images stay on device except for inference.

## Verified live

Verified live on 2026-11-01 by the build agent on the public site at 390x844 and 320x568. Fake camera showed the Pi 5 board, question typed, Ask clicked. Image 74 KB sent, answer and highlight returned in 11.4 s and 11.9 s. No console errors, no horizontal scroll. Checked with operator/check-live-ask.py. Not tested: a physical phone camera.

## Speed

Measured on 2026-11-01 through the real tunnel:

* 9 to 17 s per request with Spark Open on Baseten
* Was 27 to 44 s with Glimmer on our own card
* SAM alone is 141 ms for four parts. Check with `server/sam_bench.py` via `operator/sam-bench.sh`
* First request after a restart can take about 50 s (model and SAM warm up)

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

## Next: live mode

Planned, not built. Voice question using Meta speech-to-text, auto capture when the question starts, scan-ahead cache of all parts, spoken answer. This will make the guide hands free. No code for this exists yet.

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

This README is intentionally short and factual.
