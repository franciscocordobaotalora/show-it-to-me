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
- T02 camera/input simulations in progress
- No real Muse+SAM end-to-end yet

Model provenance revision cec94fcfd6512f2cfe708138c32533b346ea4f69 and runtime vLLM0.30.0.

## Roadmap

- Friday Oct30 build milestone
- Internal submission target November 3, 2026

## Privacy

No committed images or secrets. Repo stays private. Do not publish.

This README is intentionally minimal and factual.
