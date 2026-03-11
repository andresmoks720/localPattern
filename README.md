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

## Calibration Guide (Sender Settings)
Defaults are tuned for reliability: **2000ms frame duration**, **H ECC**, **400px QR**, **3x redundancy**, **Auto chunk size**.

- **Frame Duration (500–5000ms):** increase first if scans fail.
- **QR Error Correction (L/M/Q/H):** keep `H` in noisy or dim environments.
- **QR Size (200–600px):** increase for distance/low-quality camera.
- **Chunk Size:** use Auto unless you need manual tuning.
- **Redundancy:** repeats each packet (default 3x) to improve recovery without ACK/NACK.

## Receiver Guidance
- Tap **Start Scan** (required by iOS Safari camera policy).
- Use overlay frame to align QR.
- If no packets arrive for 5s, app shows **Signal Lost - Check Alignment**.
- Avoid minimizing tabs during transfer.

## Troubleshooting
- **Scanning fails repeatedly:** increase Frame Duration (e.g., 2500–3000ms).
- **Hash mismatch:** reduce chunk size or increase redundancy.
- **Camera unavailable:** verify browser permission settings, then refresh.
- **Android says camera in use:** stop scan in app to release camera stream, then retry.

## Deployment
### Option A (simplest): two repositories/sites
Deploy `sender` and `receiver` as separate GitHub Pages projects.

### Option B (single site, recommended)
This repo includes a GitHub Actions workflow that:
1. Builds sender + receiver (`npm run build:pages`)
2. Publishes `.pages-dist` to GitHub Pages
3. Hosts at `/sender/` and `/receiver/`

Workflow file: `.github/workflows/deploy-pages.yml`.

## PWA / Offline Notes
- Both apps use `vite-plugin-pwa` and generate service workers at build time.
- GitHub Pages is HTTPS, so SW registration is valid.
- After first load, disconnect Wi-Fi and continue transfer.

## Privacy Policy
No data leaves your device through network transfer APIs. Transfers are line-of-sight only. No encryption layer is added in v1.0.

## Limitations
- Recommended max file size: **5MB**.
- Hard sender limit: **10MB** for mobile stability.
- Long transfers can warm devices.
- No retry handshake yet; restart sender/receiver on severe packet loss.

## v1.0 Release Notes
- Passive redundancy (default 3x packet repeats) added for higher real-world success.
- Sender wake lock + visibility pause protection.
- Receiver scan stats now show total scans vs unique packet count.
- Theme toggle + optional audio feedback for transfer progress/completion.

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
