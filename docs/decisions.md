# QR Data Bridge - Technical Decisions

## QR Libraries

### Sender: `qrcode`
- Chosen because it is lightweight, stable, and works cleanly with Vite bundling.
- Supports explicit error correction settings and canvas rendering.
- We encode protocol frames as QR byte-mode segments so scanned payloads map directly back to authoritative frame bytes.

### Receiver: `jsqr`
- Chosen because it decodes from raw frame pixel data (`ImageData`) captured from `getUserMedia` video streams.
- It has no network/runtime CDN dependency and bundles locally in the app build.

## Encoding Strategy
- Frame binary is created via `assembleFrame(frame): Uint8Array` from the shared protocol package (authoritative wire contract).
- Sender renders `assembleFrame(frame)` bytes directly as a QR byte-mode segment.
- Receiver reads `jsQR` `binaryData` bytes and runs `parseFrame(...)` directly for protocol validation.
- This keeps transport and protocol byte-oriented end-to-end for arbitrary binary file types without a text wrapper.

## Reliability Defaults
- QR size is settings-driven via the sender slider (`200-600px`), with a default of `400px`; rendering forces high-contrast black-on-white colors (`#000000` on `#FFFFFF`) for decoder reliability.
- QR error correction level defaults to `H`.
- Frame duration defaults to `2000ms`: this trades speed for better decode reliability and gives slower cameras enough dwell time per frame.
- Receiver decode loop is throttled to one decode attempt every `300ms` to reduce CPU load while preserving responsiveness.
- Sender defaults to **stop at end** rather than looping, so users get a clear end-of-stream and ETA.
- Effective throughput is primarily controlled by three settings together: `frameDurationMs`, effective chunk size (auto-estimated from QR size/error correction or manual chunk size), and `redundancyCount`.
- Passive redundancy defaults to 3x per packet (`redundancyCount=3`) to improve scan reliability without introducing ACK/NACK complexity.
- Sender requests a screen wake lock during active transmission (when supported) to reduce screen dimming failures.
- Receiver stats semantics: once issue #1 is fixed, receiver UI should consistently present **total scans** separately from **unique packets**.

### Canonical Defaults Source
- Keep sender defaults documented from one canonical source: `sender/src/main.ts` `DEFAULT_SETTINGS`. Reference this object for README/agents/docs updates to avoid drift across files.
