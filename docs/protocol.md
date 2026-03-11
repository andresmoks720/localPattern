# Protocol Notes (MVP)

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
- protocol version byte
- `transferId` (8 bytes)
- UTF-8 file name length (uint16)
- UTF-8 file name bytes
- file size (uint32)
- total packets (uint16)
- full-file CRC32 (uint32)

### DATA
Fields:
- magic bytes (`QDB2`)
- frame type (`DATA`)
- protocol version byte
- `transferId` (8 bytes)
- packet index (uint16)
- payload bytes
- packet CRC32 (uint32)

### END
Fields:
- magic bytes (`QDB2`)
- frame type (`END`)
- protocol version byte
- `transferId` (8 bytes)

## Sender state transitions
- `NO_FILE` -> `READY` when valid file is loaded and packetized.
- `READY` -> `COUNTDOWN` when Start is pressed.
- `COUNTDOWN` -> `TRANSMITTING` when countdown reaches zero.
- `TRANSMITTING` -> `COMPLETE` after final END frame render.
- `TRANSMITTING` -> `ERROR` if QR render/encode fails.
- `READY` -> `ERROR` if packetization/settings validation fails.
- `ERROR` -> `NO_FILE` on reset.

## Error code model
Structured protocol errors use machine-readable `code` values. Current codes:
- `FRAME_TOO_SMALL`
- `VERSION_MISMATCH`
- `INVALID_MAGIC`
- `UNSUPPORTED_VERSION`
- `UNSUPPORTED_FRAME_TYPE`
- `MALFORMED_HEADER`
- `MALFORMED_DATA`
- `MALFORMED_END`
- `PACKET_CRC_MISMATCH`
- `INVALID_TRANSFER_ID`
- `INVALID_UINT16`
- `INVALID_UINT32`
- `INVALID_MAX_PAYLOAD_SIZE`
- `INVALID_FILE_NAME`
- `PACKET_BOUNDS`

UI code should branch on `code` and map to user-facing copy.
