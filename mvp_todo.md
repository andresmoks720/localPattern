# MVP Implementation TODO (Gap Analysis vs `mvp.md`)

This checklist compares the current codebase to `mvp.md` and lists the remaining work needed to fully implement the MVP spec.

## 0) Priority order (recommended)
1. **Protocol correctness first** (`transferId` in DATA, lock/isolation rules).
2. **Receiver terminal behavior** (fixed timeouts + END-incomplete failure).
3. **Sender hard limits + explicit state machine + error surfacing**.
4. **Required tests** (protocol/sender/receiver).
5. **UI copy alignment**.

---

## 1) Hard product limits

- [ ] **Enforce sender hard cap at 1 MiB** (currently sender allows up to 10 MiB).
- [ ] **Show warning at > 512 KiB** with MVP wording (“Large files may take a very long time and may fail more often.” or equivalent).
- [ ] Ensure rejection happens **before packetization/transmission starts**.

---

## 2) Protocol conformance (`HEADER` / `DATA` / `END`)

### 2.1 Frame fields
- [x] Add `transferId` to **DATA** frame type, assembly, and parsing.
- [ ] Include/validate **protocol version** explicitly per frame format (current parser mostly relies on magic bytes).
- [x] Keep supported frame types exactly `HEADER`, `DATA`, `END` only.

### 2.2 Transfer identity and lock isolation
- [x] Receiver must lock on first valid HEADER and then ignore all non-matching frames (including HEADER) until `SUCCESS`, `ERROR`, or manual reset.
- [x] Remove any behavior that auto-resets/merges when a different transfer is seen mid-attempt.

### 2.3 Integrity
- [x] Preserve per-packet CRC32 validation for DATA.
- [x] Preserve full-file CRC32 validation after reassembly.
- [x] Ensure CRC failures are explicit user-visible error reasons (not silent).

### 2.4 Packet index validity
- [x] Explicitly ignore/reject DATA frames with index outside `0..totalPackets-1`.
- [x] Keep first valid payload for an index; duplicates must not overwrite.

---

## 3) Sender behavior + state machine

### 3.1 Explicit sender states
- [ ] Implement explicit sender state machine with required states: `NO_FILE`, `READY`, `COUNTDOWN`, `TRANSMITTING`, `COMPLETE`, `ERROR` (optional `FILE_INVALID`).
- [ ] Replace loose booleans/timers with explicit state transitions.

### 3.2 Sender flow and one-pass mode
- [ ] Keep one-pass `HEADER -> DATA (ordered) -> END`.
- [ ] Keep no backchannel waiting, no automatic resend loop, no continuous HEADER/END looping.
- [ ] Keep stable final informational state after END (must not imply receiver success).

### 3.3 Sender error handling (must be surfaced)
- [ ] Catch and surface **file read failures**.
- [ ] Catch and surface **packetization failures**.
- [ ] Catch and surface **too-many-packets / bounds failures**.
- [ ] Catch and surface **filename encoding limit failures**.
- [ ] Catch and surface **QR encode failures**.
- [ ] Catch and surface **finalize/render failures**.
- [ ] Ensure no unhandled promise rejections in sender workflow.

### 3.4 Filename policy (reject-only)
- [ ] If filename cannot be encoded or exceeds protocol limits, fail with clear user-visible error.
- [ ] Do **not** silently truncate or mutate filename as fallback behavior.

---

## 4) Receiver behavior + state machine

### 4.1 Explicit receiver states
- [x] Ensure receiver uses required states exactly: `IDLE`, `SCANNING`, `RECEIVING`, `VERIFYING`, `SUCCESS`, `ERROR`.
- [x] Make `ERROR` terminal for current attempt (no silent continued merging).

### 4.2 Passive-only constraints
- [x] Keep receiver fully passive: no ACK/NACK/requests and no assumptions sender can react.

### 4.3 Ignorable frames vs terminal errors
- [x] While scanning, treat these as ignorable (non-terminal):
  - DATA before valid HEADER
  - duplicate DATA for existing packet index
  - non-matching `transferId` frames
  - malformed/noise frames
- [x] Reserve terminal `ERROR` for:
  - camera failure
  - END seen while incomplete after grace window
  - no unique progress timeout
  - reassembly/verification failures

### 4.4 Completion semantics
- [x] Complete only when all packet indices exist, reassembly succeeds, full-file CRC32 passes, and file size matches expected.
- [x] END frame alone must never be treated as success.

### 4.5 Fixed MVP timeout behavior
- [x] Implement fixed END grace window: **2000 ms**.
- [x] Implement fixed no-unique-progress timeout: **15000 ms**.
- [x] Track `lastUniquePacketAt` and do not let duplicates extend timeout.
- [x] On timeout/incomplete END, transition to terminal ERROR with actionable message.
- [x] Do not depend on sender runtime settings (frame duration/redundancy) unless explicitly in protocol metadata.

### 4.6 Post-failure behavior
- [x] After terminal failure, keep explicit ERROR state until user restart/reset.
- [x] Do not silently continue receiving into failed attempt.

### 4.7 Zero-byte files
- [x] Support zero-byte files with deterministic behavior (explicit success/failure path, no hangs).

---

## 5) UI/UX copy alignment (minimal text changes)

### Sender required messages
- [ ] No file selected
- [ ] File too large
- [ ] Ready to transmit
- [ ] Starting in…
- [ ] Sending packet X / N
- [ ] Transmission finished
- [ ] Error with actionable reason

### Receiver required messages
- [ ] Ready to scan
- [ ] Waiting for header
- [ ] Receiving packets
- [ ] Verifying
- [ ] File ready
- [ ] Transfer incomplete, restart sender
- [ ] Decode error / camera error / corruption error

### Copy quality
- [ ] Keep reason-specific wording (no vague catch-all errors).

---

## 6) Out-of-scope cleanup / guardrails

- [ ] Verify no out-of-scope recovery features are added (ACK/NACK, auto resend-until-success, loop mode, etc.).
- [ ] Keep single active transfer only.
- [ ] Keep implementation minimal and avoid architecture/framework rewrites.

---

## 7) Required tests (must exist before MVP sign-off)

### 7.1 Protocol tests
- [x] HEADER roundtrip parse/assemble
- [x] DATA roundtrip parse/assemble
- [x] END roundtrip parse/assemble
- [x] DATA CRC32 mismatch rejected
- [x] full-file CRC32 mismatch rejected
- [x] wrong protocol magic/version rejected
- [x] `transferId` required and validated
- [x] DATA with wrong `transferId` ignored by receiver logic

### 7.2 Sender tests
- [ ] file > 1 MiB rejected
- [ ] file read failure becomes user-visible error
- [ ] packetization failure becomes user-visible error
- [ ] QR encode failure becomes user-visible error

### 7.3 Receiver tests
- [x] DATA before HEADER ignored
- [x] receiver locks to one `transferId`
- [x] wrong-transfer DATA ignored
- [x] duplicate DATA does not corrupt state
- [x] END with incomplete packet set becomes terminal failure
- [x] no unique progress timeout becomes terminal failure
- [x] full packet set + matching CRC becomes success
- [x] out-of-range packet index handling verified
- [x] zero-byte file deterministic completion verified

---

## 8) Definition of done for this TODO

MVP is done when all checklist items above are complete and the acceptance criteria in `mvp.md` are demonstrably true in code + tests.
