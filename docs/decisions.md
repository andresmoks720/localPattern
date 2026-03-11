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
- QR render canvas uses a large fixed internal resolution (`1024x1024`) while CSS scales it to consume most of the viewport.
- QR error correction level set to `H`.
- `FRAME_DURATION_MS = 2000` by default: this trades speed for better decode reliability and gives slower cameras enough dwell time per frame.
- Receiver decode loop is throttled to one decode attempt every `300ms` to reduce CPU load while preserving responsiveness.
- Sender defaults to **stop at end** rather than looping, so users get a clear end-of-stream and ETA.

- Passive redundancy defaults to 3x per packet (`REDUNDANCY_COUNT=3`) to improve scan reliability without introducing ACK/NACK complexity.
- Sender requests a screen wake lock during active transmission (when supported) to reduce screen dimming failures.
