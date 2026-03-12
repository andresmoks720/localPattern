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
- QR rendering uses explicit high-contrast black-on-white colors (`#000000` on `#FFFFFF`) for decoder reliability.
- Sender exposes tunable pacing / QR-size / chunking controls in UI; exact numeric defaults are intentionally code-owned to avoid docs drift.
- Receiver decode loop is throttled to one decode attempt every `300ms` to reduce CPU load while preserving responsiveness.
- Sender defaults to **stop at end** rather than looping, so users get a clear end-of-stream and ETA.
- Sender keeps a dedicated **Clear QR** control as a persistent panel action (separate from full Reset) so operators can blank stale frames after stop/error without dropping the loaded file.
- Effective throughput is primarily controlled by frame duration and effective chunk sizing.
- Sender requests a screen wake lock during active transmission (when supported) to reduce screen dimming failures.
- Receiver stats semantics: once issue #1 is fixed, receiver UI should consistently present **total scans** separately from **unique packets**.

### Canonical Defaults Source
- Keep numeric runtime defaults in code only (`sender/src/main.ts` `DEFAULT_SETTINGS` and related runtime guards).
- Keep docs descriptive, not prescriptive: document control semantics and safety invariants, not exact numbers that can change between releases.
