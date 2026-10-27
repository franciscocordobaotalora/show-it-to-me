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

## Current status

- BF16 Muse Glimmer 30B downloaded
- Small text/vision smoke passed
- Authenticated vLLM server and tool roundtrip tested
- SAM3 environment imports present; SAM auth resolved, weights accessible
- Phone-camera shell implemented with upload/retake/question flow, overlay renderer, frame/request contracts, stale-response protection
- T01 public browser suite passes 8 tests; protected test URL https://show-it-to-me.experiment.franciscocordobaotalora.com/ (HTTP Basic auth)
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

## Roadmap

- Friday Oct30 build milestone
- Internal submission target November 3, 2026

## Privacy

No committed images or secrets. Repo stays private. Do not publish.

This README is intentionally minimal and factual.
