import './style.css';
import jsQR from 'jsqr';
import { FRAME_TYPE_DATA, FRAME_TYPE_END, FRAME_TYPE_HEADER, calculateCRC32, parseFrame, type TransferHeaderFrame } from '@qr-data-bridge/protocol';

const QR_PREFIX = 'QDB64:';
const SCAN_INTERVAL_MS = 300;
const SIGNAL_LOST_MS = 5000;
const END_GRACE_MS = 2000;
const NO_UNIQUE_PROGRESS_TIMEOUT_MS = 15000;
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
  lastUniquePacketAt: number | null;
  endSeenAt: number | null;
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
    headerReceived: false,
    lastUniquePacketAt: null,
    endSeenAt: null
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
  progressText.textContent = transferState.headerReceived ? `Receiving packets: ${received}/${total} (${pct}%)` : 'Waiting for header';
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
    logger.debug('[receiver] ignoring non-matching header while locked');
    return;
  }

  transferState.headerReceived = true;
  transferState.transferId = incomingTransferId;
  transferState.fileName = header.fileName || 'received.bin';
  transferState.expectedFileSize = header.fileSize;
  transferState.totalPackets = header.totalPackets;
  transferState.fileCrc32 = header.fileCrc32;
  setStage('RECEIVING', 'Receiving packets');
  lastPacketEl.textContent = `${transferState.fileName} • ${header.fileSize} bytes • ${header.totalPackets} packets`;
}

async function finalizeTransfer(): Promise<void> {
  if (transferState.totalPackets === null || transferState.fileCrc32 === null) return;
  setStage('VERIFYING', 'Verifying...');

  const ordered: Uint8Array[] = [];
  for (let i = 0; i < transferState.totalPackets; i += 1) {
    const payload = transferState.receivedPackets.get(i);
    if (!payload) {
      failTransfer('Transfer incomplete, restart sender', 'Missing packets detected during verification. Please restart sender.');
      return;
    }
    ordered.push(payload);
  }

  const fileBytes = concatPayloads(ordered);
  const computedCrc = calculateCRC32(fileBytes);
  if (computedCrc !== transferState.fileCrc32) {
    failTransfer('Decode error', 'File CRC32 mismatch detected. Retry transfer with slower frame rate.');
    lastPacketEl.textContent = `Expected CRC32 ${transferState.fileCrc32.toString(16)} got ${computedCrc.toString(16)}`;
    return;
  }

  if (transferState.expectedFileSize !== null && fileBytes.length !== transferState.expectedFileSize) {
    failTransfer('Transfer incomplete, restart sender', 'File size mismatch detected during verification. Please retry transfer.');
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


function failTransfer(message: string, warning: string): void {
  setStage('ERROR', message);
  warningEl.textContent = warning;
  stopScanLoop(true, false);
  scanButton.textContent = 'Restart Scan';
}

function stopScanLoop(stopCamera = false, resetToIdle = true): void {
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
    if (resetToIdle) {
      setStage('IDLE', 'Ready to scan');
    }
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

  if (transferState.headerReceived && transferState.lastUniquePacketAt && now - transferState.lastUniquePacketAt > NO_UNIQUE_PROGRESS_TIMEOUT_MS) {
    failTransfer('Transfer incomplete, restart sender', 'No new unique packets for 15 seconds.');
    return;
  }

  if (transferState.endSeenAt && transferState.totalPackets !== null && transferState.receivedPackets.size < transferState.totalPackets && now - transferState.endSeenAt > END_GRACE_MS) {
    failTransfer('Transfer incomplete, restart sender', 'END frame seen before all packets were received.');
  }
}


function maybeFinalizeTransfer(): void {
  if (panel.dataset.state === 'VERIFYING' || panel.dataset.state === 'SUCCESS' || panel.dataset.state === 'ERROR') return;
  if (transferState.totalPackets === null) return;
  const hasAllPackets = transferState.receivedPackets.size === transferState.totalPackets;
  if (!hasAllPackets) return;

  if (transferState.totalPackets === 0 && transferState.endSeenAt === null) {
    return;
  }

  void finalizeTransfer();
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
        if (!transferState.headerReceived || transferState.totalPackets === null || transferState.transferId === null) {
          warningEl.textContent = 'Waiting for header';
          updateProgress();
          rafId = requestAnimationFrame(processFrame);
          return;
        }

        if (transferIdToKey(frame.transferId) !== transferState.transferId) {
          logger.debug('[receiver] ignoring non-matching transfer data frame');
          rafId = requestAnimationFrame(processFrame);
          return;
        }

        if (frame.packetIndex < 0 || frame.packetIndex >= transferState.totalPackets) {
          logger.debug('[receiver] ignoring out-of-range packet index', frame.packetIndex);
          rafId = requestAnimationFrame(processFrame);
          return;
        }

        if (!transferState.receivedPackets.has(frame.packetIndex)) {
          transferState.receivedPackets.set(frame.packetIndex, frame.payload);
          transferState.lastUniquePacketAt = Date.now();
        }

        setStage('RECEIVING', 'Receiving packets');
        lastPacketEl.textContent = `Receiving packets: ${transferState.receivedPackets.size}/${transferState.totalPackets}`;
      } else if (frame.frameType === FRAME_TYPE_END) {
        if (transferState.transferId && transferIdToKey(frame.transferId) === transferState.transferId) {
          transferState.endSeenAt = Date.now();
          logger.debug('[receiver] end frame observed for active transfer');
          maybeFinalizeTransfer();
        }
      }

      lastPacketAt = Date.now();
      lastReceivedTimeEl.textContent = `Last packet: ${new Date(lastPacketAt).toLocaleTimeString()}`;
      updateProgress();
      maybeFinalizeTransfer();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown packet decode error.';
      logger.error('[receiver] packet validation failed', message);
      if (panel.dataset.state === 'SCANNING' || panel.dataset.state === 'RECEIVING') {
        warningEl.textContent = `Decode error: ${message}`;
      } else {
        failTransfer('Decode error', message);
      }
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
    setStage('SCANNING', 'Waiting for header');
    lastDecodedPayload = '';
    lastScanAt = 0;
    scanStartedAt = Date.now();
    scanButton.textContent = 'Stop Scan';
    rafId = requestAnimationFrame(processFrame);
    monitorInterval = window.setInterval(updateSignalHealth, 1000);
  } catch {
    setStage('ERROR', 'Camera error');
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
