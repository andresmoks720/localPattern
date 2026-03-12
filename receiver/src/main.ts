import './style.css';
import jsQR from 'jsqr';
import {
  ReceiverMachine,
  FRAME_TYPE_DATA,
  FRAME_TYPE_END,
  FRAME_TYPE_HEADER,
  MAGIC_BYTES,
  RECEIVER_ERROR_CODES,
  RECEIVER_LOCK_CONFIRMATION,
  RECEIVER_TIMEOUTS,
  parseFrame,
  type ReceiverSnapshot
} from '@qr-data-bridge/protocol';
import { ReceiverIngestService } from './ingestService';

const SCAN_INTERVAL_MS = 300;
const SIGNAL_LOST_MS = 5000;
const ARMING_WINDOW_MS = 2000;
const MIN_QR_AREA_RATIO = 0.015;
const MAX_AREA_DRIFT_RATIO = 0.4;
const MAX_ASPECT_DRIFT_RATIO = 0.25;
const MAX_CENTER_DRIFT_RATIO = 0.12;
const STABLE_SCANS_REQUIRED = 2;
const THEME_KEY = 'qdb_theme';
const DEBUG_EVENT_LOG_CAP = 100;

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
    <div id="lock-status">Searching for start frame...</div>
    <div class="progress-wrap"><div id="progress-bar" class="progress-bar"></div></div>
    <div id="progress-text">Waiting for header</div>
    <div id="scan-stats">Received 0 scans → 0 unique packets</div>
    <div id="diagnostic-hint">Diagnostics: waiting for scan data.</div>
    <div id="progress-health">Progress health: waiting for first frame…</div>
    <div id="last-received-time">Last packet: -</div>
    <label class="inline-check"><input id="debug-log-enabled" type="checkbox"/> Debug event log</label>
    <details id="debug-log-panel" class="debug-log" hidden>
      <summary>Receiver event timeline</summary>
      <pre id="debug-log-output">No events yet.</pre>
    </details>
    <div id="warning" class="warning"></div>
    <button id="download-btn" type="button" disabled>Download File</button>
    <div class="hint">Tap Start Scan (required on iOS). Keep QR fully visible, hold both devices steady, move closer if scans fail, use fullscreen, and remember larger files are slower.</div>
    <div id="last-packet"></div>
  </aside>
</main>`;

const scanButton = getElement<HTMLButtonElement>('#scan-btn');
const statusEl = getElement<HTMLDivElement>('#status');
const lockStatusEl = getElement<HTMLDivElement>('#lock-status');
const video = getElement<HTMLVideoElement>('#camera-preview');
const progressBar = getElement<HTMLDivElement>('#progress-bar');
const progressText = getElement<HTMLDivElement>('#progress-text');
const scanStatsEl = getElement<HTMLDivElement>('#scan-stats');
const diagnosticHintEl = getElement<HTMLDivElement>('#diagnostic-hint');
const progressHealthEl = getElement<HTMLDivElement>('#progress-health');
const warningEl = getElement<HTMLDivElement>('#warning');
const panel = getElement<HTMLDivElement>('#receiver-panel');
const lastPacketEl = getElement<HTMLDivElement>('#last-packet');
const downloadButton = getElement<HTMLButtonElement>('#download-btn');
const lastReceivedTimeEl = getElement<HTMLDivElement>('#last-received-time');
const themeButton = getElement<HTMLButtonElement>('#theme-btn');
const soundEnabledInput = getElement<HTMLInputElement>('#sound-enabled');
const cameraSelect = getElement<HTMLSelectElement>('#camera-select');
const debugLogEnabledInput = getElement<HTMLInputElement>('#debug-log-enabled');
const debugLogPanel = getElement<HTMLDetailsElement>('#debug-log-panel');
const debugLogOutput = getElement<HTMLPreElement>('#debug-log-output');

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
let armingWindowEndsAt = 0;
let stableGeometryCount = 0;
let lastGeometry: { areaRatio: number; aspectRatio: number; centerX: number; centerY: number } | null = null;
let debugLogEnabled = false;
const debugEventLines: string[] = [];

function shortTransferId(transferId: string | null): string {
  if (!transferId) return 'unknown';
  return transferId.length <= 8 ? transferId : `${transferId.slice(0, 8)}…`;
}

function appendDebugEvent(message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  debugEventLines.push(`[${timestamp}] ${message}`);
  if (debugEventLines.length > DEBUG_EVENT_LOG_CAP) {
    debugEventLines.splice(0, debugEventLines.length - DEBUG_EVENT_LOG_CAP);
  }
  if (debugLogEnabled) {
    debugLogOutput.textContent = debugEventLines.join('\n');
  }
}

const receiverMachine = new ReceiverMachine();
const receiverIngest = new ReceiverIngestService({
  machine: receiverMachine,
  onEvent: (event) => {
    if (event.type === 'decodeError') {
      ingestDecodeError = event.message;
      logger.error('[receiver] packet validation failed', event.message);
      appendDebugEvent(`Decode error: ${event.message}`);
      return;
    }

    if (event.type === 'frameAccepted') {
      if (event.frame.frameType === FRAME_TYPE_HEADER) {
        appendDebugEvent(`Frame accepted: HEADER ${shortTransferId(event.snapshot.transferId)}`);
      } else if (event.frame.frameType === FRAME_TYPE_DATA) {
        appendDebugEvent(`Frame accepted: DATA packet ${event.frame.packetIndex}`);
      } else if (event.frame.frameType === FRAME_TYPE_END) {
        appendDebugEvent('Frame accepted: END');
      }
      return;
    }

    if (event.type === 'duplicateScannerPayload') {
      appendDebugEvent('Duplicate scanner payload dropped');
      return;
    }

    if (event.type === 'foreignFrameIgnored') {
      appendDebugEvent('Foreign transfer frame ignored');
      return;
    }

    if (event.type === 'badPacketCrcIgnored') {
      appendDebugEvent('Packet CRC mismatch ignored');
      return;
    }

    if (event.type === 'completed') {
      appendDebugEvent(`Transfer completed in ${event.durationMs}ms`);
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

  if (diagnostics.foreignTransferFrames > 0) {
    diagnosticHintEl.textContent = 'Hint: multiple senders/QR streams detected. Keep only one sender QR visible.';
  } else if (diagnostics.badPacketCrcFrames > 0) {
    diagnosticHintEl.textContent = 'Hint: unstable captures (motion blur or glare) are causing packet CRC failures.';
  } else if (diagnostics.nonProtocolPayloads > 0 || diagnostics.malformedPayloads > 0) {
    diagnosticHintEl.textContent = 'Hint: camera decode noise or wrong QR in view. Improve lighting/framing.';
  } else if (diagnostics.duplicateScannerPayloads > 0 && diagnostics.acceptedFrames <= 2) {
    diagnosticHintEl.textContent = 'Hint: scanner is re-reading the same frame. Re-align and hold both devices steady.';
  } else {
    diagnosticHintEl.textContent = 'Diagnostics: signal looks healthy.';
  }
}

function isProtocolPayload(rawPayload: Uint8Array): boolean {
  return rawPayload.length > 5 && MAGIC_BYTES.every((byte, index) => rawPayload[index] === byte);
}

function polygonArea(points: Array<{ x: number; y: number }>): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length];
    sum += points[i].x * next.y;
    sum -= next.x * points[i].y;
  }
  return Math.abs(sum / 2);
}

function hasStableQrGeometry(result: NonNullable<ReturnType<typeof jsQR>>, width: number, height: number): boolean {
  const points = [
    result.location.topLeftCorner,
    result.location.topRightCorner,
    result.location.bottomRightCorner,
    result.location.bottomLeftCorner
  ];
  const qrArea = polygonArea(points);
  const frameArea = width * height;
  const areaRatio = frameArea > 0 ? qrArea / frameArea : 0;
  if (areaRatio < MIN_QR_AREA_RATIO) {
    stableGeometryCount = 0;
    lastGeometry = null;
    return false;
  }

  const topWidth = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
  const bottomWidth = Math.hypot(points[2].x - points[3].x, points[2].y - points[3].y);
  const leftHeight = Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y);
  const rightHeight = Math.hypot(points[2].x - points[1].x, points[2].y - points[1].y);
  const avgWidth = (topWidth + bottomWidth) / 2;
  const avgHeight = (leftHeight + rightHeight) / 2;
  const aspectRatio = avgHeight > 0 ? avgWidth / avgHeight : 0;
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length / width;
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length / height;

  const currentGeometry = { areaRatio, aspectRatio, centerX, centerY };
  if (!lastGeometry) {
    lastGeometry = currentGeometry;
    stableGeometryCount = 1;
    return false;
  }

  const areaDeltaRatio = Math.abs(currentGeometry.areaRatio - lastGeometry.areaRatio) / lastGeometry.areaRatio;
  const aspectDelta = Math.abs(currentGeometry.aspectRatio - lastGeometry.aspectRatio);
  const centerDelta = Math.hypot(currentGeometry.centerX - lastGeometry.centerX, currentGeometry.centerY - lastGeometry.centerY);

  if (areaDeltaRatio <= MAX_AREA_DRIFT_RATIO && aspectDelta <= MAX_ASPECT_DRIFT_RATIO && centerDelta <= MAX_CENTER_DRIFT_RATIO) {
    stableGeometryCount += 1;
  } else {
    stableGeometryCount = 1;
  }

  lastGeometry = currentGeometry;
  return stableGeometryCount >= STABLE_SCANS_REQUIRED;
}

function setStage(state: ReceiverSnapshot['state'], label: string): void {
  panel.dataset.state = state;
  statusEl.textContent = label;
}

function applyDownload(snapshot: ReceiverSnapshot): void {
  if (!snapshot.fileBytes || downloadUrl) return;
  downloadUrl = URL.createObjectURL(new Blob([snapshot.fileBytes.buffer as ArrayBuffer], { type: 'application/octet-stream' }));
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
  const transferDetails = snapshot.fileName && snapshot.totalPackets !== null && snapshot.expectedFileSize !== null
    ? `${snapshot.fileName} • ${snapshot.expectedFileSize} bytes • ${snapshot.totalPackets} packets`
    : '';

  if (snapshot.state === 'IDLE') {
    setStage('IDLE', 'Ready to scan');
    lockStatusEl.textContent = 'Searching for start frame...';
    lastPacketEl.textContent = '';
    return;
  }

  if (snapshot.state === 'SCANNING') {
    setStage('SCANNING', 'Searching for start frame...');
    lockStatusEl.textContent = snapshot.transferId
      ? `Locked to transfer ${shortTransferId(snapshot.transferId)}${transferDetails ? ` • ${transferDetails}` : ''}`
      : snapshot.headerConfirmations > 0
        ? `Searching for start frame (${snapshot.headerConfirmations}/${RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS} confirmations)`
        : 'Searching for start frame...';
    lastPacketEl.textContent = transferDetails;
    if (!warningEl.textContent.startsWith('Signal Lost')) {
      warningEl.textContent = '';
    }
    return;
  }

  if (snapshot.state === 'RECEIVING') {
    setStage('RECEIVING', 'Receiving packets');
    lockStatusEl.textContent = `Locked to transfer ${shortTransferId(snapshot.transferId)}${transferDetails ? ` • ${transferDetails}` : ''}`;
    lastPacketEl.textContent = transferDetails;
    return;
  }

  if (snapshot.state === 'VERIFYING') {
    setStage('VERIFYING', 'Verifying');
    lockStatusEl.textContent = `Locked to transfer ${shortTransferId(snapshot.transferId)}${transferDetails ? ` • ${transferDetails}` : ''}`;
    lastPacketEl.textContent = transferDetails;
    return;
  }

  if (snapshot.state === 'SUCCESS') {
    setStage('SUCCESS', 'File ready');
    lockStatusEl.textContent = `Locked to transfer ${shortTransferId(snapshot.transferId)}${transferDetails ? ` • ${transferDetails}` : ''}`;
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
  lockStatusEl.textContent = snapshot.transferId
    ? `Locked to transfer ${shortTransferId(snapshot.transferId)}${transferDetails ? ` • ${transferDetails}` : ''}`
    : 'Searching for start frame...';
  setStage('ERROR', 'Transfer error');
  if (code === RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT) {
    warningEl.textContent = 'No progress timeout: reduce sender chunk size, increase QR size, hold devices steady, and restart sender.';
  } else if (code === RECEIVER_ERROR_CODES.END_INCOMPLETE) {
    warningEl.textContent = 'Transfer ended early: receiver saw END before all packets. Restart sender with higher redundancy.';
  } else if (code === RECEIVER_ERROR_CODES.HEADER_CONFLICT) {
    warningEl.textContent = 'Header conflict: another transfer stream was detected. Keep only one sender QR visible and retry.';
  } else if (code === RECEIVER_ERROR_CODES.FILE_CRC_MISMATCH) {
    warningEl.textContent = 'Corruption detected (CRC mismatch), often caused by motion blur or glare. Retry with steadier framing/slower settings.';
  } else if (code === RECEIVER_ERROR_CODES.FILE_SIZE_MISMATCH || code === RECEIVER_ERROR_CODES.MISSING_PACKET) {
    warningEl.textContent = 'Packet loss detected (missing/size mismatch). Retry with slower pace and higher redundancy settings.';
  } else {
    warningEl.textContent = snapshot.error?.message ?? 'Transfer failed. Restart sender and retry.';
  }
  appendDebugEvent(`Transfer failed: ${code ?? 'UNKNOWN'}${snapshot.error?.message ? ` (${snapshot.error.message})` : ''}`);
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
  armingWindowEndsAt = Date.now() + ARMING_WINDOW_MS;
  stableGeometryCount = 0;
  lastGeometry = null;
  lockStatusEl.textContent = 'Searching for start frame...';
  progressHealthEl.textContent = 'Progress health: waiting for first frame…';
  diagnosticHintEl.textContent = 'Diagnostics: waiting for scan data.';
  debugEventLines.length = 0;
  debugLogOutput.textContent = 'No events yet.';
  appendDebugEvent('Scan started');
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

  if (result?.binaryData?.length && hasStableQrGeometry(result, image.width, image.height)) {
    const nowMs = Date.now();
    const rawPayload = Uint8Array.from(result.binaryData);
    if (!isProtocolPayload(rawPayload)) {
      rafId = requestAnimationFrame(processFrame);
      return;
    }

    let parsedFrame: ReturnType<typeof parseFrame>;
    try {
      parsedFrame = parseFrame(rawPayload);
    } catch {
      rafId = requestAnimationFrame(processFrame);
      return;
    }

    const inArmingWindow = nowMs < armingWindowEndsAt;
    if (inArmingWindow && (parsedFrame.frameType === FRAME_TYPE_DATA || parsedFrame.frameType === FRAME_TYPE_END)) {
      rafId = requestAnimationFrame(processFrame);
      return;
    }

    void receiverIngest.enqueue(rawPayload, nowMs).then((snapshot) => {
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
  const now = Date.now();
  const snapshot = receiverMachine.tick(now);
  applySnapshot(snapshot);

  const sinceLastUniqueSeconds = (() => {
    const reference = snapshot.lastUniquePacketAt ?? scanStartedAt;
    if (!reference) return null;
    return Math.max(0, Math.floor((now - reference) / 1000));
  })();

  let timeoutText = 'Progress timeout inactive';
  if (snapshot.transferId && snapshot.lastUniquePacketAt) {
    const remainingMs = Math.max(0, RECEIVER_TIMEOUTS.NO_UNIQUE_PROGRESS_TIMEOUT_MS - (now - snapshot.lastUniquePacketAt));
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    timeoutText = `${remainingSeconds}s until no-progress timeout`;
    if (remainingSeconds <= 5 && sinceLastUniqueSeconds !== null) {
      warningEl.textContent = `No new packets for ${sinceLastUniqueSeconds}s, timeout in ${remainingSeconds}s.`;
    }
  }

  progressHealthEl.textContent = sinceLastUniqueSeconds === null
    ? `Progress health: waiting for first frame • ${timeoutText}`
    : `Progress health: ${sinceLastUniqueSeconds}s since last unique packet • ${timeoutText}`;

  if (!snapshot.lockConfirmed) return;

  const reference = snapshot.lastUniquePacketAt ?? scanStartedAt;
  if (reference > 0 && now - reference > SIGNAL_LOST_MS) {
    warningEl.textContent = 'Signal Lost - Active transfer stalled. Check alignment and keep sender visible.';
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
    lockStatusEl.textContent = 'Searching for start frame...';
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

debugLogEnabledInput.addEventListener('change', () => {
  debugLogEnabled = debugLogEnabledInput.checked;
  debugLogPanel.hidden = !debugLogEnabled;
  if (debugLogEnabled) {
    debugLogOutput.textContent = debugEventLines.length > 0 ? debugEventLines.join('\n') : 'No events yet.';
  }
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
