import './style.css';
import jsQR from 'jsqr';
import {
  ReceiverMachine,
  RECEIVER_ERROR_CODES,
  type ReceiverSnapshot
} from '@qr-data-bridge/protocol';
import { ReceiverIngestService } from './ingestService';

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


function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
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
    <label class="inline-check">Camera: <select id="camera-select"><option value="">Auto (rear)</option></select></label>
    <label class="inline-check"><input id="sound-enabled" type="checkbox"/> Completion sound</label>
    <div id="status" class="status">Ready to scan</div>
    <div class="progress-wrap"><div id="progress-bar" class="progress-bar"></div></div>
    <div id="progress-text">Waiting for header</div>
    <div id="scan-stats">Received 0 scans → 0 unique packets</div>
    <div id="last-received-time">Last packet: -</div>
    <div id="warning" class="warning"></div>
    <button id="download-btn" type="button" disabled>Download File</button>
    <div class="hint">Tap Start Scan (required on iOS). Keep QR fully visible, hold both devices steady, move closer if scans fail, use fullscreen, and remember larger files are slower.</div>
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
const cameraSelect = getElement<HTMLSelectElement>('#camera-select');

const frameCanvas = document.createElement('canvas');
const frameContextCandidate = frameCanvas.getContext('2d', { willReadFrequently: true });
if (!frameContextCandidate) throw new Error('Failed to initialize frame canvas context.');
const frameContext = frameContextCandidate;

let rafId = 0;
let monitorInterval: number | null = null;
let activeStream: MediaStream | null = null;
let lastScanAt = 0;
let scanStartedAt = 0;
let lastPacketAt = 0;
let downloadUrl: string | null = null;
let soundEnabled = false;
let successSoundPlayed = false;
let ingestDecodeError: string | null = null;
let selectedCameraId = '';

const receiverMachine = new ReceiverMachine();
const receiverIngest = new ReceiverIngestService({
  machine: receiverMachine,
  onEvent: (event) => {
    if (event.type === 'decodeError') {
      ingestDecodeError = event.message;
      logger.error('[receiver] packet validation failed', event.message);
    }
  }
});

function setTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
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
    scanButton.textContent = 'Start Scan';
  }
}

function updateProgress(snapshot: ReceiverSnapshot): void {
  const total = snapshot.totalPackets ?? 0;
  const received = snapshot.receivedCount;
  const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;

  if (snapshot.state === 'IDLE' || snapshot.state === 'SCANNING') {
    progressText.textContent = 'Waiting for header';
  } else if (snapshot.state === 'VERIFYING') {
    progressText.textContent = 'Verifying';
  } else if (snapshot.state === 'SUCCESS') {
    progressText.textContent = `File ready: ${received}/${total}`;
  } else if (snapshot.state === 'ERROR') {
    progressText.textContent = `Transfer incomplete: ${received}/${total}`;
  } else {
    progressText.textContent = `Receiving packets: ${received}/${total} (${pct}%)`;
  }

  const diagnostics = receiverIngest.getDiagnostics();
  scanStatsEl.textContent = `Received ${snapshot.totalScans} scans → ${received} unique packets • dup:${diagnostics.duplicateScannerPayloads} foreign:${diagnostics.foreignTransferFrames} badCrc:${diagnostics.badPacketCrcFrames} malformed:${diagnostics.malformedPayloads}`;
}

function setStage(state: ReceiverSnapshot['state'], label: string): void {
  panel.dataset.state = state;
  statusEl.textContent = label;
}

function applyDownload(snapshot: ReceiverSnapshot): void {
  if (!snapshot.fileBytes || downloadUrl) return;
  const blobData = new Uint8Array(snapshot.fileBytes.length);
  blobData.set(snapshot.fileBytes);
  downloadUrl = URL.createObjectURL(new Blob([blobData.buffer], { type: 'application/octet-stream' }));
  downloadButton.disabled = false;
  downloadButton.onclick = () => {
    if (!downloadUrl) return;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = snapshot.fileName || 'received.bin';
    a.click();
  };
}

function applySnapshot(snapshot: ReceiverSnapshot): void {
  updateProgress(snapshot);

  if (snapshot.state === 'IDLE') {
    setStage('IDLE', 'Ready to scan');
    return;
  }

  if (snapshot.state === 'SCANNING') {
    setStage('SCANNING', 'Waiting for header');
    if (!warningEl.textContent.startsWith('Signal Lost')) {
      warningEl.textContent = '';
    }
    return;
  }

  if (snapshot.state === 'RECEIVING') {
    setStage('RECEIVING', 'Receiving packets');
    if (snapshot.fileName && snapshot.totalPackets !== null && snapshot.expectedFileSize !== null) {
      lastPacketEl.textContent = `${snapshot.fileName} • ${snapshot.expectedFileSize} bytes • ${snapshot.totalPackets} packets`;
    }
    return;
  }

  if (snapshot.state === 'VERIFYING') {
    setStage('VERIFYING', 'Verifying');
    return;
  }

  if (snapshot.state === 'SUCCESS') {
    setStage('SUCCESS', 'File ready');
    warningEl.textContent = '';
    applyDownload(snapshot);
    if (!successSoundPlayed) {
      successSoundPlayed = true;
      playDing();
    }
    if (snapshot.fileName && snapshot.fileBytes) {
      lastPacketEl.textContent = `${snapshot.fileName} • ${snapshot.fileBytes.length} bytes`;
    }
    return;
  }

  const code = snapshot.error?.code;
  setStage('ERROR', code === RECEIVER_ERROR_CODES.FILE_CRC_MISMATCH ? 'Decode error' : 'Transfer incomplete, restart sender');
  if (code === RECEIVER_ERROR_CODES.FILE_CRC_MISMATCH) {
    warningEl.textContent = 'Corruption error: file CRC32 mismatch detected. Retry with slower frame rate.';
  } else if (code === RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT || code === RECEIVER_ERROR_CODES.END_INCOMPLETE) {
    warningEl.textContent = 'Transfer incomplete, restart sender.';
  } else {
    warningEl.textContent = snapshot.error?.message ?? 'Transfer incomplete, restart sender.';
  }
  stopScanLoop(true);
  scanButton.textContent = 'Restart Scan';
}

function resetUiForNewScan(): void {
  receiverMachine.startScanning();
  receiverIngest.reset();
  revokeDownloadUrl();
  downloadButton.disabled = true;
  warningEl.textContent = '';
  ingestDecodeError = null;
  successSoundPlayed = false;
  lastPacketEl.textContent = '';
  lastPacketAt = 0;
  lastReceivedTimeEl.textContent = 'Last packet: -';
  applySnapshot(receiverMachine.snapshot);
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

  if (result?.binaryData?.length) {
    void receiverIngest.enqueue(Uint8Array.from(result.binaryData), Date.now()).then((snapshot) => {
      if (snapshot) {
        applySnapshot(snapshot);
        lastPacketAt = Date.now();
        lastReceivedTimeEl.textContent = `Last packet: ${new Date(lastPacketAt).toLocaleTimeString()}`;
      } else if (ingestDecodeError) {
        warningEl.textContent = `Decode error: ${ingestDecodeError}`;
      }
    });
  }

  rafId = requestAnimationFrame(processFrame);
}

function updateSignalHealth(): void {
  const snapshot = receiverMachine.tick(Date.now());
  applySnapshot(snapshot);

  if (snapshot.state !== 'SCANNING' && snapshot.state !== 'RECEIVING') return;

  const now = Date.now();
  const reference = lastPacketAt > 0 ? lastPacketAt : scanStartedAt;
  if (reference > 0 && now - reference > SIGNAL_LOST_MS) {
    warningEl.textContent = 'Signal Lost - Check Alignment';
  }
}


async function populateCameraOptions(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === 'videoinput');
    cameraSelect.innerHTML = '<option value="">Auto (rear)</option>' + cameras.map((camera, index) => (
      `<option value="${camera.deviceId}">${camera.label || `Camera ${index + 1}`}</option>`
    )).join('');
  } catch (error) {
    logger.error('Failed to enumerate cameras', error);
  }
}

function waitForVideoReady(timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      resolve();
      return;
    }
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('canplay', onReady);
      window.clearTimeout(timer);
    };
    video.addEventListener('loadedmetadata', onReady, { once: true });
    video.addEventListener('canplay', onReady, { once: true });
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
  });
}

async function startScan(): Promise<void> {
  resetUiForNewScan();
  setStage('SCANNING', 'Initializing Camera...');

  try {
    const preferredConstraints: MediaStreamConstraints = selectedCameraId
      ? { video: { deviceId: { exact: selectedCameraId } }, audio: false }
      : { video: { facingMode: 'environment' }, audio: false };

    try {
      activeStream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
    } catch (preferredError) {
      logger.error('Preferred camera request failed, falling back', preferredError);
      warningEl.textContent = 'Preferred camera unavailable; using fallback camera.';
      activeStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    video.srcObject = activeStream;
    await waitForVideoReady();
    await video.play();
    await populateCameraOptions();
    setStage('SCANNING', 'Waiting for header');
    lastScanAt = 0;
    scanStartedAt = Date.now();
    scanButton.textContent = 'Stop Scan';
    rafId = requestAnimationFrame(processFrame);
    monitorInterval = window.setInterval(updateSignalHealth, 1000);
  } catch {
    setStage('ERROR', 'Camera error');
    warningEl.textContent = 'Camera error: enable camera permission for this site and retry.';
    scanButton.textContent = 'Restart Scan';
  }
}

scanButton.addEventListener('click', async () => {
  await resumeAudioContext();
  if (activeStream) {
    stopScanLoop(true);
    receiverMachine.reset();
    applySnapshot(receiverMachine.snapshot);
    return;
  }
  await startScan();
});

soundEnabledInput.addEventListener('change', () => {
  soundEnabled = soundEnabledInput.checked;
  void resumeAudioContext();
});

cameraSelect.addEventListener('change', () => {
  selectedCameraId = cameraSelect.value;
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
receiverMachine.reset();
applySnapshot(receiverMachine.snapshot);
void populateCameraOptions();
