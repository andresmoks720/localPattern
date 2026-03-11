# QR Data Bridge MVPv2 Requirements and Limits

## Purpose

MVPv2 delivers a **minimal, one-way QR file transfer** that is dependable for small files in controlled conditions and is built on a cleaner protocol/service boundary than the earlier MVP.

It is intentionally limited. The goal is correctness, determinism, and cleaner implementation structure, not advanced recovery, automation, or bidirectional negotiation.

---

## Scope (What MVPv2 Assumes)

- Receiver is **passive only**.
- Transfer is **one-way only** (`sender -> receiver`).
- No return channel/backchannel exists.
- No continuous sender loop.
- No guaranteed late-join success.
- Manual restart/retry is acceptable.
- Slow transfer is acceptable.
- Practical target size is **under 1 MiB**.
- Recommended target is **<= 512 KiB** for better reliability and transfer time.
- Expected environment: one sender screen, one receiver camera, user can restart if needed.

---

## Product Split Rule

This spec is for **MVPv2 one-way only**.

Future two-way behavior must be treated as a **separate product mode** and must not be smuggled into MVPv2 through hidden conditionals, dormant control messages, handshake stubs, or partially implemented backchannel logic.

---

## Hard Product Limits (Mandatory)

### File size
- Sender must reject files larger than **1 MiB** before transmission starts.
- UI should warn for files above **512 KiB** with concrete copy such as:
  - `Large files may take a long time and may fail more often.`

### One active transfer per receiver
- Receiver handles only **one active transfer** at a time.
- After a valid `HEADER`, receiver locks to that `transferId`.
- Once locked, receiver must ignore all frames, including `HEADER` frames, whose `transferId` does not match the active transfer until the current attempt reaches `SUCCESS`, `ERROR`, or is manually reset.

### No late-join guarantee
- If receiver starts scanning late, completion is not guaranteed.
- UI may advise user to restart sender.

### No automatic recovery
MVPv2 must not include:
- Retransmit requests
- ACK/NACK
- Fountain/FEC
- Adaptive pacing
- Automatic resend loop
- Background recovery behavior
- Receiver-driven repair mode

---

## Non-goals (Do Not Implement in MVPv2)

- Two-way communication
- TCP/WebSocket/BLE/audio return paths
- Continuous sender looping
- Automatic resend-until-success
- Multi-file queue
- Resume support
- Cross-device signaling
- Voice guidance
- Verification stronger than CRC32
- Large-file optimization beyond the 1 MiB cap
- Full worker-thread redesign unless required for a concrete performance or stability bug
- Multiple concurrent transfers in one receiver session
- Fancy diagnostics dashboards
- Per-chunk cryptographic hash acknowledgments
- Erasure coding / parity / fountain transport
- Hidden placeholders for future repair mode inside the MVP flow

---

## Protocol Requirements

### Protocol architecture boundary
- Treat protocol logic as a **small shared library boundary**, not scattered UI event logic.
- Keep protocol parsing/assembly, sender transmission logic, and receiver state machine logic in dedicated protocol/service modules.
- UI layer should orchestrate and render state, but must not own low-level frame parsing/serialization rules.
- Message formats and valid state transitions must be documented and testable outside browser view code.

### Frame types
MVPv2 supports exactly:
- `HEADER`
- `DATA`
- `END`

No extra frame types.

### Protocol constants and binary contract

#### Wire identity
- Protocol magic/version is the ASCII byte sequence: **`QDB2`**
- Any other magic must be rejected.
- Legacy magic such as `QDB1` must be rejected as incompatible.

#### Frame type codes
- `HEADER` type byte: `0x01`
- `DATA` type byte: `0x02`
- `END` type byte: `0x03`

#### Numeric encoding
- All numeric fields use **unsigned integers**.
- All multi-byte numeric fields use **big-endian** byte order.

#### Transfer identity
- `transferId` is required in **every** frame.
- `transferId` length is exactly **8 bytes**.
- `transferId` must be generated as a **new random value for each send attempt**.
- Retrying the same file must still create a **new** `transferId`.
- `transferId` must **not** be derived from file content, filename, or timestamp alone.

#### File name
- File name encoding is **UTF-8**.
- File name byte length is stored as **uint16**.
- Maximum file name byte length is **65535 bytes**.
- If filename encoding exceeds protocol limits or cannot be encoded as required, sender must fail with a clear user-visible error.
- MVPv2 must not silently truncate filenames.

#### Packet and size fields
- `totalPackets` is stored as **uint16**.
- Maximum packet count is **65535**.
- `packetIndex` is stored as **uint16**.
- Valid `packetIndex` range is `0..totalPackets-1`.
- `fileSize` is stored as **uint32**.
- Maximum protocol file size field is **4294967295 bytes**, but MVPv2 sender still hard-limits files to **1 MiB**.
- `totalPackets = 0` is valid **only** when `fileSize = 0`.
- For any non-empty file, `totalPackets` must be at least `1`.

#### DATA payload
- Maximum payload bytes per `DATA` frame is **1024 bytes**.
- Recommended default payload bytes per `DATA` frame is **512 bytes**.
- Sender-configured payload size, if user-configurable, must stay within **128..1024 bytes**.
- Advanced payload-size configuration is optional and should remain hidden or minimal in MVPv2.
- Protocol max payload size is not a guarantee of practical scanability at all QR render settings and devices; sender defaults must prioritize successful decoding over theoretical density.
- For `DATA` frames, `payloadLen` must be within `1..maxPayloadBytes` and must match the actual encoded payload byte count exactly.

### Exact wire layout

All layouts below are byte-exact and authoritative.

#### HEADER layout
`magic(4) | type(1) | transferId(8) | fileNameLen(2) | fileNameUtf8(n) | fileSize(4) | totalPackets(2) | fileCrc32(4)`

#### DATA layout
`magic(4) | type(1) | transferId(8) | packetIndex(2) | payloadLen(2) | payload(n) | packetCrc32(4)`

#### END layout
`magic(4) | type(1) | transferId(8)`

### Required fields

#### `HEADER`
- Protocol magic/version
- frame type byte
- `transferId`
- file name length
- UTF-8 file name bytes
- file size
- total packet count
- full-file CRC32

#### `DATA`
- Protocol magic/version
- frame type byte
- `transferId`
- packet index
- payload length
- payload bytes
- packet CRC32

#### `END`
- Protocol magic/version
- frame type byte
- `transferId`

### CRC coverage
CRC behavior is fixed and must not vary between implementations.

#### Packet CRC32
- Packet CRC32 is computed over:
  - `transferId(8)`
  - `packetIndex(2)`
  - `payload(n)`

It is **not** computed over:
- magic
- frame type byte
- payload length field
- outer frame bytes beyond the fields above

#### Full-file CRC32
- Full-file CRC32 is computed over the **original file bytes only**.
- It is **not** computed over:
  - file name
  - metadata
  - protocol framing
  - QR/text transport encoding artifacts

### Integrity
- Every `DATA` frame must pass packet CRC32.
- Reassembled file must pass full-file CRC32.
- CRC32 is only for accidental corruption detection, not cryptographic security.

### Transfer identity
- `transferId` is required in every frame.
- Once locked to an active transfer, receiver must ignore any frame type (`HEADER`, `DATA`, or `END`) whose `transferId` does not match the active transfer until `SUCCESS`, `ERROR`, or manual reset.
- A new `HEADER` with a different `transferId` must not silently merge into the current transfer.

### Typed messages and states
- Frame/message categories must be explicit typed variants or classes (`HEADER`, `DATA`, `END`) instead of inferred flags or booleans.
- Sender and receiver states must be explicit typed states with constrained transitions.
- Error handling must use explicit machine-readable error categories/codes plus user-facing messages.

### Zero-byte file protocol
Zero-byte files are allowed and must follow this exact protocol:

- `fileSize = 0`
- `totalPackets = 0`
- Sender emits `HEADER`, then `END`
- Sender emits **no DATA frames**
- Receiver succeeds only after:
  - receiving valid `HEADER`
  - receiving valid `END`
  - verifying zero-byte metadata and full-file CRC32 for an empty file

For `totalPackets = 0`, receiver must **not** finalize on `HEADER` alone even though the packet set is vacuously complete; it must wait for valid `END`.

### Repeated matching control-frame behavior
- Repeated matching `HEADER` after lock with the same `transferId` is a **no-op**, not a reset, **only if** all locked header metadata matches exactly.
- If a later `HEADER` has the same `transferId` but conflicting metadata (`fileName`, `fileSize`, `totalPackets`, or `fileCrc32`), that is a **terminal protocol error** for the attempt.
- Repeated matching `END` after already seeing matching `END` is a **no-op**.
- `END` before valid `HEADER` is ignored.

### Protocol anti-pattern bans
MVPv2 must not use:
- Content-derived short IDs as transfer identity
- Base64/Data-URL-as-core-payload architecture
- “First data chunk is special header” delimiter formats
- Text/JSON-first transport framing for file payloads
- Success defined only as “all indices seen” without final file verification

---

## Sender Behavior

### Workflow
1. User selects file.
2. Sender validates file size.
3. Sender reads file bytes.
4. Sender packetizes file.
5. Sender precomputes frame payloads.
6. Sender validates that chosen settings can encode all required frame types.
7. Sender estimates packet count and transfer duration.
8. Sender shows ready state.
9. User presses start.
10. Optional countdown.
11. Sender outputs `HEADER -> DATA in order -> END`.
12. Sender enters stable finished state until user restarts or chooses another file.

### Transmission mode
- One-pass only.
- No automatic full-transfer repeat.
- No continuous `HEADER` / `END` loops.
- No waiting for receiver confirmation.

### Frame preparation and caching
- Sender must precompute packetization and frame payloads before transmission starts.
- Sender must avoid rebuilding packet content on every render tick if it can be prepared once.
- Cached frame preparation must not change protocol behavior; it is a sender performance optimization only.

### Settings preflight validation
Before entering `READY`, sender must validate that:

- current file size and metadata are valid
- packetization succeeds
- all required frame payloads can be built
- chosen QR/render settings can encode all required frame types successfully

Invalid settings must fail **before** transmission, not halfway through.

### Control-frame visibility rules
To reduce the chance of missing the only metadata or terminal frame:

- `HEADER` QR must remain visible for at least **2000 ms** before the first `DATA` frame is shown.
- `END` QR must remain visible for at least **3000 ms** before switching to the final non-QR completion screen.

These are not loops or retries. They are fixed minimum hold durations for control-frame visibility.

### Final screen separation
Sender completion must follow this order:

1. Transmit `END`
2. Keep the actual `END` QR visible for the required hold duration
3. Only then switch to the non-QR final completion screen

Sender must not replace `END` immediately with a pretty completion view.

### Estimated transfer duration
Before transmission starts, sender should show:
- estimated packet count
- estimated transfer duration based on current settings

This is required product honesty, not optional decoration.

### Rendering rules
- Sender must provide a stable QR display area during transfer.
- Sender should support a fullscreen or maximize-QR mode.
- Sender must avoid layout shifts, animated clutter, or resizing that changes QR rendering geometry mid-transfer.
- QR display must remain square and visually stable throughout the transfer.
- Preserve quiet zone around the QR.
- Avoid overlays crossing the QR.
- Avoid CSS transforms or blurry scaling on the QR canvas/image.
- Use high-contrast rendering only.

### Page visibility and interruption behavior
If sender page becomes hidden, suspended, background-throttled, or visibly interrupted during active transmission:

- sender must stop the current attempt
- sender must not silently continue under throttled timers
- sender must show a restart-required message

Recommended copy:
- `Transmission interrupted. Restart required.`

### Error handling
Sender must surface user-visible errors, with no crashes or unhandled promise rejections, for:
- file read failures
- packetization failures
- too many packets
- filename encoding limit issues
- QR encode failures
- frame precompute failures
- finalize/render failures
- invalid preflight settings

### Final state message
After END handling completes, sender shows a stable finished state. This is informational only and must not imply receiver success.

Recommended text:

**`Transmission finished. If receiver did not complete, restart sender.`**

### Abort/reset lifecycle
- Sender must have one explicit stop/reset path that clears timers, cached transfer state, and any active resources tied to the attempt.
- Starting a new send must not inherit stale transfer state from the previous one.

### Manual retry semantics
Manual retry always starts a **fresh attempt**.

A fresh attempt means:
- a new random `transferId`
- new frame precompute
- cleared sender terminal state
- no reuse of partial packet state from the previous attempt

---

## Receiver Behavior

### Workflow
1. Idle
2. Start scan
3. Wait for valid `HEADER`
4. Lock active `transferId`
5. Collect matching `DATA` packets
6. When complete, verify file
7. Show success or failure
8. User manually restarts for next attempt

### Passive-only rules
Receiver must not:
- Send confirmations
- Influence sender behavior
- Assume sender can react
- Wait for a backchannel that does not exist

### Packet handling rules
- Ignore `DATA` before a valid `HEADER`.
- Ignore invalid magic/version and malformed/noise frames while scanning.
- Ignore any frame with wrong `transferId` once a transfer is locked.
- Ignore or reject `DATA` frames whose `packetIndex` is outside `0..totalPackets-1`.
- Accept duplicate `DATA` safely.
- Keep one payload per packet index.
- Keep the first valid payload for an index and ignore later duplicates for that index.
- `DATA` frames that fail packet CRC32 validation are ignored and must not enter terminal `ERROR` by themselves.

### Scanner dedupe vs protocol dedupe
These are separate concerns and must remain separate in code and tests.

#### Scanner ingress dedupe
- Avoid reprocessing the exact same decoded QR payload repeatedly in immediate succession if scanner output is noisy.
- This is an ingress optimization only.

#### Protocol dedupe
- Once a `DATA` frame for the active `transferId` and `packetIndex` has been accepted, later duplicates for that same packet index must be ignored.
- Protocol correctness must not depend on scanner dedupe behavior.

### Completion rule
Receiver succeeds only when all are true:
- Every packet index `0..totalPackets-1` is present
- File reassembly succeeds
- Full-file CRC32 passes
- File size matches expected size

`END` alone is never success.

### Failure rule (must not wait forever)
For MVPv2, receiver timeout behavior uses fixed values:
- `END` grace window: **2000 ms**
- No unique progress timeout: **15000 ms**

Receiver must not depend on sender runtime settings such as frame duration or redundancy unless those values are explicitly included in protocol metadata.

Receiver must enter terminal failure if either occurs:

#### A) `END` seen while transfer still incomplete
- Fail after the `2000 ms` grace window.

#### B) No unique progress timeout
- Fail when no new unique packet arrives for `15000 ms`.
- Track `lastUniquePacketAt`.
- Duplicate packets must not reset this timer.

User-facing timeout copy:

**`Transfer incomplete. Some packets were missed. Restart sender.`**

### Error model
- Use structured machine-readable error codes.
- Suggested categories include:
  - protocol parse error
  - invalid frame version
  - invalid transfer/session
  - invalid packet index
  - packet checksum mismatch
  - file checksum mismatch
  - timeout
  - camera failure
  - verification failure
- Map each error code to clear user-facing copy.
- Tests should assert error codes where relevant, not only message text.

### Ignorable frames vs terminal errors
Frames that may be ignored without entering terminal `ERROR`:
- `DATA` before valid `HEADER`
- duplicate `DATA` for an already accepted packet index
- frames with non-matching `transferId`
- malformed/noise frames encountered while scanning
- repeated matching `HEADER` rescans for the already locked `transferId`
- repeated matching `END` rescans for the already locked `transferId`
- `DATA` frames with bad packet CRC32

Terminal `ERROR` is reserved for:
- camera failure
- same-`transferId` `HEADER` with conflicting locked metadata
- `END` seen while transfer remains incomplete after `2000 ms`
- no unique progress for `15000 ms`
- file reassembly or verification failure

### Queue / ingest discipline
- Receiver must process accepted decoded frames through a single deterministic ingest path.
- Camera/scanner callbacks must not mutate protocol state from multiple concurrent paths.
- A queue or equivalent serialization mechanism is recommended for frame ingestion, even if a dedicated worker is not introduced in MVPv2.

### Camera and scanner UX rules
- Prefer rear/back camera on mobile when available.
- Provide clear camera selection fallback if preferred camera selection fails.
- Receiver should present a stable scan region/alignment guide.
- Camera readiness must depend on actual media readiness, not fixed sleep hacks.

### After failure
- Error state is terminal for that attempt.
- Receiver stays in explicit error until user reset/restart.
- Terminal `ERROR` must stop further protocol ingestion for that attempt until reset.
- Do not keep silently merging packets into failed attempt.

### Manual retry semantics
Manual retry always starts a **fresh attempt**.

A fresh attempt means:
- empty receiver packet store
- cleared active `transferId`
- cleared terminal state
- no reuse of partial packets from the prior attempt

---

## State Machine Requirements

### Sender states
Required explicit states:
- `NO_FILE`
- `READY`
- `COUNTDOWN`
- `TRANSMITTING`
- `COMPLETE`
- `ERROR`

Optional:
- `FILE_INVALID`

### Receiver states
Required explicit states:
- `IDLE`
- `SCANNING`
- `RECEIVING`
- `VERIFYING`
- `SUCCESS`
- `ERROR`

Receiver `ERROR` is terminal for the current attempt.

### State transition discipline
- State transitions must be explicit and centralized.
- Do not rely on loosely coupled booleans to infer transport state.
- Reset must be a first-class transition path and must be testable.

---

## UI/UX Rules

### Simplicity
Keep UI plain and explicit. Avoid complex dashboards.

### Sender copy (required)
- No file selected
- File too large
- Ready to transmit
- Starting in…
- Sending packet X / N
- Transmission finished
- Error with actionable reason

### Receiver copy (required)
- Ready to scan
- Waiting for header
- Receiving packets
- Verifying
- File ready
- Transfer incomplete, restart sender
- Decode error / camera error / corruption error

### Copy quality
Use concrete reasons. Prefer buckets like:
- Waiting for header
- Invalid/corrupted packet
- Transfer incomplete
- Camera unavailable
- File verification failed

Avoid vague catch-all wording.

### Operator guidance
Receiver and/or sender UI should include concise practical hints such as:
- hold devices steady
- keep QR fully visible
- move closer if scanning is unstable
- use fullscreen QR mode if available
- larger files may take much longer

These hints must stay simple and must not become a tuning cockpit.

### Stable visual geometry
- QR display must remain square.
- Avoid frame-to-frame visual “breathing” caused by changing layout/container size.
- Keep nonessential UI away from the QR area during active transfer.
- Receiver scan region should also remain stable and square.

---

## Reliability Definition for MVPv2

MVPv2 reliability means:
- correct packets accepted
- corrupted packets rejected
- wrong-transfer packets ignored
- completed files verified
- incomplete transfers terminate clearly
- manual retry is possible

MVPv2 reliability does **not** mean:
- guaranteed success under packet loss
- guaranteed late join
- automatic recovery
- unattended completion
- receiver-driven repair

---

## Environment Assumptions

Assume:
- one sender screen visible
- moderate alignment quality
- user can restart when needed
- sender stays active through transfer

Do not build for hostile/noisy multi-sender conditions, but still prevent cross-transfer mixing.

---

## Resource Lifecycle Rules

On reset, new attempt, or teardown, the app must explicitly clean up any attempt-scoped resources.

### Sender cleanup
- clear timers/timeouts
- clear cached frame payloads
- clear active transfer state
- clear progress state
- release wake/visibility-linked resources if used
- revoke any precomputed rendered frame resources if they allocate browser objects beyond plain byte arrays

### Receiver cleanup
- stop camera tracks
- clear timers/intervals/requestAnimationFrame
- clear packet store
- clear active `transferId`
- clear terminal download state and any Blob URL
- clear attempt-specific diagnostics and counters

Stale-resource bugs must be treated as correctness bugs, not mere polish issues.

---

## Implementation Rules

- No redesign: no framework migration, architecture rewrite, protocol v3, or unrelated feature expansion.
- Prefer minimal safe edits only where required for MVPv2 correctness.
- Preserve existing UI structure unless correctness requires change.
- Make state transitions explicit.
- No silent fallbacks: validation/decode failures must set clear state/message.
- Keep future path open for ACK/backchannel, loop mode, larger files, repair mode, and possible FEC, but do not implement them now.

### Dependency and packaging rules
- Do not depend on remote CDN delivery for core app functionality.
- Bundle or ship required app assets in a way consistent with offline/local use.
- Do not assume scanner performance from proprietary/commercial SDKs unless that exact scanner is part of the product.

### Transport and data rules
- Keep payload handling byte-oriented and file-oriented.
- Do not introduce opportunistic JSON parsing or type-shifting receive behavior.
- Do not couple protocol correctness to DOM-specific rendering quirks.

---

## Observability and Diagnostics (Minimal, not fancy)

MVPv2 may keep lightweight internal counters and hooks for:
- unique packets accepted
- duplicate packets ignored
- foreign frames ignored
- malformed/noise frames seen
- bad-packet-CRC frames ignored
- last unique packet timestamp
- finalize duration

These are implementation-facing or debug-facing signals and must not require a complex user dashboard.

### Progress and callback hooks
Core sender/receiver logic should expose simple progress/event hooks or equivalent seams so UI and tests can observe:
- frame rendered
- frame accepted
- transfer completed
- transfer failed

These hooks must not introduce backchannel semantics.

---

## Required Testing Before MVPv2 Sign-off

### Test harness architecture
- Core transfer/protocol logic must be testable with fake I/O.
- Protocol and state-machine tests must run without camera/scanner/QR renderer dependencies.
- UI/integration tests may cover scanner/renderer wiring, but correctness should primarily be validated in core logic tests.

### Fixture and replay discipline
- Maintain a corpus of known-good and known-bad frame fixtures.
- Frame parsing and receiver logic should be testable against prerecorded payload sequences, not only live camera scans.
- If practical, sender frame export/replay artifacts may be used for deterministic regression testing, but this is a test aid, not a product feature requirement.

### Protocol tests
- `HEADER` roundtrip parse/assemble
- `DATA` roundtrip parse/assemble
- `END` roundtrip parse/assemble
- exact frame byte layout matches spec
- packet CRC32 coverage matches spec
- full-file CRC32 coverage matches spec
- `DATA` CRC32 mismatch rejected
- full-file CRC32 mismatch rejected
- wrong protocol magic/version rejected
- `transferId` required and validated
- `DATA` with wrong `transferId` ignored by receiver logic
- repeated matching `HEADER` and `END` behave as specified
- same-`transferId` `HEADER` with conflicting metadata is a protocol error
- `END` before `HEADER` ignored
- `fileSize = 0` requires `totalPackets = 0`
- non-empty file requires `totalPackets >= 1`
- `payloadLen` bounds and exact byte-count matching enforced
- zero-byte file wire contract behaves exactly as specified

### Sender tests
- file > 1 MiB rejected
- file read failure shown to user
- packetization failure shown to user
- QR encode failure shown to user
- frame precompute failure shown to user
- filename encoding limit failure shown to user with no silent truncation
- chosen sender settings are preflight-validated before transmission begins
- estimated transfer duration shown before send
- `HEADER` and `END` hold durations obey spec
- sender hidden/interrupted during transmission stops attempt and requires restart
- reset clears previous attempt state completely
- manual retry creates a new random `transferId`

### Receiver tests
- `DATA` before `HEADER` ignored
- receiver locks to one `transferId` and ignores non-matching frames, including `HEADER`, until success/error/reset
- wrong-transfer `DATA` ignored
- duplicate `DATA` does not corrupt state
- out-of-range `packetIndex` `DATA` is ignored/rejected
- bad packet CRC causes frame ignore, not terminal failure
- scanner ingress dedupe does not replace protocol dedupe
- repeated matching `HEADER` after lock is a no-op only when metadata matches exactly
- same-`transferId` `HEADER` with conflicting metadata causes terminal protocol error
- repeated matching `END` is a no-op
- terminal `ERROR` stops further ingestion until reset
- `END` with incomplete packets becomes terminal failure after `2000 ms`
- no unique progress timeout (`15000 ms`) becomes terminal failure
- full packet set + matching CRC becomes success
- zero-byte file path is deterministic
- zero-byte file waits for `END`, not `HEADER` alone
- reset clears previous attempt state completely

### Empty-file coverage
- zero-byte file sender path emits deterministic `HEADER -> END` frame sequence and terminal state
- zero-byte file receiver path verifies deterministically with explicit success/failure reason
- zero-byte file path must not hang waiting for missing `DATA` frames

### Manual real-device test matrix
At minimum, perform and record manual checks for:
- phone sender -> phone receiver
- laptop sender -> phone receiver
- bright screen / low light
- portrait and landscape
- fullscreen on/off
- near max recommended file size
- zero-byte file
- restart after incomplete failure
- wrong-transfer frames visible in background

### CI hygiene
- fail CI on focused tests such as `test.only`
- fail CI on unhandled promise rejections during tests

---

## MVPv2 Acceptance Criteria

MVPv2 is complete only if all are true:
- sender rejects files above 1 MiB
- receiver is passive only
- protocol uses `transferId` in `HEADER`, `DATA`, and `END`
- exact frame byte layout is implemented as specified
- CRC coverage is implemented as specified
- receiver ignores wrong-transfer frames once locked
- bad packet CRC is treated as ignorable frame loss, not terminal attempt failure
- per-packet CRC32 works
- full-file CRC32 works
- incomplete transfers do not wait forever (`END` grace `2000 ms`, no-progress timeout `15000 ms`)
- sender exceptions are caught and surfaced, including frame-precompute failure and filename encoding limit failure
- chosen sender settings are preflight-validated before transmission begins
- receiver success requires full packet coverage and file verification
- zero-byte file path is deterministic
- manual retry works cleanly as a fresh attempt
- QR display stays visually stable during active transfer
- sender interruption/hidden-page behavior stops the attempt and requires restart
- core transport/state logic is testable outside browser view code
- no out-of-scope features were added

---

## Explicitly Deferred (Future, Not MVPv2)

- sender loop/repeat mode
- receiver-to-sender success signal
- hold-final-screen-until-ACK behavior
- richer diagnostics dashboards
- voice prompts
- beyond-1 MiB support
- smarter timeout tuning
- stronger hashes
- resumable sessions
- adaptive redundancy
- repair mode
- selective resend / skip-already-received
- handshake or readiness calibration
- erasure coding / parity / fountain transport

---

## Short Execution Rule for Codex

Implement only this one-way MVPv2.

Do not add backchannel, loop mode, automatic recovery, larger-file support, parity/FEC, or two-way handshake behavior.

Prefer minimal safe edits, explicit states, exact byte-oriented framing, fixed CRC coverage, random `transferId` per attempt, sender frame precompute, preflight settings validation, deterministic zero-byte behavior, explicit control-frame hold durations, serialized receiver ingest, stable QR rendering, clean resource reset, and tests that prove transfer isolation, verification, timeout handling, interruption handling, and deterministic failure behavior.
