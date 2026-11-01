# Show It To Me

Private development repo for Meta Global AI Developer Hackathon — Indie Developer Track accepted. **PRIVATE until Francisco explicitly authorizes publication.**

Authored by Muse Glimmer at Francisco's request. Codex is directing and reviewing.

## What it is

A still-frame first visual assistant that reasons over a real photo of hardware and overlays guidance on the original image.

First use case: Raspberry Pi 5 with fan, USB-C power supply, monitor cable, microSD. Exact real accessories need photos.

Flow: phone web app captures a photo; user asks/taps; Muse reasons with official references; SAM masks visible parts; SVG/canvas overlays labels/arrows on original photo. Ask for underside to locate microSD. Never claim to see hidden internals or verify electrical connections from inadequate views.

Tracking stretch planned after still-frame.

## Architecture intent

Muse through Pi is the implementation worker. Codex reviews. SAM is a perception tool, not a code generator.

Intended runtime: BF16 Muse Glimmer 30B via authenticated vLLM server with tool roundtrip.

## Access (31 October 2026)

The [protected test app](https://show-it-to-me.experiment.franciscocordobaotalora.com/)
now uses our earlier voice app's shared login. If signed out, sign in with the existing our earlier voice app
account and 2-step; the login returns to this app. The former Basic Auth credentials
no longer grant access. an earlier voice project's host-only cookie is separate from this shared
experiment-domain session. Deployment configuration and checks are maintained in the
parent workspace's `operator/TEST-DEPLOYMENT.md`.

At the latest check, SAM3 was ready but Glimmer was stopped. A leased GPU-B window
and a verified model response are required before testing image answers.

## Current status (October 27 build, historical test results)

- BF16 Muse Glimmer 30B downloaded
- Small text/vision smoke passed
- Authenticated vLLM server and tool roundtrip tested
- SAM3 environment imports present; SAM auth resolved, weights accessible
- Phone-camera shell implemented with upload/retake/question flow, overlay renderer, frame/request contracts, stale-response protection
- T01 public browser suite passes 8 tests; protected test URL https://show-it-to-me.experiment.franciscocordobaotalora.com/ (our earlier voice app session login since October 31)
- T03H numbered candidate selection live, T03I speed fixes applied, T03J quality gate and docs updated
- Real Muse+SAM end-to-end works, 20-50s per request

## Run

```bash
MUSE_API_BASE=https://... MUSE_API_KEY=... SAM3_CHECKPOINT=/path/to/checkpoint SIT_PORT=8895 python -m server.server
```

Env vars:
- MUSE_API_BASE – vLLM base URL
- MUSE_API_KEY – Bearer token
- SAM3_CHECKPOINT – path to SAM3 weights
- SIT_PORT – HTTP port

Request: POST /api/analyze with frameId, requestId, question, image data URL.
Response fields: frameId, requestId, view, needs_view, regions, explanation, provenance with timings_ms and steps, selection and selection_debug per region.

Pipeline: decode → pass1 → candidates → marks/sam → answer → overlay.

Tests:
```bash
python3 -m unittest discover -s server -p 'test_*.py'
node --check static/app.js
```

Known limits:
- Stand-in Commons photos used, real phone untested
- Glimmer always reasons, ~20-50s per request
- Private repo, do not publish


Model provenance revision cec94fcfd6512f2cfe708138c32533b346ea4f69 and runtime vLLM0.30.0.

## Logs

Structured event log written by server/eventlog.py to file named by SIT_EVENT_LOG (default /data/project/logs/events.jsonl). Each line is JSON with ts ISO UTC with ms, event, requestId, frameId, level and fields. Rotation at 20 MB keeping 5 files. Never logs image data/base64/API keys/cookies; image byte size and sha256 prefix logged.

Events: server_start, sam_preload, http_request, http_rejection, glimmer_pass1, sam_candidates, selection, quality_gate, glimmer_pick, final, client_event.

Read live: `tail -f events.jsonl | python3 -m json.tool`
Find a request: `grep '"requestId":"<id>"' events.jsonl | python3 -m json.tool`
API: GET /api/events?n=100 (loopback only) returns last n events.

## Roadmap

- Friday Oct30 build milestone
- Internal submission target November 3, 2026

## Privacy

No committed images or secrets. Repo stays private. Do not publish.

This README is intentionally minimal and factual.
