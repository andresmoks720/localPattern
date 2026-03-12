# Protocol Notes (MVPv2 one-way mode)

## Product-mode guardrail
MVPv2 is strictly **one-way sender -> receiver** with a passive receiver and no ACK/NACK backchannel.

## Supported frame types
The protocol only supports these frame types:
- `HEADER`
- `DATA`
- `END`

Any other frame type is rejected with a structured `UNSUPPORTED_FRAME_TYPE` protocol error.

## Frame format overview

### HEADER
Fields:
- magic bytes (`QDB2`)
- frame type (`HEADER`)
- `transferId` (8 bytes)
- UTF-8 file name length (uint16)
- UTF-8 file name bytes
- file size (uint32)
- total packets (uint16)
- full-file CRC32 (uint32)
- header CRC32 (uint32)

### DATA
Fields:
- magic bytes (`QDB2`)
- frame type (`DATA`)
- `transferId` (8 bytes)
- packet index (uint16)
- payload length (uint16)
- payload bytes
- packet CRC32 (uint32)

### END
Fields:
- magic bytes (`QDB2`)
- frame type (`END`)
- `transferId` (8 bytes)

## Sender state transitions
- `NO_FILE` -> `READY` when valid file is loaded, packetized, and preflight-encodable.
- `READY` -> `COUNTDOWN` when Start is pressed.
- `COUNTDOWN` -> `TRANSMITTING` when countdown reaches zero.
- `TRANSMITTING` -> `COMPLETE` after final END frame render.
- `TRANSMITTING` -> `ERROR` if QR render/encode fails or tab visibility interrupts transmission.
- `READY` -> `ERROR` if packetization/settings/preflight validation fails.
- `ERROR` -> `NO_FILE` on reset.

See [`docs/state-transitions.md`](./state-transitions.md) for consolidated sender + receiver transition and lock/ignore rules.

## Integrity/error code map
Structured protocol errors use machine-readable `code` values.

### Integrity-relevant codes
- `HEADER_CRC_MISMATCH`: header bytes failed CRC check.
- `PACKET_CRC_MISMATCH`: DATA packet failed CRC check.
- `MALFORMED_HEADER`: header frame length/layout invalid.
- `MALFORMED_DATA`: DATA frame length/layout invalid.
- `MALFORMED_END`: END frame length/layout invalid.
- `INVALID_TOTAL_PACKETS`: `fileSize`/`totalPackets` invariants violated.
- `INVALID_PAYLOAD_LENGTH`: `payloadLen` is out-of-bounds or mismatched.

### General protocol codes
- `FRAME_TOO_SMALL`
- `VERSION_MISMATCH`
- `INVALID_MAGIC`
- `UNSUPPORTED_FRAME_TYPE`
- `INVALID_TRANSFER_ID`
- `INVALID_UINT16`
- `INVALID_UINT32`
- `INVALID_MAX_PAYLOAD_SIZE`
- `INVALID_FILE_NAME`
- `PACKET_BOUNDS`

UI code should branch on `code` and map to user-facing copy.
