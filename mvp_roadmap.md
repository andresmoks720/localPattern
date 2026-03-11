# MVPv2 Roadmap (Implementation Sequence)

## Phase 0 — Lock the target and freeze scope
- Confirm MVPv2 one-way-only mode as the only active product mode.
- Remove or feature-flag redundancy/recovery-style knobs out of MVPv2 runtime.
- Add a small “out-of-scope” guard doc and test notes.

## Phase 1 — Protocol byte-contract correctness (blocker)
1. Rework frame wire layouts to exact spec (no version byte, DATA payloadLen field).
2. Rework packet CRC coverage to `transferId + packetIndex + payload`.
3. Implement strict parser validations (lengths, bounds, invariants, malformed frame handling).
4. Implement zero-byte contract (`totalPackets=0`, HEADER->END only, no DATA).
5. Add exhaustive protocol fixture tests (good/bad frames + byte offsets).

## Phase 2 — Receiver deterministic behavior
1. Require END for success (including zero-byte flow).
2. Add same-transfer conflicting HEADER terminal error handling.
3. Make repeated matching HEADER/END explicit no-op paths.
4. Split scanner ingress dedupe from protocol dedupe with deterministic ingest queue.
5. Add receiver tests for all terminal/ignorable cases and post-error ingestion lockout.

## Phase 3 — Sender deterministic behavior
1. Add explicit preflight validation before READY (including QR encodability of all required frame types).
2. Enforce control-frame hold durations (HEADER 2000ms, END 3000ms independent of frame duration).
3. Keep strict one-pass ordering without implicit recovery behavior.
4. Normalize interruption/error copy and bucketed machine-readable error mapping.
5. Add sender tests for preflight, hold durations, reset/cleanup, manual retry new transferId.

## Phase 4 — Architecture boundary and observability
1. Extract sender transmission service from `sender/main.ts` UI orchestration.
2. Extract receiver ingest service from `receiver/main.ts` UI orchestration.
3. Add minimal diagnostics counters/hooks (unique/duplicate/foreign/malformed/badCRC/finalizeDuration).
4. Document state transitions + error code mapping in docs.

## Phase 5 — Verification and release gate
1. Add CI hygiene checks (`test.only`, unhandled promise rejections).
2. Run full automated tests across protocol/sender/receiver.
3. Execute required manual real-device matrix and store results.
4. Sign off against all acceptance criteria in `mvp.md`.
