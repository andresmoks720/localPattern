import './style.css';
import jsQR from 'jsqr';
import { calculateCRC32, parsePacket } from '@qr-data-bridge/protocol';

const QR_PREFIX = 'QDB64:';
const SCAN_INTERVAL_MS = 300;
const SIGNAL_LOST_MS = 5000;
const THEME_KEY = 'qdb_theme';

const logger = {
  debug: (...args: unknown[]) => {
    if (import.meta.env.DEV) {
      console.info(...args);
    }
  },
  error: (...args: unknown[]) => console.error(...args)
};

type ReceiverStage = 'IDLE' | 'SCANNING' | 'RECEIVING' | 'VERIFYING' | 'SUCCESS' | 'ERROR';

interface TransferState {
  totalPackets: number | null;
  receivedPackets: Map<number, Uint8Array>;
  fileHash: number | null;
  fileName: string;
  totalScans: number;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
}

function createTransferState(): TransferState {
  return { totalPackets: null, receivedPackets: new Map<number, Uint8Array>(), fileHash: null, fileName: '', totalScans: 0 };
}

function concatPayloads(payloads: Uint8Array[]): Uint8Array {
  const totalLength = payloads.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of payloads) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function playDing(): void {
  const context = new AudioContext();
  const o1 = context.createOscillator();
  const o2 = context.createOscillator();
  const gain = context.createGain();
  o1.frequency.value = 880;
  o2.frequency.value = 1175;
  gain.gain.value = 0.03;
  o1.connect(gain);
  o2.connect(gain);
  gain.connect(context.destination);
  o1.start();
  o2.start(context.currentTime + 0.03);
  o1.stop(context.currentTime + 0.11);
  o2.stop(context.currentTime + 0.15);
}

const app = getElement<HTMLDivElement>('#app');
app.innerHTML = `
<main class="layout">
  <section class="stage">
    <div class="video-wrap">
      <video id="camera-preview" autoplay muted playsinline></video>
      <div class="scan-overlay" aria-hidden="true"></div>
    </div>
  </section>
  <aside class="panel" id="receiver-panel" data-state="IDLE">
    <div class="row">
      <button id="scan-btn" type="button">Start Scan</button>
      <button id="theme-btn" type="button">Theme</button>
    </div>
    <label class="inline-check"><input id="sound-enabled" type="checkbox"/> Completion sound</label>
    <div id="status" class="status">Ready to scan</div>
    <div class="progress-wrap"><div id="progress-bar" class="progress-bar"></div></div>
    <div id="progress-text">Packet 0/0 (0%)</div>
    <div id="scan-stats">Received 0 scans → 0 unique packets</div>
    <div id="last-received-time">Last packet: -</div>
    <div id="warning" class="warning"></div>
    <button id="download-btn" type="button" disabled>Download File</button>
    <div class="hint">Tap Start Scan (required on iOS), keep brightness high on sender, and do not minimize this tab.</div>
    <div id="last-packet"></div>
  </aside>
</main>`;

const scanButton = getElement<HTMLButtonElement>('#scan-btn');
const statusEl = getElement<HTMLDivElement>('#status');
const video = getElement<HTMLVideoElement>('#camera-preview');
const progressBar = getElement<HTMLDivElement>('#progress-bar');
const progressText = getElement<HTMLDivElement>('#progress-text');
const scanStatsEl = getElement<HTMLDivElement>('#scan-stats');
const warningEl = getElement<HTMLDivElement>('#warning');
const panel = getElement<HTMLDivElement>('#receiver-panel');
const lastPacketEl = getElement<HTMLDivElement>('#last-packet');
const downloadButton = getElement<HTMLButtonElement>('#download-btn');
const lastReceivedTimeEl = getElement<HTMLDivElement>('#last-received-time');
const themeButton = getElement<HTMLButtonElement>('#theme-btn');
const soundEnabledInput = getElement<HTMLInputElement>('#sound-enabled');

const frameCanvas = document.createElement('canvas');
const frameContextCandidate = frameCanvas.getContext('2d', { willReadFrequently: true });
if (!frameContextCandidate) throw new Error('Failed to initialize frame canvas context.');
const frameContext = frameContextCandidate;

let rafId = 0;
let monitorInterval: number | null = null;
let activeStream: MediaStream | null = null;
let lastDecodedPayload = '';
let lastScanAt = 0;
let scanStartedAt = 0;
let lastPacketAt = 0;
let transferState = createTransferState();
let downloadUrl: string | null = null;
let soundEnabled = false;

function setTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function setStage(stage: ReceiverStage, message: string): void {
  panel.dataset.state = stage;
  statusEl.textContent = message;
}

function updateProgress(): void {
  const total = transferState.totalPackets ?? 0;
  const received = transferState.receivedPackets.size;
  const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressText.textContent = `Packet ${received}/${total} (${pct}%)`;
  scanStatsEl.textContent = `Received ${transferState.totalScans} scans → ${received} unique packets`;
}

function revokeDownloadUrl(): void {
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
  }
}

function stopCameraStream(): void {
  activeStream?.getTracks().forEach((track) => track.stop());
  activeStream = null;
  video.srcObject = null;
}

function resetTransferState(clearWarning = true): void {
  transferState = createTransferState();
  if (clearWarning) warningEl.textContent = '';
  updateProgress();
  revokeDownloadUrl();
  downloadButton.disabled = true;
  lastPacketAt = 0;
  lastReceivedTimeEl.textContent = 'Last packet: -';
}

function missingPacketIds(totalPackets: number, packets: Map<number, Uint8Array>): number[] {
  const missing: number[] = [];
  for (let i = 0; i < totalPackets; i += 1) if (!packets.has(i)) missing.push(i);
  return missing;
}

async function finalizeTransfer(): Promise<void> {
  if (!transferState.totalPackets || transferState.fileHash === null) return;
  setStage('VERIFYING', 'Checking integrity...');

  const ordered: Uint8Array[] = [];
  for (let i = 0; i < transferState.totalPackets; i += 1) {
    const payload = transferState.receivedPackets.get(i);
    if (!payload) {
      logger.debug('[receiver] missed packet ids', missingPacketIds(transferState.totalPackets, transferState.receivedPackets));
      setStage('ERROR', 'Transfer Failed (Missing Packets)');
      warningEl.textContent = 'Transmission started before scan. Please restart sender.';
      resetTransferState(false);
      return;
    }
    ordered.push(payload);
  }

  const fileBytes = concatPayloads(ordered);
  const computedHash = calculateCRC32(fileBytes);
  if (computedHash !== transferState.fileHash) {
    logger.debug('[receiver] missed packet ids', missingPacketIds(transferState.totalPackets, transferState.receivedPackets));
    setStage('ERROR', 'Transfer Failed (Hash Mismatch)');
    warningEl.textContent = 'File Corrupted. Try slowing down transmission.';
    lastPacketEl.textContent = `Expected CRC32 ${transferState.fileHash.toString(16)} got ${computedHash.toString(16)}`;
    resetTransferState(false);
    return;
  }

  revokeDownloadUrl();
  const blobData = new Uint8Array(fileBytes.length);
  blobData.set(fileBytes);
  downloadUrl = URL.createObjectURL(new Blob([blobData.buffer], { type: 'application/octet-stream' }));
  downloadButton.disabled = false;
  downloadButton.onclick = () => {
    if (!downloadUrl) return;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = transferState.fileName || 'received.bin';
    a.click();
  };
  setStage('SUCCESS', 'File Ready! (Download)');
  warningEl.textContent = '';
  lastPacketEl.textContent = `${transferState.fileName} • ${fileBytes.length} bytes`;
  if (soundEnabled) playDing();
}

function stopScanLoop(stopCamera = false): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (monitorInterval !== null) {
    window.clearInterval(monitorInterval);
    monitorInterval = null;
  }
  if (stopCamera) {
    stopCameraStream();
    setStage('IDLE', 'Ready to scan');
    scanButton.textContent = 'Start Scan';
  }
}

function updateSignalHealth(): void {
  if (panel.dataset.state !== 'SCANNING' && panel.dataset.state !== 'RECEIVING') return;
  const now = Date.now();
  const reference = lastPacketAt > 0 ? lastPacketAt : scanStartedAt;
  if (reference > 0 && now - reference > SIGNAL_LOST_MS) {
    warningEl.textContent = 'Signal Lost - Check Alignment';
  }
}

function processFrame(now: number): void {
  if (!video.videoWidth || !video.videoHeight) {
    rafId = requestAnimationFrame(processFrame);
    return;
  }

  if (now - lastScanAt < SCAN_INTERVAL_MS) {
    rafId = requestAnimationFrame(processFrame);
    return;
  }

  lastScanAt = now;
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
  const image = frameContext.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
  const result = jsQR(image.data, image.width, image.height);

  if (result?.data && result.data.startsWith(QR_PREFIX) && result.data !== lastDecodedPayload) {
    lastDecodedPayload = result.data;
    transferState.totalScans += 1;
    try {
      const packet = parsePacket(base64ToBytes(result.data.slice(QR_PREFIX.length)));
      if (transferState.totalPackets === null) {
        transferState.totalPackets = packet.totalPackets;
        transferState.fileHash = packet.fileHash;
        transferState.fileName = packet.fileName;
        if (packet.packetIndex !== 0) warningEl.textContent = 'Transmission started before scan. Please restart sender.';
      }

      if (!transferState.receivedPackets.has(packet.packetIndex)) {
        transferState.receivedPackets.set(packet.packetIndex, packet.payload);
      }

      lastPacketAt = Date.now();
      lastReceivedTimeEl.textContent = `Last packet: ${new Date(lastPacketAt).toLocaleTimeString()}`;
      setStage('RECEIVING', 'Listening for packets...');
      updateProgress();
      lastPacketEl.textContent = `Packet ${packet.packetIndex + 1}/${packet.totalPackets} received.`;
      if (transferState.totalPackets !== null && transferState.receivedPackets.size === transferState.totalPackets) {
        void finalizeTransfer();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown packet decode error.';
      setStage('ERROR', 'Transfer Failed (Decode Error)');
      lastPacketEl.textContent = message;
      logger.error('[receiver] packet validation failed', message);
    }
  }

  rafId = requestAnimationFrame(processFrame);
}

async function startScan(): Promise<void> {
  resetTransferState();
  setStage('SCANNING', 'Initializing Camera...');

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = activeStream;
    await video.play();
    setStage('SCANNING', 'Listening for packets...');
    lastDecodedPayload = '';
    lastScanAt = 0;
    scanStartedAt = Date.now();
    scanButton.textContent = 'Stop Scan';
    rafId = requestAnimationFrame(processFrame);
    monitorInterval = window.setInterval(updateSignalHealth, 1000);
  } catch {
    setStage('ERROR', 'Camera unavailable. Please check permissions in browser settings.');
    warningEl.textContent = 'On Android Chrome, enable Camera permission for this site.';
  }
}

scanButton.addEventListener('click', async () => {
  if (activeStream) {
    stopScanLoop(true);
    return;
  }
  await startScan();
});

soundEnabledInput.addEventListener('change', () => {
  soundEnabled = soundEnabledInput.checked;
});

themeButton.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  setTheme(current === 'dark' ? 'light' : 'dark');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && activeStream) {
    warningEl.textContent = 'Do not minimize this tab during transfer.';
  }
});

window.addEventListener('beforeunload', () => {
  stopScanLoop(true);
  revokeDownloadUrl();
});

setTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');
updateProgress();
