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
- [ ] Add `transferId` to **DATA** frame type, assembly, and parsing.
- [ ] Include/validate **protocol version** explicitly per frame format (current parser mostly relies on magic bytes).
- [ ] Keep supported frame types exactly `HEADER`, `DATA`, `END` only.

### 2.2 Transfer identity and lock isolation
- [ ] Receiver must lock on first valid HEADER and then ignore all non-matching frames (including HEADER) until `SUCCESS`, `ERROR`, or manual reset.
- [ ] Remove any behavior that auto-resets/merges when a different transfer is seen mid-attempt.

### 2.3 Integrity
- [ ] Preserve per-packet CRC32 validation for DATA.
- [ ] Preserve full-file CRC32 validation after reassembly.
- [ ] Ensure CRC failures are explicit user-visible error reasons (not silent).

### 2.4 Packet index validity
- [ ] Explicitly ignore/reject DATA frames with index outside `0..totalPackets-1`.
- [ ] Keep first valid payload for an index; duplicates must not overwrite.

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
- [ ] Ensure receiver uses required states exactly: `IDLE`, `SCANNING`, `RECEIVING`, `VERIFYING`, `SUCCESS`, `ERROR`.
- [ ] Make `ERROR` terminal for current attempt (no silent continued merging).

### 4.2 Passive-only constraints
- [ ] Keep receiver fully passive: no ACK/NACK/requests and no assumptions sender can react.

### 4.3 Ignorable frames vs terminal errors
- [ ] While scanning, treat these as ignorable (non-terminal):
  - DATA before valid HEADER
  - duplicate DATA for existing packet index
  - non-matching `transferId` frames
  - malformed/noise frames
- [ ] Reserve terminal `ERROR` for:
  - camera failure
  - END seen while incomplete after grace window
  - no unique progress timeout
  - reassembly/verification failures

### 4.4 Completion semantics
- [ ] Complete only when all packet indices exist, reassembly succeeds, full-file CRC32 passes, and file size matches expected.
- [ ] END frame alone must never be treated as success.

### 4.5 Fixed MVP timeout behavior
- [ ] Implement fixed END grace window: **2000 ms**.
- [ ] Implement fixed no-unique-progress timeout: **15000 ms**.
- [ ] Track `lastUniquePacketAt` and do not let duplicates extend timeout.
- [ ] On timeout/incomplete END, transition to terminal ERROR with actionable message.
- [ ] Do not depend on sender runtime settings (frame duration/redundancy) unless explicitly in protocol metadata.

### 4.6 Post-failure behavior
- [ ] After terminal failure, keep explicit ERROR state until user restart/reset.
- [ ] Do not silently continue receiving into failed attempt.

### 4.7 Zero-byte files
- [ ] Support zero-byte files with deterministic behavior (explicit success/failure path, no hangs).

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
- [ ] HEADER roundtrip parse/assemble
- [ ] DATA roundtrip parse/assemble
- [ ] END roundtrip parse/assemble
- [ ] DATA CRC32 mismatch rejected
- [ ] full-file CRC32 mismatch rejected
- [ ] wrong protocol magic/version rejected
- [ ] `transferId` required and validated
- [ ] DATA with wrong `transferId` ignored by receiver logic

### 7.2 Sender tests
- [ ] file > 1 MiB rejected
- [ ] file read failure becomes user-visible error
- [ ] packetization failure becomes user-visible error
- [ ] QR encode failure becomes user-visible error

### 7.3 Receiver tests
- [ ] DATA before HEADER ignored
- [ ] receiver locks to one `transferId`
- [ ] wrong-transfer DATA ignored
- [ ] duplicate DATA does not corrupt state
- [ ] END with incomplete packet set becomes terminal failure
- [ ] no unique progress timeout becomes terminal failure
- [ ] full packet set + matching CRC becomes success
- [ ] out-of-range packet index handling verified
- [ ] zero-byte file deterministic completion verified

---

## 8) Definition of done for this TODO

MVP is done when all checklist items above are complete and the acceptance criteria in `mvp.md` are demonstrably true in code + tests.
