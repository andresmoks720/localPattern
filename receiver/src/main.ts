import './style.css';
import jsQR from 'jsqr';
import { FRAME_TYPE_DATA, FRAME_TYPE_END, FRAME_TYPE_HEADER, calculateCRC32, parseFrame, type TransferHeaderFrame } from '@qr-data-bridge/protocol';

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

let sharedAudioContext: AudioContext | null = null;

type ReceiverStage = 'IDLE' | 'SCANNING' | 'RECEIVING' | 'VERIFYING' | 'SUCCESS' | 'ERROR';

interface TransferState {
  transferId: string | null;
  totalPackets: number | null;
  expectedFileSize: number | null;
  receivedPackets: Map<number, Uint8Array>;
  fileCrc32: number | null;
  fileName: string;
  totalScans: number;
  headerReceived: boolean;
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
  return {
    transferId: null,
    totalPackets: null,
    expectedFileSize: null,
    receivedPackets: new Map<number, Uint8Array>(),
    fileCrc32: null,
    fileName: '',
    totalScans: 0,
    headerReceived: false
  };
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

function transferIdToKey(transferId: Uint8Array): string {
  return Array.from(transferId)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function getAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContext();
  }
  return sharedAudioContext;
}

async function resumeAudioContext(): Promise<void> {
  if (!soundEnabled) return;
  const context = getAudioContext();
  if (context.state === 'suspended') {
    await context.resume();
  }
}

function playDing(): void {
  if (!soundEnabled) return;
  const context = getAudioContext();
  if (context.state !== 'running') return;
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
    <div id="progress-text">Waiting for header...</div>
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
  const pct = transferState.headerReceived && total > 0 ? Math.floor((received / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressText.textContent = transferState.headerReceived ? `Packet ${received}/${total} (${pct}%)` : 'Waiting for header...';
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

function applyHeaderFrame(header: TransferHeaderFrame): void {
  const incomingTransferId = transferIdToKey(header.transferId);
  if (transferState.headerReceived && transferState.transferId && transferState.transferId !== incomingTransferId) {
    warningEl.textContent = 'Sender restarted. Session reset automatically.';
    transferState = createTransferState();
  }

  transferState.headerReceived = true;
  transferState.transferId = incomingTransferId;
  transferState.fileName = header.fileName || 'received.bin';
  transferState.expectedFileSize = header.fileSize;
  transferState.totalPackets = header.totalPackets;
  transferState.fileCrc32 = header.fileCrc32;
  setStage('RECEIVING', 'Header received. Listening for packets...');
  lastPacketEl.textContent = `${transferState.fileName} • ${header.fileSize} bytes • ${header.totalPackets} packets`;
}

async function finalizeTransfer(): Promise<void> {
  if (!transferState.totalPackets || transferState.fileCrc32 === null) return;
  setStage('VERIFYING', 'Verifying...');

  const ordered: Uint8Array[] = [];
  for (let i = 0; i < transferState.totalPackets; i += 1) {
    const payload = transferState.receivedPackets.get(i);
    if (!payload) {
      setStage('ERROR', 'Transfer Failed (Missing Packets)');
      warningEl.textContent = 'Missing packets detected. Please restart sender.';
      resetTransferState(false);
      return;
    }
    ordered.push(payload);
  }

  const fileBytes = concatPayloads(ordered);
  const computedCrc = calculateCRC32(fileBytes);
  if (computedCrc !== transferState.fileCrc32) {
    setStage('ERROR', 'Transfer Failed (CRC32 Mismatch)');
    warningEl.textContent = 'File Corrupted. Retry transfer with slower frame rate.';
    lastPacketEl.textContent = `Expected CRC32 ${transferState.fileCrc32.toString(16)} got ${computedCrc.toString(16)}`;
    resetTransferState(false);
    return;
  }

  if (transferState.expectedFileSize !== null && fileBytes.length !== transferState.expectedFileSize) {
    setStage('ERROR', 'Transfer Failed (Size Mismatch)');
    warningEl.textContent = 'File size mismatch detected. Please retry transfer.';
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
      const frame = parseFrame(base64ToBytes(result.data.slice(QR_PREFIX.length)));
      if (frame.frameType === FRAME_TYPE_HEADER) {
        applyHeaderFrame(frame);
      } else if (frame.frameType === FRAME_TYPE_DATA) {
        if (!transferState.headerReceived || transferState.totalPackets === null) {
          warningEl.textContent = 'Waiting for header frame. Restart sender if needed.';
          updateProgress();
          rafId = requestAnimationFrame(processFrame);
          return;
        }
        if (frame.packetIndex < transferState.totalPackets && !transferState.receivedPackets.has(frame.packetIndex)) {
          transferState.receivedPackets.set(frame.packetIndex, frame.payload);
        }

        setStage('RECEIVING', 'Listening for packets...');
        lastPacketEl.textContent = `Packet ${frame.packetIndex + 1}/${transferState.totalPackets} received.`;
      } else if (frame.frameType === FRAME_TYPE_END) {
        logger.debug('[receiver] end frame observed', frame.transferId);
      }

      lastPacketAt = Date.now();
      lastReceivedTimeEl.textContent = `Last packet: ${new Date(lastPacketAt).toLocaleTimeString()}`;
      updateProgress();
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
    setStage('SCANNING', 'Listening for header frame...');
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
  await resumeAudioContext();
  if (activeStream) {
    stopScanLoop(true);
    return;
  }
  await startScan();
});

soundEnabledInput.addEventListener('change', () => {
  soundEnabled = soundEnabledInput.checked;
  void resumeAudioContext();
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
