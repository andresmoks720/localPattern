# MVPv2 TODO — Full Implementation Gap List (Deep Pass)

This file is a **comprehensive implementation checklist** against `mvp.md`.
It is intentionally exhaustive so we do not miss hidden gaps.

Legend:
- `[x]` done / aligned
- `[~]` partial / fragile / not fully enforced
- `[ ]` missing

---

## A. Product Mode & Scope Guardrails

- [x] Receiver remains passive-only (no ACK/NACK sender control path).
- [x] Transfer is one-way (`sender -> receiver`) in current runtime flow.
- [x] No WebSocket/BLE/audio return channel implementation.
- [x] No automatic resend-until-success loop.
- [x] No multi-file queue/resume flow.
- [~] Remove or gate MVPv2-incompatible reliability knobs (currently includes DATA redundancy multiplier).
- [ ] Add explicit “MVPv2 one-way mode” guard in code/docs so future two-way code cannot leak into this flow.
- [ ] Add static checks/tests ensuring no hidden dormant backchannel message types appear in protocol package.

---

## B. Hard Product Limits

### B1. File size enforcement
- [x] Sender rejects file > 1 MiB before transmit.
- [x] Rejection is user-visible.
- [~] File warning copy for >512 KiB should match spec wording exactly.
- [ ] Add test asserting exact warning copy bucket for >512 KiB.

### B2. One active transfer per receiver
- [x] Receiver locks to first valid `HEADER.transferId`.
- [x] Receiver ignores non-matching `DATA` after lock.
- [x] Receiver ignores non-matching `END` after lock.
- [x] Receiver ignores non-matching `HEADER` after lock.
- [ ] Add explicit tests for non-matching `HEADER` ignore behavior until success/error/reset.

### B3. No late-join guarantee / no automatic recovery
- [x] UI already tells users to restart sender on incomplete transfer.
- [x] No retransmit request protocol present.
- [ ] Remove redundancy scans in MVPv2 mode to avoid implicit recovery behavior.

---

## C. Protocol Architecture Boundary

- [x] Core frame assembly/parsing lives in `protocol` package.
- [x] Receiver state machine is in protocol module, not in DOM.
- [~] Sender transmission state logic is still UI-heavy in `sender/main.ts`.
- [~] Receiver scan ingestion + UI state rendering is still tightly coupled in `receiver/main.ts`.
- [ ] Extract sender transmission service module (preflight, stream scheduling, state transitions).
- [ ] Extract receiver ingest service module (scanner ingress queue, dedupe strategy, machine events).
- [ ] Add protocol transition/state docs outside view code.

---

## D. Protocol Binary Contract (authoritative gaps)

### D1. Wire identity and type codes
- [x] Magic bytes `QDB2` enforced.
- [x] Legacy `QDB1` rejected.
- [x] Frame type bytes map to HEADER/DATA/END constants.
- [x] Big-endian unsigned reads/writes used via DataView.

### D2. **Critical wire-layout mismatches to fix**
- [ ] Remove extra protocol version byte from all frames.
  - Current implementation encodes `magic|type|version|...`.
  - Spec requires `magic|type|...` only.
- [ ] Implement DATA `payloadLen(2)` field in wire format.
- [ ] Parse DATA using explicit payloadLen and strict trailing-length validation.
- [ ] Recompute frame offsets after version-byte removal.
- [ ] Add strict parser rejection for malformed/trailing-bytes where layout is fixed.

### D3. Required fields
- [x] `transferId` required and length-checked (8 bytes).
- [~] DATA required fields partially implied by current parser; must be explicit with `payloadLen`.
- [x] HEADER includes fileName/fileSize/totalPackets/fileCrc32.
- [x] END includes transferId.

### D4. File name encoding constraints
- [x] UTF-8 encoding in header assembly.
- [x] uint16 filename length bounds enforced.
- [x] No silent truncation.
- [x] Sender surfaces filename limit errors.
- [ ] Add tests for boundary filename byte lengths (`65535`, `65536`, multibyte UTF-8 edge cases).

### D5. Packet/size bounds
- [x] `totalPackets` uint16 bound checked.
- [x] `packetIndex` uint16 encoded.
- [x] `fileSize` uint32 encoded.
- [~] Protocol-level max payload (`<=1024`) not enforced centrally.
- [~] Protocol-level min DATA payload (`>=1`) not enforced via wire contract yet.
- [~] `payloadLen` range cannot be validated until `payloadLen` field exists.
- [ ] Add explicit invariant: `totalPackets=0` only when `fileSize=0`.
- [ ] Add explicit invariant: non-empty file requires `totalPackets>=1`.

---

## E. CRC and Integrity Semantics

### E1. Packet CRC coverage (critical mismatch)
- [ ] Change packet CRC coverage to exactly: `transferId(8) + packetIndex(2) + payload(n)`.
- [ ] Stop using payload-only CRC coverage in sender assembly.
- [ ] Stop using payload-only CRC verification in parser.
- [ ] Add fixture tests proving excluded bytes (`magic`,`type`,`payloadLen`) do not affect packet CRC.

### E2. Full-file CRC
- [x] Full-file CRC computed over reassembled bytes only.
- [x] Receiver verifies full-file CRC before success.
- [ ] Add tests confirming metadata changes do not influence full-file CRC validation.

### E3. Integrity behavior
- [x] Bad DATA packet CRC is ignorable (frame dropped, attempt continues).
- [x] Full-file CRC mismatch is terminal error.
- [ ] Add explicit error code mapping table for all integrity failures.

---

## F. Transfer Identity Rules

- [x] transferId required on all frame types in types/api.
- [x] Receiver lock to one active transfer implemented.
- [ ] Add explicit terminal error on same-transferId conflicting HEADER metadata.
- [ ] Add explicit tests for same-transferId metadata conflict cases (fileName, fileSize, totalPackets, fileCrc32).
- [ ] Ensure repeated matching HEADER with same metadata is explicit no-op path.
- [ ] Ensure repeated matching END is explicit no-op path.

---

## G. Zero-byte File Contract (critical mismatch)

- [ ] `chunkFile` should emit `totalPackets=0` for empty file (currently forces at least one packet).
- [ ] Sender should emit only `HEADER -> END` for empty file.
- [ ] Sender must not emit DATA for empty files.
- [ ] Receiver must not complete on HEADER alone when `totalPackets=0`.
- [ ] Receiver should require END + zero-byte verification for success.
- [ ] Add dedicated zero-byte protocol fixtures and regression tests.

---

## H. Sender Behavior vs Spec

### H1. Core workflow
- [x] File select -> size validation -> read bytes -> packetize -> start send exists.
- [~] Precompute is present, but QR encoding is done per frame at runtime.
- [ ] Add explicit preflight validation that **all required frame types** encode successfully before READY.
- [ ] Fail before transmission when chosen settings cannot encode frames.

### H2. Transmission mode
- [x] One pass through current stream.
- [~] DATA redundancy repeats frames (`redundancyCount`), deviates from strict `HEADER->DATA in order->END` once each.
- [x] No backchannel waiting.
- [x] No continuous auto-loop.

### H3. Control-frame visibility rules (missing)
- [ ] Guarantee HEADER visible >=2000ms before first DATA.
- [ ] Guarantee END visible >=3000ms before non-QR completion screen.
- [ ] Implement hold durations independent of general frameDuration setting.
- [ ] Add tests with fake timers for HEADER/END hold semantics.

### H4. Final screen sequencing
- [~] END is shown as part of sequence, but explicit timed hold before completion is not guaranteed.
- [ ] Enforce exact order: transmit END -> hold END -> then final non-QR screen.

### H5. Interruption behavior
- [x] Hidden tab interrupts active transmission.
- [~] Copy mismatch (`Error: tab hidden...`) vs spec recommended copy.
- [ ] Normalize interruption copy: `Transmission interrupted. Restart required.`

### H6. Sender errors
- [x] User-visible handling for file read failure.
- [x] Packetization failure surfaced.
- [x] Too-many-packets surfaced.
- [x] Filename limit issues surfaced.
- [x] QR encode failure surfaced.
- [~] Explicit “frame precompute failure” bucket not distinguished.
- [~] Explicit “invalid preflight settings” bucket not distinguished.
- [ ] Add complete error-code -> user-copy map and assert in tests.

### H7. Abort/reset lifecycle
- [x] Clears timers/timeouts.
- [x] Clears transfer arrays/state on reset.
- [x] Releases wake lock.
- [ ] Add tests proving no stale frame cache leaks across attempts.
- [ ] If pre-rendered assets are introduced, ensure explicit cleanup.

### H8. Manual retry semantics
- [x] Retry rebuilds frames and generates fresh transferId.
- [ ] Add deterministic test asserting transferId changes across retries of same file.

---

## I. Receiver Behavior vs Spec

### I1. Workflow states
- [x] Has `IDLE/SCANNING/RECEIVING/VERIFYING/SUCCESS/ERROR` states.
- [x] Error is terminal until reset.

### I2. Packet handling
- [x] DATA before HEADER ignored.
- [x] Wrong transfer frames ignored after lock.
- [x] Duplicate DATA accepted once and deduped.
- [x] Out-of-range packetIndex ignored.
- [x] CRC-invalid DATA ignored without terminal failure.

### I3. Completion rule (major gap)
- [ ] Require END as part of success condition.
- [x] Full packet set + file reassembly + CRC + file size currently required.
- [ ] For zero-byte case, wait for END before success.

### I4. Failure rules
- [x] END-incomplete grace timeout implemented (2000ms).
- [x] No-unique-progress timeout implemented (15000ms).
- [x] Duplicate packets do not reset unique-progress timer.
- [~] Timeout copy should match spec exactly for incomplete transfer bucket.

### I5. Scanner dedupe vs protocol dedupe
- [~] Scanner ingress dedupe currently implemented with `lastDecodedPayload` equality only.
- [ ] Make scanner dedupe bounded-time/noise-oriented (not unbounded “last payload forever”).
- [ ] Keep protocol dedupe independent and explicitly tested.
- [ ] Add tests showing protocol correctness unaffected when scanner dedupe is disabled.

### I6. Queue/ingest discipline
- [~] Ingestion is single callback path today, but lacks explicit queue abstraction.
- [ ] Introduce serialized ingest queue/channel to avoid concurrent state mutation risks.
- [ ] Add tests for deterministic ordering under burst scanner callbacks.

### I7. Camera/scanner UX
- [x] Prefers rear camera.
- [ ] Add explicit camera selection fallback UI if preferred camera fails.
- [x] Stable scan overlay exists.
- [ ] Add readiness checks based on media readiness events with robust fallback handling.

### I8. After failure
- [x] ERROR stops protocol ingestion for attempt.
- [x] User reset/restart path exists.
- [ ] Add tests for “terminal ERROR blocks further frames” across all error classes.

---

## J. State Machine Discipline

### J1. Sender
- [x] Required sender states exist in type.
- [~] Transitions are not centralized in a single reducer/table.
- [ ] Create explicit transition map + guard checks.
- [ ] Add transition tests (valid transitions and forbidden transitions).

### J2. Receiver
- [x] Required receiver states exist in machine.
- [~] Transition invariants are implicit in methods.
- [ ] Add explicit transition table docs/tests.
- [ ] Add reset transition tests proving cleanup and fresh-attempt behavior.

---

## K. UI/UX Required Copy and Guidance

### K1. Sender required copy buckets
- [x] No file selected.
- [x] File too large.
- [x] Ready to transmit.
- [x] Starting in…
- [x] Sending packet X/N.
- [x] Transmission finished.
- [~] Actionable error copy present but not fully normalized to spec buckets.

### K2. Receiver required copy buckets
- [x] Ready to scan.
- [x] Waiting for header.
- [x] Receiving packets.
- [x] Verifying.
- [x] File ready.
- [x] Transfer incomplete, restart sender.
- [x] Decode/camera/corruption error buckets present.
- [ ] Normalize all timeout/incomplete copy exactly per spec recommendation where practical.

### K3. Operator guidance
- [~] Some practical hints exist.
- [ ] Ensure all key hints appear in concise form: steady devices, QR fully visible, move closer, fullscreen mode, larger files slower.

### K4. Stable visual geometry
- [~] QR and scan overlays are generally stable/square.
- [ ] Audit CSS/layout to guarantee no transfer-time layout shifts.
- [ ] Add smoke test or visual regression check for stable QR area during transmission.

---

## L. Reliability Definition Alignment

- [x] Correct packets accepted.
- [x] Corrupted packets rejected.
- [x] Wrong-transfer packets ignored.
- [x] Completed files verified.
- [x] Incomplete transfers timeout clearly.
- [x] Manual retry possible.
- [ ] Remove/limit any behavior implying guaranteed recovery (redundancy setting in MVPv2 one-way mode).

---

## M. Resource Lifecycle Rules

### M1. Sender cleanup
- [x] Clears timers/timeouts and active transfer state.
- [x] Clears progress/UI state on reset.
- [x] Releases wake lock resource.
- [ ] If frame caching is added, explicitly clear cache on reset/new attempt/teardown.

### M2. Receiver cleanup
- [x] Stops camera tracks.
- [x] Clears raf/interval timers.
- [x] Clears packet store and transferId via machine reset.
- [x] Clears download Blob URL.
- [ ] Add explicit cleanup for attempt diagnostics/counters if introduced.

---

## N. Dependency, Packaging, and Transport Rules

- [x] No remote CDN dependency in runtime path.
- [x] Browser-only static app packaging via Vite.
- [x] Byte-oriented payload path in protocol.
- [~] Sender still wraps binary frame bytes in base64 text for QR payload transport.
- [ ] Reconcile anti-pattern clause (“Base64/Data-URL-as-core-payload architecture”) with implementation approach; either adjust implementation or clarify bounded QR text transport policy in spec/docs.

---

## O. Observability (minimal)

- [x] Receiver exposes total scans + unique packet count UI.
- [~] Missing explicit counters for foreign frames, malformed/noise frames, bad-packet-CRC ignores, finalize duration.
- [ ] Add minimal diagnostic counters in core services (not complex dashboard).
- [ ] Expose event hooks from sender/receiver core: frame rendered, frame accepted, complete, failed.

---

## P. Required Testing Before Sign-off (full matrix)

### P1. Protocol unit tests
- [x] HEADER/DATA/END roundtrip tests exist.
- [ ] Exact byte-layout conformance tests (all offsets/lengths).
- [ ] Wrong-magic/version compatibility tests aligned with final wire contract.
- [ ] transferId required/validated tests across all frame types.
- [ ] DATA payloadLen bounds + exact length matching tests.
- [ ] totalPackets/fileSize invariants tests.
- [ ] packet CRC coverage tests (transferId+index+payload only).
- [ ] full-file CRC coverage tests (file bytes only).
- [ ] repeated matching HEADER/END behavior tests.
- [ ] conflicting same-transfer HEADER metadata terminal error tests.
- [ ] END-before-HEADER ignored tests.
- [ ] zero-byte wire contract tests.

### P2. Sender tests
- [x] >1 MiB rejected.
- [x] file-read failure surfaced.
- [x] packetization failure surfaced.
- [x] QR encode failure surfaced.
- [ ] frame precompute failure surfaced.
- [ ] filename encoding limit boundary tests.
- [ ] preflight settings validation tests.
- [ ] estimated transfer duration presence test.
- [ ] HEADER/END hold duration tests.
- [ ] hidden/interrupted transmission restart-required tests.
- [ ] reset cleanup and no stale state tests.
- [ ] manual retry new transferId test.

### P3. Receiver tests
- [x] DATA-before-HEADER ignored.
- [x] lock-to-one-transfer behavior.
- [x] duplicate DATA handling.
- [x] out-of-range index ignored.
- [x] bad DATA CRC ignored.
- [x] END-incomplete timeout path.
- [x] no-progress timeout path.
- [x] full-set + CRC success path.
- [ ] success requires END test.
- [ ] zero-byte waits for END test.
- [ ] conflicting-header terminal error test.
- [ ] repeated matching control-frame no-op tests.
- [ ] terminal ERROR blocks further ingestion tests (broad coverage).
- [ ] scanner-ingress dedupe vs protocol dedupe separation tests.

### P4. Empty-file dedicated coverage
- [ ] Sender emits deterministic HEADER->END only.
- [ ] Receiver deterministic zero-byte verify success/failure reasons.
- [ ] No hang waiting for missing DATA.

### P5. Manual real-device matrix (recording required)
- [ ] phone->phone
- [ ] laptop->phone
- [ ] bright/low light
- [ ] portrait/landscape
- [ ] fullscreen on/off
- [ ] near max recommended size
- [ ] zero-byte file
- [ ] restart after incomplete failure
- [ ] wrong-transfer background frames

### P6. CI hygiene
- [ ] Fail CI on `test.only`.
- [ ] Fail CI on unhandled promise rejections.

---

## Q. Known correctness bugs observed in current code audit

- [ ] Remove duplicate `receiverMachine.startScanning()` invocation in receiver reset helper.
- [ ] Replace parser assumptions that conflict with spec wire layout.
- [ ] Tighten malformed-frame handling to distinguish ignorable noise vs protocol faults consistently.

---

## R. Acceptance Criteria Tracker (must all be true)

- [x] Sender rejects files above 1 MiB.
- [x] Receiver passive-only.
- [~] transferId in all frames implemented, but wire layout differs from spec due to extra version byte.
- [ ] Exact frame byte layout implemented.
- [ ] CRC coverage implemented exactly as specified.
- [x] Receiver ignores wrong-transfer frames once locked.
- [x] Bad packet CRC treated as ignorable frame loss.
- [x] full-file CRC verified.
- [x] fixed timeout windows implemented.
- [~] sender exception buckets mostly covered; precompute/preflight bucket incomplete.
- [ ] preflight settings validation before transmission is complete.
- [~] receiver success currently does not require END.
- [ ] zero-byte path deterministic per spec.
- [x] manual retry fresh attempt behavior mostly present.
- [~] QR visual stability mostly present; needs explicit guarantees/tests.
- [x] sender interruption hidden-page behavior stops transfer.
- [~] core transport/state partly testable outside UI; sender/receiver app files still too orchestration-heavy.
- [x] no major out-of-scope features added.

---

## S. Execution Order (high confidence)

1. **Protocol blockers first**: wire layout, payloadLen, CRC coverage, zero-byte invariants.
2. **Receiver correctness**: END-required success, conflicting-header terminal errors, dedupe separation.
3. **Sender correctness**: preflight QR validation, control-frame holds, remove redundancy in MVPv2 mode.
4. **Tests + CI**: add exhaustive protocol/sender/receiver tests and hygiene guards.
5. **Boundary hardening**: split service/state logic from UI and document transitions.

