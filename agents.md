# 🤖 Agent Instructions: QR Data Bridge

## 1. Project Background
This project is a **browser-based, offline-first data transfer tool** using animated QR codes. It enables users to transfer binary data (files, text, keys) between two devices without an internet connection, network stack, or backend server.

The core value proposition is **air-gapped reliability**. It must work in environments with no Wi-Fi, no Bluetooth, and no cellular signal. The transfer mechanism is visual (QR codes), meaning data is carried only through on-screen rendering and camera capture.

## 2. Project Structure
/
├── /sender # The Transmitter App (web app)
├── /receiver # The Receiver App (web app)
├── /protocol # Shared Logic (Chunking, Encoding, Checksums)
├── /docs # Documentation & Calibration Data
└── agents.md # This file

- **Sender:** Takes binary input, chunks it, generates QR stream.
- **Receiver:** Scans QR stream, reassembles chunks, verifies integrity, outputs binary.
- **Protocol:** Shared TypeScript library ensuring both sides speak the same language.

## 3. Core Technical Requirements

### 3.1 Stack
- **Language:** TypeScript (Strict Mode).
- **Build Tool:** Vite.
- **Styling:** Vanilla CSS or minimal utility classes (no heavy frameworks).
- **Dependencies:** Minimal. Only libraries essential for QR generation/scanning. All dependencies must be local npm packages and bundled in build output (no remote runtime dependencies).

### 3.2 Data Handling
- **Binary First:** All data is treated as `Uint8Array` from the start. Do not limit to text strings.
- **Any File Type:** Protocol must support arbitrary binary files (images, archives, PDFs, executables, etc.) without format-specific logic.
- **No Encryption:** Data is transmitted in plain format. Security relies on physical line-of-sight.
- **Checksums:** Every packet must include a checksum (e.g., CRC32). The full file must include a hash verification upon reassembly.

### 3.3 Browser-Only Delivery
- Sender and receiver are browser web apps (no installability requirement).
- Build output should be static files that can be hosted anywhere.
- The transfer flow must avoid backend transfer APIs and work via camera + display only.

## 4. Protocol Specification (Draft)

The agent should implement or adhere to this logical structure:

1. **Transfer Header (sent first):**
   - `magic` (fixed bytes, e.g., `QDB1`)
   - `version` (protocol version)
   - `transferId` (random session id)
   - `fileNameUtf8`
   - `mimeType` (optional, fallback `application/octet-stream`)
   - `fileSizeBytes` (u64)
   - `chunkSizeBytes` (u32)
   - `totalPackets` (u32)
   - `fullFileHash` (e.g., SHA-256 bytes)
2. **Data Packet (repeated):**
   - `transferId`
   - `packetIndex` (0-based)
   - `totalPackets`
   - `payloadLength`
   - `payload` (`Uint8Array` slice)
   - `packetChecksum` (CRC32)
3. **Optional End Marker:** `transferId` + explicit `END` frame for UX clarity.
4. **Stream:** QR codes are displayed sequentially.
5. **Verification:** Receiver validates per-packet checksums, reassembles in index order, verifies final file hash, then emits original bytes for download.

## 5. Agent Rules & Guidelines

### 5.1 Development Philosophy
- **Reliability > Speed:** It is better to transfer slowly and correctly than quickly with errors. Optimize for successful decoding in sub-optimal lighting conditions.
- **Simplicity > Features:** Avoid complex handshakes (ACK/NACK) in the initial prototype. Focus on a robust one-way stream first.
- **Transparency:** Log decoding errors to the console for debugging. Show clear status to the user (e.g., "Scanning...", "Packet 5/20", "Complete").

### 5.2 Code Quality
- **Type Safety:** No `any` types. Define interfaces for Packets, Chunks, and Transfer State.
- **Modularity:** Keep QR logic separate from UI logic. Keep Protocol logic separate from App logic.
- **Testing:** Provide manual testing steps for each feature. (e.g., "Verify large file transfer", "Verify interrupted scan").

### 5.3 Constraints
- **NO Crypto Libraries for Secrecy:** Do not add encryption/decryption features.
- **Hashing for Integrity Is Allowed:** Use standard browser/Web Crypto hashing only for integrity verification.
- **NO Network Transfer Logic:** Do not use `fetch`, `WebSocket`, or `XMLHttpRequest` for data transfer between devices.
- **NO External CDNs:** All libraries must be npm installed and bundled. No remote script tags.

## 6. Workflow & Testing

### 6.1 Local Development
- Run both `/sender` and `/receiver` concurrently on different ports (e.g., 5173 and 5174).
- Test using two browser tabs or two physical devices.

### 6.2 Calibration
- The agent should consider tunable parameters in the code (even if not exposed in UI yet):
  - `QR_ERROR_CORRECTION_LEVEL` (L, M, Q, H)
  - `FRAME_DURATION_MS` (Time per QR)
  - `CHUNK_SIZE_BYTES` (Data per QR)
- Default to conservative settings (High error correction, slower frame rate) to ensure success.

### 6.3 Deployment
- Build output must be static files ready for simple static hosting.
- Verify all assets and libraries are bundled for runtime without external CDNs.

## 7. Current Priority
1. **Setup:** Initialize repo structure and shared protocol package.
2. **Core:** Implement binary chunking and QR generation/scanning.
3. **Verify:** Successfully transfer small and mixed file types (e.g., 10KB text, image, zip) from Sender to Receiver.
4. **Polish:** Add progress indicators and error handling.

## 8. Known Challenges
- **Camera Permissions:** Handle denial gracefully.
- **Lighting:** QR scanning fails in low light. UI should warn users.
- **Motion Blur:** Users move phones too fast. UI should suggest "Hold Steady".
- **Browser Limits:** Some browsers throttle background tabs. Keep tabs active during transfer.

---

**Agent Note:** If you encounter ambiguity in the protocol, choose the option that maximizes **data integrity**. If a design choice adds complexity, propose a simpler alternative first.
