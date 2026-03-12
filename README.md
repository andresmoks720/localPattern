# Offline Binary File Transfer via QR Codes

![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5.x-646CFF?logo=vite&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-Ready-5A0FC8)

Transfer files between devices with **no network link** by streaming binary packets through animated QR codes.

> Demo GIF: _add `docs/demo.gif` here_

## Quick Start
1. Open **Sender** on Device A.
2. Open **Receiver** on Device B.
3. Select file → Start → Scan.
4. Download reconstructed file on the receiver.

## Local Development
```bash
npm install
npm run dev:sender
npm run dev:receiver
```

## Protocol Migration Note (V2)
- Protocol V2 (`QDB2`) is **not backward compatible** with Protocol V1 (`QDB1`).
- V2 receivers reject V1 packets with `Version Mismatch`.
- Upgrade sender and receiver together when moving to v2.0.0-beta.

## Documentation Policy (important)
To prevent docs from blocking new functionality, this repo treats documentation as follows:

- **Runtime behavior source of truth:** implementation in `sender/src/main.ts`, `sender/src/transmissionService.ts`, `receiver/src/main.ts`, and `protocol/src/*`.
- **README purpose:** operator guidance only (what buttons do, how to run, common recovery steps).
- **No hardcoded tuning defaults in README/docs** unless they are generated from code in CI.
- If docs and code disagree, **code wins** and docs should be updated in the same PR.

## Calibration Guide (Sender Settings)
- Start with current UI defaults.
- If scanning fails repeatedly, increase frame duration first.
- Increase QR size and keep higher error correction for low light / longer distance.
- Use chunk auto-sizing unless troubleshooting a specific device pair.

## Receiver Guidance
- Tap **Start Scan** (required by iOS Safari camera policy).
- Use overlay frame to align QR.
- If no packets arrive for 5s, app shows **Signal Lost - Check Alignment**.
- Avoid minimizing tabs during transfer.

## Sender Controls (operational)
- **Stop:** halt countdown/streaming and keep the loaded file ready for resend.
- **Clear QR:** clears the currently displayed QR frame while preserving the loaded file and transfer plan.
- **Reset:** clears QR, loaded file, and sender state back to `No file selected`.

## Troubleshooting
- **Scanning fails repeatedly:** increase Frame Duration (e.g., 2500–3000ms).
- **Hash mismatch:** reduce chunk size and re-run with slower pacing.
- **Camera unavailable:** verify browser permission settings, then refresh.
- **Android says camera in use:** stop scan in app to release camera stream, then retry.

## GitHub Pages deployment
This repository deploys through **GitHub Actions** using the official Pages artifact flow in `.github/workflows/deploy-pages.yml`.

Manual one-time repo setting (cannot be set in code):
- **Settings → Pages → Source: `GitHub Actions`**
- **Do not use** `Deploy from a branch` for this repo.

The workflow builds and uploads `.pages-dist`, which should publish:
- `/localPattern/`
- `/localPattern/sender/`
- `/localPattern/receiver/`

Local verification:
```bash
npm ci
npm run build:pages
```

## PWA / Offline Notes
- Both apps use `vite-plugin-pwa` and generate service workers at build time.
- GitHub Pages is HTTPS, so SW registration is valid.
- After first load, disconnect Wi-Fi and continue transfer.

## Privacy Policy
No data leaves your device through network transfer APIs. Transfers are line-of-sight only. No encryption layer is added in v1.0.

## Limitations
- Recommended max file size: **<= 512 KiB**.
- Hard sender limit: **1 MiB**.
- Long transfers can warm devices.
- No retry handshake yet; restart sender/receiver on severe packet loss.

## Release Notes
- See git history and PR titles for release-level behavior changes.

## Tech Stack
- TypeScript (strict)
- Vite + npm workspaces
- `qrcode` (sender), `jsqr` (receiver)
- CRC32 integrity checks

## Verification Commands
```bash
npm run typecheck
npm run build:all
npm run build:pages
```

## Release Verification Record
- Detailed cross-browser, file-type, stress, and offline verification matrix: [`docs/release-verification.md`](docs/release-verification.md)

## Pre-Release Checklist
- [ ] Re-run the release verification matrix in `docs/release-verification.md` before tagging a release.
