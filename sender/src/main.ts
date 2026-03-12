import './style.css';
import QRCode from 'qrcode';
import { FRAME_TYPE_DATA, FRAME_TYPE_END, FRAME_TYPE_HEADER } from '@qr-data-bridge/protocol';
import {
  getTransmissionWarnings,
  createTransmissionPlan,
  encodeFrameBytesToCanvas,
  estimateTransmissionDurationMs,
  DEFAULT_DATA_FRAME_DURATION_MS,
  getFrameDisplayDurationMs,
  getDataFrameBytes,
  getStreamFrameAtIndex,
  getTotalScans,
  preflightTransmissionPlan,
  type SenderTransmissionPlan,
  readFileBytes,
  SENDER_ERROR_COPY_MAP,
  toUserFacingPreflightError,
  toUserFacingSenderError,
  validateFileBeforeTransmission
} from './senderCore';
import { SenderTransmissionService, type SenderStage } from './transmissionService';

const SETTINGS_KEY = 'qdb_sender_settings_v2';
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




interface SenderSettings {
  frameDurationMs: number;
  qrErrorCorrection: QRCode.QRCodeErrorCorrectionLevel;
  qrSizePx: number;
  chunkSizeBytes: number;
  chunkAuto: boolean;
  redundancyCount: number;
  soundEnabled: boolean;
}

const DEFAULT_SETTINGS: SenderSettings = {
  frameDurationMs: DEFAULT_DATA_FRAME_DURATION_MS,
  qrErrorCorrection: 'H',
  qrSizePx: 520,
  chunkSizeBytes: 512,
  chunkAuto: true,
  redundancyCount: 1,
  soundEnabled: false
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}


function formatDuration(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
}

function estimateAutoChunkSize(qrSizePx: number, ec: QRCode.QRCodeErrorCorrectionLevel): number {
  const ecFactor: Record<string, number> = { L: 1.2, M: 1.0, Q: 0.78, H: 0.62, low: 1.2, medium: 1.0, quartile: 0.78, high: 0.62 };
  const estimate = Math.floor((qrSizePx - 140) * (ecFactor[ec] ?? 0.62) * 2.1);
  return Math.max(128, Math.min(1024, estimate));
}

function readSettings(): SenderSettings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<SenderSettings>;
    return {
      frameDurationMs: clamp(parsed.frameDurationMs ?? DEFAULT_SETTINGS.frameDurationMs, 500, 5000),
      qrErrorCorrection: parsed.qrErrorCorrection ?? DEFAULT_SETTINGS.qrErrorCorrection,
      qrSizePx: clamp(parsed.qrSizePx ?? DEFAULT_SETTINGS.qrSizePx, 200, 1000),
      chunkSizeBytes: clamp(parsed.chunkSizeBytes ?? DEFAULT_SETTINGS.chunkSizeBytes, 128, 1024),
      chunkAuto: parsed.chunkAuto ?? true,
      redundancyCount: 1,
      soundEnabled: parsed.soundEnabled ?? false
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: SenderSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function getAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContext();
  }
  return sharedAudioContext;
}

async function resumeAudioContext(): Promise<void> {
  if (!settings.soundEnabled) return;
  const context = getAudioContext();
  if (context.state === 'suspended') {
    await context.resume();
  }
}

function playClickSound(): void {
  if (!settings.soundEnabled) return;
  const context = getAudioContext();
  if (context.state !== 'running') return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'square';
  oscillator.frequency.value = 880;
  gain.gain.value = 0.02;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.04);
}

const app = getElement<HTMLDivElement>('#app');
app.innerHTML = `
<main class="layout">
  <section class="stage" id="stage">
    <div class="qr-shell" id="qr-shell">
      <canvas id="qr-canvas" width="600" height="600" aria-label="QR packet output"></canvas>
    </div>
  </section>
  <aside class="panel">
    <div class="panel-grid">
      <div class="controls-grid">
        <div class="row">
          <button id="theme-btn" type="button">Theme</button>
          <label class="inline-check"><input id="sound-enabled" type="checkbox"/> Sound</label>
        </div>
        <input id="file-input" type="file" />
        <details>
      <summary>Settings</summary>
      <label>Frame Duration: <span id="frame-duration-label"></span>
        <input id="frame-duration" type="range" min="500" max="5000" step="100" />
      </label>
      <label>QR Error Correction
        <select id="error-correction"><option value="L">L</option><option value="M">M</option><option value="Q">Q</option><option value="H">H</option></select>
      </label>
      <label>QR Size: <span id="qr-size-label"></span>
        <input id="qr-size" type="range" min="200" max="1000" step="20" />
      </label>
      <label><input id="chunk-auto" type="checkbox" /> Auto Chunk Size</label>
      <label>Chunk Size: <span id="chunk-size-label"></span>
        <input id="chunk-size" type="range" min="128" max="1024" step="16" />
      </label>
      <label>Redundancy: <span id="redundancy-label"></span>
        <input id="redundancy" type="range" min="1" max="5" step="1" />
      </label>
    </details>
      </div>
      <div class="button-pack">
        <button id="start-btn" type="button" disabled>Start Transmission</button>
        <button id="stop-btn" type="button" disabled>Stop</button>
        <button id="clear-btn" type="button" data-persistent-control="true">Clear QR</button>
        <button id="reset-btn" type="button">Reset</button>
      </div>
    </div>
    <div id="file-meta">No file selected.</div>
    <div id="packet-meta">Packet: -</div>
    <div id="eta-meta">ETA: -</div>
    <div id="speed-meta">Estimated Speed: -</div>
    <div id="countdown-meta"></div>
    <div id="wake-lock-warning" class="warning"></div>
    <div id="warning-meta" class="warning"></div>
  </aside>
</main>`;

const fileInput = getElement<HTMLInputElement>('#file-input');
const fileMeta = getElement<HTMLDivElement>('#file-meta');
const packetMeta = getElement<HTMLDivElement>('#packet-meta');
const etaMeta = getElement<HTMLDivElement>('#eta-meta');
const speedMeta = getElement<HTMLDivElement>('#speed-meta');
const countdownMeta = getElement<HTMLDivElement>('#countdown-meta');
const warningMeta = getElement<HTMLDivElement>('#warning-meta');
const wakeLockWarningEl = getElement<HTMLDivElement>('#wake-lock-warning');
const startButton = getElement<HTMLButtonElement>('#start-btn');
const stopButton = getElement<HTMLButtonElement>('#stop-btn');
const clearButton = getElement<HTMLButtonElement>('#clear-btn');
const resetButton = getElement<HTMLButtonElement>('#reset-btn');
const qrCanvas = getElement<HTMLCanvasElement>('#qr-canvas');
const stageEl = getElement<HTMLDivElement>('#stage');
const qrShell = getElement<HTMLDivElement>('#qr-shell');
const frameDurationInput = getElement<HTMLInputElement>('#frame-duration');
const frameDurationLabel = getElement<HTMLSpanElement>('#frame-duration-label');
const errorCorrectionSelect = getElement<HTMLSelectElement>('#error-correction');
const qrSizeInput = getElement<HTMLInputElement>('#qr-size');
const qrSizeLabel = getElement<HTMLSpanElement>('#qr-size-label');
const chunkAutoInput = getElement<HTMLInputElement>('#chunk-auto');
const chunkSizeInput = getElement<HTMLInputElement>('#chunk-size');
const chunkSizeLabel = getElement<HTMLSpanElement>('#chunk-size-label');
const redundancyInput = getElement<HTMLInputElement>('#redundancy');
const redundancyLabel = getElement<HTMLSpanElement>('#redundancy-label');
const soundEnabledInput = getElement<HTMLInputElement>('#sound-enabled');
const themeButton = getElement<HTMLButtonElement>('#theme-btn');

let settings = readSettings();
let fileBytes: Uint8Array | null = null;
let selectedFileName = '';
let wakeLock: WakeLockSentinel | null = null;
let senderStage: SenderStage = 'NO_FILE';
let totalDataPackets = 0;
let transmissionPlan: SenderTransmissionPlan | null = null;


function setSenderStage(stage: SenderStage, message?: string): void {
  senderStage = stage;
  stageEl.dataset.state = stage;
  if (message) packetMeta.textContent = message;
}

function setTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function effectiveChunkSize(): number {
  return settings.chunkAuto ? estimateAutoChunkSize(settings.qrSizePx, settings.qrErrorCorrection) : settings.chunkSizeBytes;
}


function totalScans(): number {
  return getTotalScans(totalDataPackets, settings.redundancyCount);
}

function estimatedSpeedBytesPerSec(): number {
  return Math.floor((effectiveChunkSize() / settings.redundancyCount) * (1000 / settings.frameDurationMs));
}

function streamFrameLabel(frameType: number, packetIndex?: number): string {
  if (frameType === FRAME_TYPE_HEADER) return 'HEADER';
  if (frameType === FRAME_TYPE_END) return 'END';
  return `packet ${(packetIndex ?? 0) + 1}/${totalDataPackets}`;
}

function refreshEstimates(): void {
  const speed = estimatedSpeedBytesPerSec();
  speedMeta.textContent = `Estimated Speed: ${speed} B/s`;
  if (fileBytes) {
    const estimatedMs = estimateTransmissionDurationMs(totalDataPackets, settings.redundancyCount, settings.frameDurationMs);
    etaMeta.textContent = `Estimated Time: ${formatDuration(estimatedMs)}`;
    warningMeta.textContent = getTransmissionWarnings(fileBytes.length, estimatedMs).join(' ');
  } else {
    etaMeta.textContent = 'ETA: -';
    warningMeta.textContent = '';
  }
}

function updateSettingsUi(): void {
  frameDurationInput.value = String(settings.frameDurationMs);
  frameDurationInput.disabled = false;
  frameDurationLabel.textContent = `${settings.frameDurationMs}ms`;
  errorCorrectionSelect.value = settings.qrErrorCorrection;
  qrSizeInput.value = String(settings.qrSizePx);
  qrSizeLabel.textContent = `${settings.qrSizePx}px`;
  chunkAutoInput.checked = settings.chunkAuto;
  chunkSizeInput.value = String(settings.chunkSizeBytes);
  chunkSizeInput.disabled = settings.chunkAuto;
  chunkSizeLabel.textContent = settings.chunkAuto ? `${effectiveChunkSize()} bytes (auto)` : `${settings.chunkSizeBytes} bytes`;
  settings.redundancyCount = 1;
  redundancyInput.value = '1';
  redundancyInput.disabled = true;
  redundancyLabel.textContent = '1x (fixed MVPv2)';
  soundEnabledInput.checked = settings.soundEnabled;
  qrShell.style.setProperty('--qr-size', `${settings.qrSizePx}px`);
}

function rebuildPlan(): void {
  if (!fileBytes) return;
  const nextPlan = createTransmissionPlan(fileBytes, selectedFileName, effectiveChunkSize());
  transmissionPlan = nextPlan;
  totalDataPackets = nextPlan.totalDataPackets;
  fileMeta.textContent = `${selectedFileName} • ${fileBytes.length} bytes • ${totalDataPackets} packets • ${totalScans()} total scans`;
  refreshEstimates();
}

function persistAndRefresh(): void {
  saveSettings(settings);
  updateSettingsUi();
  try {
    rebuildPlan();
    transmissionService.loadTransfer();
  } catch (error) {
    transmissionPlan = null;
    totalDataPackets = 0;
    const userFacing = toUserFacingSenderError(error);
    setSenderStage('ERROR', userFacing.title);
    warningMeta.textContent = userFacing.warning;
    startButton.disabled = true;
    transmissionService.reset();
  }
}

function setWakeLockWarning(message: string): void {
  wakeLockWarningEl.textContent = message;
}

async function requestWakeLock(): Promise<void> {
  if (!('wakeLock' in navigator)) {
    setWakeLockWarning('⚠️ Auto-Sleep Disabled: Keep Screen On Manually');
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    setWakeLockWarning('');
  } catch (error) {
    logger.error('Wake lock failed', error);
    setWakeLockWarning('⚠️ Auto-Sleep Disabled: Keep Screen On Manually');
  }
}

function releaseWakeLock(): void {
  void wakeLock?.release();
  wakeLock = null;
}

async function renderFrame(index: number, frame: { frameType: number; packetIndex?: number }): Promise<void> {
  if (!transmissionPlan) throw new Error('Transmission plan unavailable.');
  let frameBytes: Uint8Array;
  if (frame.frameType === FRAME_TYPE_HEADER) frameBytes = transmissionPlan.headerBytes;
  else if (frame.frameType === FRAME_TYPE_END) frameBytes = transmissionPlan.endBytes;
  else frameBytes = getDataFrameBytes(transmissionPlan, frame.packetIndex ?? 0);

  await encodeFrameBytesToCanvas(frameBytes, qrCanvas, {
    qrErrorCorrection: settings.qrErrorCorrection,
    qrSizePx: settings.qrSizePx
  });

  packetMeta.textContent = frame.frameType === FRAME_TYPE_DATA
    ? `Sending ${streamFrameLabel(frame.frameType, frame.packetIndex)}`
    : `Sending ${streamFrameLabel(frame.frameType, frame.packetIndex)} • scan ${index + 1}/${totalScans()}`;
  if (settings.soundEnabled) playClickSound();
  logger.debug('[sender] rendered', { index });
}

const transmissionService = new SenderTransmissionService({
  getTotalFrames: () => transmissionPlan ? totalScans() : 0,
  getFrameAt: (index) => transmissionPlan ? getStreamFrameAtIndex(totalDataPackets, settings.redundancyCount, index) : null,
  getFrameDisplayDurationMs: (frame) => getFrameDisplayDurationMs(frame, settings.frameDurationMs),
  renderFrame,
  requestWakeLock,
  releaseWakeLock,
  onEvent: (event) => {
    if (event.type === 'stageChanged') {
      const payload = event.payload;
      const stage = payload.stage;
      if (stage === 'TRANSMITTING') stageEl.classList.add('transmitting');
      else stageEl.classList.remove('transmitting');

      if (stage !== 'COUNTDOWN') countdownMeta.textContent = '';
      if (payload.message?.startsWith('Starting in')) countdownMeta.textContent = payload.message;
      setSenderStage(stage, payload.message);
      stopButton.disabled = stage !== 'TRANSMITTING' && stage !== 'COUNTDOWN';
      startButton.disabled = stage === 'TRANSMITTING' || stage === 'COUNTDOWN' || !transmissionPlan;
      return;
    }

    if (event.type === 'failed') {
      warningMeta.textContent = event.payload.message;
    }
  }
});

function stopTransmission(message = 'Transmission stopped.', stage: SenderStage = 'READY'): void {
  transmissionService.stop(message, stage);
}

function clearQrOutput(message = 'QR output cleared.'): void {
  stopTransmission(message, transmissionPlan ? 'READY' : 'NO_FILE');
  const ctx = qrCanvas.getContext('2d');
  ctx?.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
  packetMeta.textContent = transmissionPlan ? 'Ready to transmit' : 'No file selected';
  warningMeta.textContent = '';
}

frameDurationInput.addEventListener('input', () => {
  settings.frameDurationMs = clamp(Number(frameDurationInput.value), 500, 5000);
  persistAndRefresh();
});
errorCorrectionSelect.addEventListener('change', () => {
  settings.qrErrorCorrection = errorCorrectionSelect.value as QRCode.QRCodeErrorCorrectionLevel;
  persistAndRefresh();
});
qrSizeInput.addEventListener('input', () => {
  settings.qrSizePx = clamp(Number(qrSizeInput.value), 200, 1000);
  persistAndRefresh();
});
chunkAutoInput.addEventListener('change', () => {
  settings.chunkAuto = chunkAutoInput.checked;
  persistAndRefresh();
});
chunkSizeInput.addEventListener('input', () => {
  settings.chunkSizeBytes = clamp(Number(chunkSizeInput.value), 128, 1024);
  persistAndRefresh();
});
redundancyInput.addEventListener('input', () => {
  settings.redundancyCount = 1;
  redundancyInput.value = '1';
  persistAndRefresh();
});
soundEnabledInput.addEventListener('change', () => {
  settings.soundEnabled = soundEnabledInput.checked;
  void resumeAudioContext();
  persistAndRefresh();
});

themeButton.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  setTheme(current === 'dark' ? 'light' : 'dark');
});

fileInput.addEventListener('change', async () => {
  await resumeAudioContext();
  stopTransmission();
  const selectedFile = fileInput.files?.[0];
  if (!selectedFile) {
    transmissionPlan = null;
    totalDataPackets = 0;
    fileBytes = null;
    selectedFileName = '';
    fileMeta.textContent = 'No file selected.';
    setSenderStage('NO_FILE', 'No file selected');
    startButton.disabled = true;
    refreshEstimates();
    transmissionService.reset();
    return;
  }

  const invalidReason = validateFileBeforeTransmission(selectedFile);
  if (invalidReason) {
    transmissionPlan = null;
    totalDataPackets = 0;
    fileBytes = null;
    selectedFileName = '';
    fileMeta.textContent = 'File too large (1 MiB max).';
    setSenderStage('ERROR', invalidReason.title);
    warningMeta.textContent = invalidReason.warning;
    startButton.disabled = true;
    transmissionService.reset();
    return;
  }

  try {
    fileBytes = await readFileBytes(selectedFile);
  } catch (error) {
    transmissionPlan = null;
    totalDataPackets = 0;
    fileBytes = null;
    selectedFileName = '';
    fileMeta.textContent = 'Error reading file.';
    setSenderStage('ERROR', error instanceof Error ? error.message : 'Error: file read failed.');
    warningMeta.textContent = SENDER_ERROR_COPY_MAP.FILE_READ_FAILED.warning;
    startButton.disabled = true;
    transmissionService.reset();
    return;
  }

  selectedFileName = selectedFile.name;

  try {
    rebuildPlan();
  } catch (error) {
    transmissionPlan = null;
    totalDataPackets = 0;
    fileBytes = null;
    selectedFileName = '';
    const userFacing = toUserFacingSenderError(error);
    fileMeta.textContent = userFacing.title.includes('filename') ? 'Filename cannot be encoded within protocol limits.' : 'Packetization failed.';
    setSenderStage('ERROR', userFacing.title);
    warningMeta.textContent = userFacing.warning;
    startButton.disabled = true;
    transmissionService.reset();
    return;
  }

  try {
    if (!transmissionPlan) throw new Error('Transmission plan unavailable');
    await preflightTransmissionPlan(transmissionPlan, {
      qrErrorCorrection: settings.qrErrorCorrection,
      qrSizePx: settings.qrSizePx
    });
  } catch (error) {
    transmissionPlan = null;
    totalDataPackets = 0;
    const userFacing = toUserFacingPreflightError(error);
    setSenderStage('ERROR', userFacing.title);
    warningMeta.textContent = userFacing.warning;
    startButton.disabled = true;
    transmissionService.reset();
    return;
  }

  setSenderStage('READY', 'Ready to transmit');
  startButton.disabled = false;
  transmissionService.loadTransfer();
});

startButton.addEventListener('click', () => {
  void resumeAudioContext();
  if (!transmissionPlan) return;
  transmissionService.start();
});

stopButton.addEventListener('click', () => stopTransmission());
clearButton.addEventListener('click', () => clearQrOutput());
resetButton.addEventListener('click', () => {
  clearQrOutput('No file selected');
  transmissionPlan = null;
  totalDataPackets = 0;
  fileBytes = null;
  selectedFileName = '';
  fileInput.value = '';
  fileMeta.textContent = 'No file selected.';
  setSenderStage('NO_FILE', 'No file selected');
  warningMeta.textContent = '';
  refreshEstimates();
  const ctx = qrCanvas.getContext('2d');
  ctx?.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
  startButton.disabled = true;
  transmissionService.reset();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    transmissionService.interruptForHiddenPage();
  }
});

const preferredTheme = localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
setTheme(preferredTheme);
updateSettingsUi();
refreshEstimates();
if (!('wakeLock' in navigator)) {
  setWakeLockWarning('⚠️ Auto-Sleep Disabled: Keep Screen On Manually');
}

setSenderStage('NO_FILE', 'No file selected');
