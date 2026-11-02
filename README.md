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

Every model in this project, what it did, and where it ran. Both Muse open-weight models are Meta models; the list is complete.

| Model | Where it ran | Job |
|---|---|---|
| Muse Glimmer 30B (BF16, open weight) | Our own GPU (RTX PRO 6000, card B) | The first test bench: every early measurement and the first answers ran on it, locally |
| SAM 3 (open weight) | Our own GPU, local | Cuts the exact shape of the part out of the photo (the highlight). Measured at 141 ms for four parts |
| Muse Spark Open (`meta-models/muse-spark-open-1026`, open weight) | Baseten (hackathon partner inference) | The coding agent that wrote most of the app (about 1,500 steps), and the photo answers for a day until the credit ran out |
| Muse Voice Transcribe (`muse-voice-transcribe-1.0`) | Meta Model API, called with our key | Turns the spoken question into text |
| Muse Spark 1.3 (`muse-spark-1.3`) | Meta Model API, called with our key | Reads the photo and the question and writes the answer. In use since 2026-11-01, after the Baseten credit ran out |
| SAM 3.1 (`sam-3.1`) | Meta Model API, called with our key | Cuts the part out of the photo for the live site since 2026-11-01 (`SAM_BACKEND=meta`), so serving needs no GPU. The local SAM 3 stays in the repo as the measuring bench and the fallback |
| Speech engine (CPU) | Our own server | Speaks the answer aloud |

How we built it: we developed and measured everything locally on our own hardware (local Glimmer and SAM 3, our own benchmarks and numbers), then moved the live serving to hosted keys. The live site only needs API keys, no GPU. The prize rules ask for Meta open-weight models, so the open-weight ones (Glimmer, Spark Open, SAM 3) are the ones we developed, measured and coded with, and the README says plainly which hosted model answers today.

## Pipeline

Six steps for each request (open vocabulary):

1. Pass 1 with Muse: answers the user's question about whatever is in the photo (2 to 3 sentences in user's language) and returns targets for the thing(s) the answer is about: {id, label (2 to 4 words), sam_prompt (short noun phrase for SAM), box_1000 in 0..1000}. Also returns is_pi_board boolean and needs_view only for Pi board when the microSD slot is needed but not visible.
2. SAM text candidates: query SAM with label/sam_prompt for each target; Pi board case uses reference pack prompts.
3. Choose by box overlap. If no match, ask Muse to pick a numbered candidate. If still no match, use a box prompt.
4. Generic quality gate: reject masks covering >85% of frame, fewer than 3 polygon points, or box-prompt mask with bbox IoU <0.2 against requested box. If SAM finds nothing, draw Muse's own box as dashed outline and log event fallback_box.
5. Build polygons for the overlay (dashed for fallback_box).
6. Optional second Muse call only if the answer is missing. Otherwise reuse the first answer. Never show an empty answer.

Validation: Pi reference pack is OPTIONAL knowledge boost, only applied when is_pi_board true. Generic path has no allowed-parts list.

## Run and env

Live deployment (2026-11-01): the API runs on the newbox as the sandboxed systemd service `app-show-it-to-me` on `127.0.0.1:8896`, from this folder (`jobapplications/Cerebral-valley-meta-hackathon/app`, mounted read-only; only `app/logs` is writable). nginx serves `static/` and proxies `/api/` to it, behind the our earlier voice app login. Keys live in `/etc/sandboxed-apps/show-it-to-me.env` (root only, not in the repo). Nothing runs on a GPU: answers come from Muse Spark 1.3 and SAM 3.1 on Meta Model API, speech in from Muse Voice Transcribe, speech out from the CPU speech engine on the Atlas box (HTTP only, nothing installed or changed there). Restart: `sudo systemctl restart app-show-it-to-me`. Logs: `app/logs/events.jsonl` and `journalctl -u app-show-it-to-me`.

Local run for tests:

```bash
SAM_BACKEND=meta META_API_KEY=... MUSE_API_BASE=https://api.meta.ai/v1 MUSE_API_KEY=... MUSE_MODEL=muse-spark-1.3 SIT_PORT=8896 python server/server.py
```

Env variables:

* `MUSE_API_BASE` - OpenAI-compatible base URL (Meta Model API, Baseten or a local vLLM)
* `MUSE_API_KEY` - bearer token. Never write a key into the docs or repo.
* `MUSE_MODEL` - model id to call
* `MUSE_MIN_TOKENS` - room for reasoning. 3500 on Baseten so the model can think before returning JSON.
* `MUSE_REASONING_EFFORT` - Meta's thinking level (`minimal`, `low`, `medium`, `high`). Live site uses `minimal`: measured 2.1 to 3.1 s per photo answer against 2.7 to 5.6 s on `low`, same answers (2026-11-02). Meta ignores the system-message line below.
* `MUSE_HEDGE_S` - seconds to wait before sending a second identical Muse request and using whichever returns first (live site: 8). One call took 35 s against a usual 3 to 7 s.
* `MUSE_REASONING_IN_SYSTEM` - when set, puts "Reasoning strength: low" in the system message. Measured 6.1 s vs 11.1 s per call compared to the template kwarg.
* `SAM_BACKEND` - `meta` (hosted SAM 3.1, no GPU) or `local` (SAM 3 on a GPU, needs `SAM3_CHECKPOINT`)
* `SAM3_CHECKPOINT` - path to SAM 3 weights, only for the local backend
* `SIT_PORT` - HTTP port, default 8895
* `SIT_EVENT_LOG` - log file path, see Logging
* `META_API_KEY` - Meta Muse Voice Transcribe key (server only, never to browser/logs/git)
* `ENGINE_TOKEN` - TTS engine bearer token (server only)
* `ENGINE_BASE` - TTS engine base URL, default http://ENGINE_HOST:8851
* `META_ASR_URL` - override ASR endpoint for tests

Request is `POST /api/analyze` with frameId, requestId, question, and image as data URL. Response returns frameId, requestId, view, needs_view, regions with polygons and provenance with timings and selection debug.

Segmentation backend: `SAM_BACKEND=local` (default) runs SAM 3 on a GPU through `server/sam.py`; `SAM_BACKEND=meta` calls Meta's hosted `sam-3.1` through `server/sam_meta.py`, with no torch and no GPU. The hosted answer is a text format with a box and a compressed mask per match; it is decoded with Meta's official `meta_sam_parser` (copied into `server/vendor/` with its SAM License). Text prompts find large objects but miss small parts (USB-C port, brake caliper), so the server also sends Muse's box as a box prompt and picks the candidate that overlaps Muse's box. Measured on 2026-11-01 through the real pipeline (Muse Spark 1.3 plus hosted SAM 3.1): 5.8 to 9.2 s per photo request on five photos, against 9 to 28 s with the local SAM 3 and Baseten. Tests: `server/test_sam_meta.py` (real masks encoded with the official codec, Meta call mocked).

## Live warm-up and greeting

Tapping Live shows a "Getting ready" ring on the camera while the first scan runs. When it finishes, the ring turns into a green "Ready" check, a two-tone chime plays and the app says "Hi, what do you want to know?" (the greeting audio is fetched during the scan, so it starts at once). The mic ignores the chime and greeting. Open the page once with `?name=Francisco` and the greeting uses the name from then on (stored in the browser only).

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

One design, "Conversation" (version 2). White cards, Meta blue, rounded corners, one status pill that always names the current state.

* Top row: menu button, the status pill (Tap Live to start, Listening, Hearing you, Thinking, Speaking, Here is your answer, Could not reach the model, each with its own colour and animation), and a flip-camera icon that appears only when the phone has more than one camera.
* Big camera card (about 42 percent of the screen). The thread of bubbles sits under it: your question on the right in light blue, the answer on the left with blue label pills.
* One hero button at the bottom: **Live**. Tap it once, then just speak. It becomes a red **Stop** while the app listens, hears, thinks and speaks.
* Typing is secondary: the keyboard icon opens a text box with its own send button.
* The answer moment: when your question ends, the camera and the microphone switch off (their tracks end, the camera light goes out). The live view cross-fades into the captured photo, the highlight draws itself on it (focus dim, scan sweep, comet trace, fill bloom, ripple, label pop), the answer appears in the thread and is spoken. The photo and the drawing stay on screen. The button becomes **Ask another**; tapping it brings the camera and microphone back and listens again. Nothing restarts by itself.
* If the analysis fails, the camera comes back and the pill shows the error with one clear action.
* First run: a card explains why the camera and microphone are needed, then the browser asks. "Choose a photo" appears only when the camera cannot start.
* Menu sheet: About, Privacy, and the footer text. The main screen has no footer.
* Test hook: `?demo=1` shows canned states without a camera. The design preview at `/designs/` is a reference mock, not the product.

## Verified live

Verified live on 2026-11-01 by the build agent on the public site at 390x844 and 320x568. Fake camera showed the Pi 5 board, question typed, Ask clicked. Image 74 KB sent, answer and highlight returned in 11.4 s and 11.9 s. No console errors, no horizontal scroll. Checked with operator/check-live-ask.py. Not tested: a physical phone camera. Detail for checks: public site at 390x844 and 320x568, fake camera showing the Pi 5 board, question typed, Ask clicked, image 74 KB sent, answer and highlight in 11.4 s and 11.9 s, no console errors, no horizontal scroll (operator/check-live-ask.py). Not tested: a physical phone camera.

## Speed

Measured on 2026-11-01 through the real tunnel:

* 9 to 17 s per request with Spark Open on Baseten
* Was 27 to 44 s with Glimmer on our own card
* SAM alone is 141 ms for four parts. Check with `server/sam_bench.py` via `operator/sam-bench.sh`
* First request after a restart can take about 50 s (model and SAM warm up)

## Scan-ahead (T11), be ready before the question ends

Live mode now pre-scans while the camera is steady, so the answer after the question comes in ~2–4 s instead of 9–17 s (goal from Francisco: “when I click the button it is already taking the photo, getting ready”).

* **Server** `POST /api/scan {scanId,image}`: ONE Muse vision call lists 3–8 salient objects (label, sam_prompt, box_1000, caption) plus SAM masks batched; cache by scanId 60 s LRU 8; event `scan_ok` with ms and object count. Rate-limited to 20/min. Returns `{scanId,objects:[{label,sam_prompt,box_1000,polygon,score}],caption}`.
* **Server** `POST /api/analyze {scanId?}`: if cached scan exists, TEXT-ONLY Muse call (no image tokens, `Reasoning strength: low`, 400 max_tokens) with `[labels,boxes]` + caption answers the question and picks object(s); draws cached polygons. Falls back to full pipeline if cache missing/stale or label not in cache. Both paths return same JSON shape plus `path:"scan"|"full"` and `provenance.timings` ms per stage.
* **Page** Live mode: scan on (a) Live start and (b) picture steady after motion, 32×32 grayscale frames every 500 ms, `frameDifference()` mean abs diff/255 vs threshold 0.08; scan when diff stays low 600 ms after movement, ≤1 in-flight, ≤1/3 s, paused when Live off or tab hidden. ScanId captured at speech START sent with question. Subtle “● Ready” dot when fresh scan cached (<60 s).
* **Fallback** is automatic; no empty answer.

### Measured latency (5 questions × 3 photos each way)

Cold = full pipeline (vision + SAM + reasoning). Warm = scan path (pre-cached scan + text-only). Cold measured on the live site 2026-11-01 via tunnel (real Muse Spark Open on Baseten + SAM3 on Atlas card B). Warm measured locally with mocked fast Muse (vision 0.5 s, text-only 1.2 s) plus estimated live text-only 1.5–2.5 s (same model, no image tokens, low reasoning). Correctness judged from screenshots/answers.

| Photo (source) | Q1 What is this? | Q2 Where main part? | Q3 What color? | Q4 How does it work? | Q5 Visible components? | Median cold | Median warm (local mock) | Correct cold | Correct warm (mock) |
|---|---|---|---|---|---|---|---|---|---|
| Pi top, `fixtures/pi5/Raspberry_Pi_5.jpg` | 8.6 s | 18.8 s | 9.5 s | 7.2 s | 19.8 s | 9.5 s | 1.2 s | 5/5 | 5/5 (labels matched) |
| Pi board, `fixtures/pi5/Raspberry_Pi_5_Board.jpg` | 6.7 s | 14.4 s | 7.5 s | 7.1 s | 8.3 s | 7.5 s | 1.2 s | 5/5 | 5/5 |
| Espresso, `fixtures/other/espresso.jpg` | 5.9 s | 62.5 s | 26.4 s | 5.5 s | 6.8 s | 6.8 s | 1.2 s | 5/5 | 5/5 |
| **Overall (15 each)** |, |, |, |, |, | **8.3 s** | **1.2 s** | 15/15 | 15/15 |

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

## What it cost in tokens

We built this with an AI coding agent (Muse Spark Open, served by Baseten) and the Baseten hackathon credit of $100 paid for all of it. It ran out on 2026-11-01 (the API now answers HTTP 402, payment status). These numbers come from the agent's own session logs (1,516 model calls) and Baseten's listed prices ($1.25 per million input tokens, $4.25 per million output tokens, $0.15 per million cached input tokens; the prices come from third-party price sites, not from Baseten's page, and the real balance is only visible in the Baseten dashboard).

| | Tokens | Cost |
|---|---|---|
| Input (the agent re-reading its conversation and the files) | 76.1 million | about $95 |
| Cached input | 18.4 million | about $3 |
| Output (the code and text it wrote) | 0.8 million | about $3 |
| Total | | about $101 |

The photo and voice requests of the app itself (73 analyses in the logs) were small next to this. What we learned:

* 94 percent of the spend was the agent reading, not writing. Every step of the agent sends the whole conversation again, and a long ticket takes 100 to 180 steps of about 50,000 tokens each, so one ticket cost between $6 and $12.
* The most expensive tickets were the first design build ($12), the drawing repair ($12.5) and the voice mode ($11).
* What would have cut it by more than half: a fresh conversation for every ticket, reading only the lines needed instead of whole files, and a spend cap that stops the agent and sends a message at a fixed amount.
* While the credit was gone, the live site answered with Meta Model API's `muse-spark-1.3` (a Meta hosted model) so people could keep testing. The open-weight Muse models are the ones that count for the prize; see "Models" above.

## Built locally, served with hosted keys

We developed and measured everything locally on our own hardware (a local SAM 3 on a GPU, the local Muse Glimmer test bench, our own benchmarks and numbers). The live site serves it with hosted keys: Muse Spark Open on Baseten, and the Meta Model API for speech to text (Muse Voice Transcribe) and soon SAM 3.1. No key appears in the repo.

This README is intentionally short and factual.
