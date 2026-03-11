# QR Data Bridge - Technical Decisions

## QR Libraries

### Sender: `qrcode`
- Chosen because it is lightweight, stable, and works cleanly with Vite bundling.
- Supports explicit error correction settings and canvas rendering.
- We encode packet bytes as Base64 text with a short prefix (`QDB64:`) to avoid byte-mode compatibility issues across scanner implementations.

### Receiver: `jsqr`
- Chosen because it decodes from raw frame pixel data (`ImageData`) captured from `getUserMedia` video streams.
- It has no network/runtime CDN dependency and bundles locally in the app build.

## Encoding Strategy
- Packet binary is created via `assemblePacket(packet): Uint8Array` from the shared protocol package.
- Sender converts packet bytes to Base64 string (`QDB64:<base64>`) before QR generation.
- Receiver validates the prefix, decodes Base64 back to `Uint8Array`, then runs `parsePacket(...)` to verify magic/version/checksum.
- Each packet repeats transfer metadata (`totalPackets`, `fileName`, `fullFileHash`) to support late-join scanning and deterministic completion checks.
- This preserves binary integrity for arbitrary file types and avoids UTF-8 corruption risks.

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
