# QR Data Bridge MVP Requirements and Limits

## Purpose
This MVP delivers a **minimal, one-way QR file transfer** that is dependable for small files in controlled conditions.

It is intentionally limited. The goal is correctness and clarity, not advanced recovery or automation.

## Scope (What MVP Assumes)
- Receiver is **passive only**.
- Transfer is **one-way only** (sender -> receiver).
- No return channel/backchannel exists.
- No continuous sender loop.
- No guaranteed late-join success.
- Manual restart/retry is acceptable.
- Slow transfer is acceptable.
- Practical target size is **under 1 MiB** (recommended target is **<= 512 KiB** for better MVP reliability).
- Expected environment: one sender screen, one receiver camera, user can restart if needed.

## Hard Product Limits (Mandatory)

### File size
- Sender must reject files larger than **1 MiB** before transmission starts.
- UI should warn for files above **512 KiB** (example: large files may be slow and fail more often).

### One active transfer per receiver
- Receiver handles only one active transfer at a time.
- After a valid header, receiver locks to that `transferId`.
- Once locked, receiver must ignore all frames, including `HEADER` frames, whose `transferId` does not match the active transfer until the current attempt reaches `SUCCESS`, `ERROR`, or is manually reset.

### No late-join guarantee
- If receiver starts scanning late, completion is not guaranteed.
- UI can advise user to restart sender.

### No automatic recovery
MVP must not include:
- Retransmit requests
- ACK/NACK
- Fountain/FEC
- Adaptive pacing
- Automatic resend loop
- Background recovery behavior

## Non-goals (Do Not Implement in MVP)
- Two-way communication
- TCP/WebSocket/BLE/audio return paths
- Continuous sender looping
- Automatic resend-until-success
- Multi-file queue
- Resume support
- Cross-device signaling
- Voice guidance
- Verification stronger than CRC32
- Large-file optimization beyond 1 MiB cap
- Worker-thread refactors unless required for bug fixes
- Multiple concurrent transfers in one receiver session
- Fancy diagnostics beyond basic progress/warnings/errors

## Protocol Requirements

### Frame types
MVP supports exactly:
- `HEADER`
- `DATA`
- `END`

No extra frame types.

### Required fields
- `HEADER`: protocol magic/version, `transferId`, file name, file size, total packet count, full-file CRC32.
- `DATA`: protocol magic/version, `transferId`, packet index, payload bytes, packet CRC32.
- `END`: protocol magic/version, `transferId`.

### Integrity
- Every DATA frame must pass packet CRC32.
- Reassembled file must pass full-file CRC32.
- CRC32 is only for accidental corruption detection (not cryptographic security).

### Transfer identity
- `transferId` is required in every frame.
- Once locked to an active transfer, receiver must ignore any frame type (`HEADER`, `DATA`, or `END`) whose `transferId` does not match the active transfer until `SUCCESS`, `ERROR`, or manual reset.
- A new header with a different `transferId` must not silently merge into current transfer.

## Sender Behavior

### Workflow
1. User selects file.
2. Sender validates file size.
3. Sender packetizes file.
4. Sender shows ready state.
5. User presses start.
6. Optional countdown.
7. Sender outputs HEADER -> DATA in order -> END.
8. Sender enters stable finished state until user restarts or chooses another file.

### Transmission mode
- One-pass only.
- No automatic full-transfer repeat.
- No continuous HEADER/END loops.
- No waiting for receiver confirmation.

### Error handling
Sender must surface user-visible errors (no crashes/unhandled promises) for:
- file read failures
- packetization failures
- too many packets
- filename encoding limit issues (must fail with clear error; no silent truncation)
- QR encode failures
- finalize/render failures

### Final state message
After END, sender shows stable finished state. This is informational only and must not imply receiver success.

Recommended text: **"Transmission finished. If receiver did not complete, restart sender."**

## Receiver Behavior

### Workflow
1. Idle.
2. Start scan.
3. Wait for valid HEADER.
4. Lock active `transferId`.
5. Collect matching DATA packets.
6. When complete, verify file.
7. Show success or failure.
8. User manually restarts for next attempt.

### Passive-only rules
Receiver must not:
- Send confirmations
- Influence sender behavior
- Assume sender can react
- Wait for a backchannel that does not exist

### Packet handling rules
- Ignore DATA before a valid HEADER.
- Ignore invalid magic/version and malformed/noise frames while scanning.
- Ignore any frame with wrong `transferId` once a transfer is locked.
- Ignore or reject DATA frames whose packet index is outside `0..totalPackets-1`.
- Accept duplicate DATA safely.
- Keep one payload per packet index.
- Keep first valid payload for an index (do not overwrite unless protocol later allows).

### Completion rule
Receiver succeeds only when all are true:
- Every packet index `0..totalPackets-1` is present
- File reassembly succeeds
- Full-file CRC32 passes
- File size matches expected size

Zero-byte files are allowed and must still complete deterministically (successful verification when metadata/checks pass, otherwise explicit failure).

`END` alone is never success.

### Failure rule (must not wait forever)
For MVP, receiver timeout behavior uses fixed values:
- END grace window: `2000 ms`
- No unique progress timeout: `15000 ms`

Receiver must not depend on sender runtime settings such as frame duration or redundancy unless those values are explicitly included in protocol metadata.

Receiver must enter terminal failure if either occurs:

A) END seen while transfer still incomplete -> fail after `2000 ms` grace window.

B) No unique progress timeout -> fail when no new unique packet arrives for `15000 ms`.
- Track `lastUniquePacketAt`.
- Duplicate packets must not reset this timer.

User-facing timeout copy: **"Transfer incomplete. Some packets were missed. Restart sender."**

### Ignorable frames vs terminal errors
Frames that may be ignored without entering terminal `ERROR`:
- DATA before valid HEADER
- Duplicate DATA for an already accepted packet index
- Frames with non-matching `transferId`
- Malformed/noise frames encountered while scanning

Terminal `ERROR` is reserved for:
- Camera failure
- END seen while transfer remains incomplete after `2000 ms` grace window
- No unique progress for `15000 ms`
- File reassembly or verification failure

### After failure
- Error state is terminal for that attempt.
- Receiver stays in explicit error until user reset/restart.
- Do not keep silently merging packets into failed attempt.

## State Machine Requirements

### Sender states
Required explicit states:
- `NO_FILE`
- `READY`
- `COUNTDOWN`
- `TRANSMITTING`
- `COMPLETE`
- `ERROR`

Optional: `FILE_INVALID`.

### Receiver states
Required explicit states:
- `IDLE`
- `SCANNING`
- `RECEIVING`
- `VERIFYING`
- `SUCCESS`
- `ERROR`

Receiver `ERROR` is terminal for current attempt.

## UI/UX Rules

### Simplicity
Keep UI plain and explicit; avoid complex dashboards.

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

## Reliability Definition for MVP
MVP reliability means:
- Correct packets accepted
- Corrupted packets rejected
- Wrong-transfer packets ignored
- Completed files verified
- Incomplete transfers terminate clearly
- Manual retry is possible

MVP reliability does **not** mean:
- Guaranteed success under packet loss
- Guaranteed late join
- Automatic recovery
- Unattended completion

## Environment Assumptions
Assume:
- One sender screen visible
- Moderate alignment quality
- User can restart when needed
- Sender stays active through transfer

Do not build for hostile/noisy multi-sender conditions, but still prevent cross-transfer mixing.

## Implementation Rules
- No redesign: no framework migration, architecture rewrite, protocol v3, or unrelated feature expansion.
- Prefer minimal safe edits only where required for MVP correctness.
- Preserve existing UI structure unless correctness requires change.
- Make state transitions explicit (avoid fragile boolean combinations).
- No silent fallbacks: validation/decode failures must set clear state/message.
- Keep future path open (ACK/backchannel, loop mode, larger files), but do not implement now.

## Required Testing Before MVP Sign-off

### Protocol tests
- HEADER roundtrip parse/assemble
- DATA roundtrip parse/assemble
- END roundtrip parse/assemble
- DATA CRC32 mismatch rejected
- Full-file CRC32 mismatch rejected
- Wrong protocol magic/version rejected
- `transferId` required and validated
- DATA with wrong `transferId` ignored by receiver logic

### Sender tests
- File > 1 MiB rejected
- File read failure shown to user
- Packetization failure shown to user
- QR encode failure shown to user

### Receiver tests
- DATA before HEADER ignored
- Receiver locks to one `transferId` and ignores non-matching frames (including HEADER) until success/error/reset
- Wrong-transfer DATA ignored
- Duplicate DATA does not corrupt state
- Out-of-range packet index DATA is ignored/rejected
- END with incomplete packets becomes terminal failure after `2000 ms` grace
- No unique progress timeout (`15000 ms`) becomes terminal failure
- Full packet set + matching CRC becomes success
- Zero-byte file path is deterministic (explicit success/failure, no hang)

## MVP Acceptance Criteria
MVP is complete only if all are true:
- Sender rejects files above 1 MiB
- Receiver is passive only
- Protocol uses `transferId` in HEADER, DATA, and END
- Receiver ignores wrong-transfer DATA
- Per-packet CRC32 works
- Full-file CRC32 works
- Incomplete transfers do not wait forever (END grace `2000 ms`, no-progress timeout `15000 ms`)
- Sender exceptions are caught and surfaced (including filename encoding limit failures, with no silent truncation)
- Receiver success requires full packet coverage and file verification (with explicit deterministic handling for zero-byte files)
- Manual retry works cleanly
- No out-of-scope features added

## Explicitly Deferred (Future, Not MVP)
- Sender loop/repeat mode
- Receiver-to-sender success signal
- Hold-final-screen-until-ACK behavior
- Richer diagnostics
- Voice prompts
- Beyond-1 MiB support
- Smarter timeout tuning
- Stronger hashes
- Resumable sessions
- Adaptive redundancy

## Execution Rule (Short Form)
Implement only this MVP. Do not add backchannel, loop mode, automatic recovery, larger-file support, or protocol redesign beyond required transferId-in-all-frames, CRC validation, explicit terminal failure behavior, and clear sender/receiver error handling.

Scope MVP honestly: passive receiver, one-way transmission, practical size under 1 MiB, slow allowed, manual retry allowed, no guaranteed late join, no continuous loop, and no backchannel.
