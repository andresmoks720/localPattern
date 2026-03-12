# MVPv2 State & Transition Reference

This document tracks runtime state transitions outside of UI files so behavior can be validated without reading DOM orchestration code.

Runtime service modules:
- `sender/src/transmissionService.ts` (sender countdown/scheduling/state machine + events/diagnostics; consumes an on-demand sender frame source (no full-frame image cache))
- `receiver/src/ingestService.ts` (bounded-time scanner duplicate suppression + serialized ingest queue + parse/apply + events/diagnostics)

## Sender (one-way, single-attempt stream)

States: `NO_FILE` -> `READY` -> `COUNTDOWN` -> `TRANSMITTING` -> `COMPLETE` with failure branch to `ERROR`.

- `NO_FILE` -> `READY`
  - Valid file selected (<= 1 MiB), file bytes loaded, packetization succeeds, and preflight QR encoding succeeds for control frames plus representative DATA payload checks.
- `READY` -> `COUNTDOWN`
  - User presses Start.
- `COUNTDOWN` -> `TRANSMITTING`
  - Countdown reaches zero.
- `TRANSMITTING` -> `COMPLETE`
  - Final frame is rendered (`END` for empty/non-empty files).
- `TRANSMITTING` -> `ERROR`
  - QR encoding/render failure, hidden tab interruption, or other runtime exception.
- `READY` -> `ERROR`
  - Packetization/preflight/settings validation failure while preparing a transfer.
- `ERROR|COMPLETE` -> `NO_FILE`
  - User resets and starts a new attempt.

## Receiver machine (`protocol/src/receiverMachine.ts`)

States: `IDLE`, `SCANNING`, `RECEIVING`, `VERIFYING`, `SUCCESS`, `ERROR`.

- `IDLE` -> `SCANNING`
  - `startScanning()`.
- `SCANNING` -> `RECEIVING`
  - First valid `HEADER` accepted and transfer lock acquired.
- `RECEIVING` -> `VERIFYING`
  - Non-empty transfer: all packets `0..totalPackets-1` collected.
  - Empty transfer: matching `END` observed after valid `HEADER(totalPackets=0)`.
- `VERIFYING` -> `SUCCESS`
  - Reassembled bytes satisfy full-file CRC and expected file size.
- `SCANNING|RECEIVING|VERIFYING` -> `ERROR`
  - Timeout (`NO_PROGRESS_TIMEOUT`, `END_INCOMPLETE`) or integrity conflict (`FILE_CRC_MISMATCH`, `FILE_SIZE_MISMATCH`, `HEADER_CONFLICT`, `MISSING_PACKET`).

### Receiver lock and ignore rules

- Lock to first valid `HEADER.transferId`.
- Ignore frames with foreign `transferId` after lock.
- Ignore duplicate DATA packet indexes.
- Ignore `END` before lock.
- In terminal `SUCCESS` or `ERROR`, ignore subsequent ingestion until reset.

## Transport note: byte-authoritative end-to-end

Protocol framing remains byte-authoritative (`Uint8Array` across protocol boundaries).
Sender renders `assembleFrame(...)` bytes in QR byte mode, and receiver ingests scanner `binaryData` bytes directly before protocol parsing.


## Transition maps

- Sender transition guard table is defined in `sender/src/transmissionService.ts` as `SENDER_STAGE_TRANSITIONS`.
- Receiver transition guard table is defined in `protocol/src/receiverMachine.ts` as `RECEIVER_STATE_TRANSITIONS`.
