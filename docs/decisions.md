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
- This preserves binary integrity for arbitrary file types and avoids UTF-8 corruption risks.

## Reliability Defaults
- QR render size hardcoded to `400x400`.
- QR error correction level set to `H`.
- Scanner throttled to decode every 3rd animation frame for UI responsiveness.
- UI favors vertical space for QR/video area and places controls in a side panel.
