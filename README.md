# QR Data Bridge Monorepo

Offline-first browser apps for binary transfer over animated QR packets.

## Workspaces
- `protocol`: shared packet format, chunking, CRC32, packet parse/validation
- `sender`: file input and QR stream shell with packet-by-packet rendering
- `receiver`: camera scan shell with QR decode + packet checksum validation

## Local development
```bash
npm install
npm run dev:sender
npm run dev:receiver
```

## Verification
```bash
npm run typecheck
npm run build
```

Manual transfer check:
1. Start sender and receiver.
2. In sender, upload a small binary file and click **Start Transmission**.
3. On receiver, click **Start Scan** and point camera at sender QR.
4. Confirm receiver status switches to **Packet Received!** and console logs checksum validity.

See `docs/decisions.md` for QR library and encoding choices.
