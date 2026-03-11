import './style.css';
import QRCode from 'qrcode';
import { assemblePacket, chunkFile, type Packet } from '@qr-data-bridge/protocol';

const QR_PREFIX = 'QDB64:';
const SETTINGS_KEY = 'qdb_sender_settings_v2';
const THEME_KEY = 'qdb_theme';
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const RECOMMENDED_FILE_SIZE_BYTES = 5 * 1024 * 1024;

const logger = {
  debug: (...args: unknown[]) => {
    if (import.meta.env.DEV) {
      console.info(...args);
    }
  },
  error: (...args: unknown[]) => console.error(...args)
};

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
  frameDurationMs: 2000,
  qrErrorCorrection: 'H',
  qrSizePx: 400,
  chunkSizeBytes: 512,
  chunkAuto: true,
  redundancyCount: 3,
  soundEnabled: false
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
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
      qrSizePx: clamp(parsed.qrSizePx ?? DEFAULT_SETTINGS.qrSizePx, 200, 600),
      chunkSizeBytes: clamp(parsed.chunkSizeBytes ?? DEFAULT_SETTINGS.chunkSizeBytes, 128, 1024),
      chunkAuto: parsed.chunkAuto ?? true,
      redundancyCount: clamp(parsed.redundancyCount ?? DEFAULT_SETTINGS.redundancyCount, 1, 5),
      soundEnabled: parsed.soundEnabled ?? false
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: SenderSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function playClickSound(): void {
  const context = new AudioContext();
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
    <div class="row">
      <button id="theme-btn" type="button">Theme</button>
      <label class="inline-check"><input id="sound-enabled" type="checkbox"/> Sound</label>
    </div>
    <input id="file-input" type="file" />
    <button id="start-btn" type="button" disabled>Start Transmission</button>
    <button id="stop-btn" type="button" disabled>Stop</button>
    <button id="reset-btn" type="button">Reset</button>
    <details>
      <summary>Settings</summary>
      <label>Frame Duration: <span id="frame-duration-label"></span>
        <input id="frame-duration" type="range" min="500" max="5000" step="100" />
      </label>
      <label>QR Error Correction
        <select id="error-correction"><option value="L">L</option><option value="M">M</option><option value="Q">Q</option><option value="H">H</option></select>
      </label>
      <label>QR Size: <span id="qr-size-label"></span>
        <input id="qr-size" type="range" min="200" max="600" step="20" />
      </label>
      <label><input id="chunk-auto" type="checkbox" /> Auto Chunk Size</label>
      <label>Chunk Size: <span id="chunk-size-label"></span>
        <input id="chunk-size" type="range" min="128" max="1024" step="16" />
      </label>
      <label>Redundancy: <span id="redundancy-label"></span>
        <input id="redundancy" type="range" min="1" max="5" step="1" />
      </label>
    </details>
    <div id="file-meta">No file selected.</div>
    <div id="packet-meta">Packet: -</div>
    <div id="eta-meta">ETA: -</div>
    <div id="speed-meta">Estimated Speed: -</div>
    <div id="countdown-meta"></div>
    <div id="warning-meta" class="warning"></div>
    <small>Keep brightness high. Do not minimize this tab during transfer.</small>
  </aside>
</main>`;

const fileInput = getElement<HTMLInputElement>('#file-input');
const fileMeta = getElement<HTMLDivElement>('#file-meta');
const packetMeta = getElement<HTMLDivElement>('#packet-meta');
const etaMeta = getElement<HTMLDivElement>('#eta-meta');
const speedMeta = getElement<HTMLDivElement>('#speed-meta');
const countdownMeta = getElement<HTMLDivElement>('#countdown-meta');
const warningMeta = getElement<HTMLDivElement>('#warning-meta');
const startButton = getElement<HTMLButtonElement>('#start-btn');
const stopButton = getElement<HTMLButtonElement>('#stop-btn');
const resetButton = getElement<HTMLButtonElement>('#reset-btn');
const stageEl = getElement<HTMLElement>('#stage');
const qrShell = getElement<HTMLDivElement>('#qr-shell');
const qrCanvas = getElement<HTMLCanvasElement>('#qr-canvas');
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
let packets: Packet[] = [];
let streamPackets: Packet[] = [];
let fileBytes: Uint8Array | null = null;
let selectedFileName = '';
let currentStreamIndex = 0;
let transmissionTimer: number | null = null;
let countdownTimer: number | null = null;
let isTransmitting = false;
let wakeLock: WakeLockSentinel | null = null;

function setTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function effectiveChunkSize(): number {
  return settings.chunkAuto ? estimateAutoChunkSize(settings.qrSizePx, settings.qrErrorCorrection) : settings.chunkSizeBytes;
}

function estimatedSpeedBytesPerSec(): number {
  return Math.floor((effectiveChunkSize() / settings.redundancyCount) * (1000 / settings.frameDurationMs));
}

function refreshEstimates(): void {
  const speed = estimatedSpeedBytesPerSec();
  speedMeta.textContent = `Estimated Speed: ${speed} B/s`;
  if (fileBytes) {
    const estimatedMs = Math.ceil(streamPackets.length * settings.frameDurationMs);
    etaMeta.textContent = `Estimated Time: ${formatDuration(estimatedMs)}`;
    const warnings: string[] = [];
    if (estimatedMs > 10 * 60 * 1000) warnings.push('File Too Large: estimated transfer exceeds 10 minutes.');
    if (fileBytes.length > RECOMMENDED_FILE_SIZE_BYTES) warnings.push('Large transfer can heat devices.');
    warningMeta.textContent = warnings.join(' ');
  } else {
    etaMeta.textContent = 'ETA: -';
    warningMeta.textContent = '';
  }
}

function updateSettingsUi(): void {
  frameDurationInput.value = String(settings.frameDurationMs);
  frameDurationLabel.textContent = `${settings.frameDurationMs}ms`;
  errorCorrectionSelect.value = settings.qrErrorCorrection;
  qrSizeInput.value = String(settings.qrSizePx);
  qrSizeLabel.textContent = `${settings.qrSizePx}px`;
  chunkAutoInput.checked = settings.chunkAuto;
  chunkSizeInput.value = String(settings.chunkSizeBytes);
  chunkSizeInput.disabled = settings.chunkAuto;
  chunkSizeLabel.textContent = settings.chunkAuto ? `${effectiveChunkSize()} bytes (auto)` : `${settings.chunkSizeBytes} bytes`;
  redundancyInput.value = String(settings.redundancyCount);
  redundancyLabel.textContent = `${settings.redundancyCount}x`;
  soundEnabledInput.checked = settings.soundEnabled;
  qrShell.style.setProperty('--qr-size', `${settings.qrSizePx}px`);
}

function rebuildPackets(): void {
  if (!fileBytes) return;
  packets = chunkFile(fileBytes, { fileName: selectedFileName, maxPayloadSize: effectiveChunkSize() });
  streamPackets = packets.flatMap((packet) => Array.from({ length: settings.redundancyCount }, () => packet));
  fileMeta.textContent = `${selectedFileName} • ${fileBytes.length} bytes • ${packets.length} unique packets • ${streamPackets.length} total scans`;
  refreshEstimates();
}

function persistAndRefresh(): void {
  saveSettings(settings);
  updateSettingsUi();
  rebuildPackets();
}

async function requestWakeLock(): Promise<void> {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (error) {
    logger.error('Wake lock failed', error);
  }
}

function releaseWakeLock(): void {
  void wakeLock?.release();
  wakeLock = null;
}

function stopTransmission(message = 'Transmission stopped.'): void {
  if (transmissionTimer !== null) window.clearTimeout(transmissionTimer);
  if (countdownTimer !== null) window.clearTimeout(countdownTimer);
  transmissionTimer = null;
  countdownTimer = null;
  isTransmitting = false;
  stageEl.classList.remove('transmitting');
  countdownMeta.textContent = '';
  stopButton.disabled = true;
  startButton.disabled = packets.length === 0;
  releaseWakeLock();
  if (packets.length > 0) packetMeta.textContent = message;
}

async function renderPacket(index: number): Promise<void> {
  const packet = streamPackets[index];
  const payload = `${QR_PREFIX}${bytesToBase64(assemblePacket(packet))}`;
  await QRCode.toCanvas(qrCanvas, payload, {
    errorCorrectionLevel: settings.qrErrorCorrection,
    width: settings.qrSizePx,
    margin: 1,
    color: { dark: '#000000', light: '#FFFFFF' }
  });
  const packetNumber = packet.packetIndex + 1;
  const uniqueLeft = packets.length - packetNumber;
  packetMeta.textContent = `Sending packet ${packetNumber}/${packets.length} • scan ${index + 1}/${streamPackets.length}`;
  etaMeta.textContent = `ETA: ${formatDuration(uniqueLeft * settings.redundancyCount * settings.frameDurationMs)}`;
  if (settings.soundEnabled) playClickSound();
  logger.debug('[sender] rendered', { index, packetIndex: packet.packetIndex });
}

function scheduleNextPacket(): void {
  if (!isTransmitting || streamPackets.length === 0) return;
  transmissionTimer = window.setTimeout(async () => {
    if (!isTransmitting) return;
    const nextIndex = currentStreamIndex + 1;
    if (nextIndex >= streamPackets.length) {
      stopTransmission('Transfer Complete');
      return;
    }
    currentStreamIndex = nextIndex;
    try {
      await renderPacket(currentStreamIndex);
      scheduleNextPacket();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown QR encoding error.';
      stopTransmission(`QR encode failed: ${message}`);
    }
  }, settings.frameDurationMs);
}

function startCountdownAndTransmit(): void {
  let tick = 3;
  const runTick = async () => {
    countdownMeta.textContent = `Starting in ${tick}...`;
    if (tick === 0) {
      countdownMeta.textContent = '';
      stageEl.classList.add('transmitting');
      await requestWakeLock();
      try {
        await renderPacket(0);
        scheduleNextPacket();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown QR encoding error.';
        stopTransmission(`QR encode failed: ${message}`);
      }
      return;
    }
    tick -= 1;
    countdownTimer = window.setTimeout(() => {
      void runTick();
    }, 1000);
  };
  void runTick();
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
  settings.qrSizePx = clamp(Number(qrSizeInput.value), 200, 600);
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
  settings.redundancyCount = clamp(Number(redundancyInput.value), 1, 5);
  persistAndRefresh();
});
soundEnabledInput.addEventListener('change', () => {
  settings.soundEnabled = soundEnabledInput.checked;
  persistAndRefresh();
});

themeButton.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  setTheme(current === 'dark' ? 'light' : 'dark');
});

fileInput.addEventListener('change', async () => {
  stopTransmission();
  const selectedFile = fileInput.files?.[0];
  if (!selectedFile) {
    packets = [];
    streamPackets = [];
    fileBytes = null;
    selectedFileName = '';
    fileMeta.textContent = 'No file selected.';
    packetMeta.textContent = 'Packet: -';
    startButton.disabled = true;
    refreshEstimates();
    return;
  }

  if (selectedFile.size > MAX_FILE_SIZE_BYTES) {
    packets = [];
    streamPackets = [];
    fileBytes = null;
    selectedFileName = '';
    fileMeta.textContent = 'File too large (10MB max).';
    packetMeta.textContent = 'Choose a smaller file.';
    startButton.disabled = true;
    return;
  }

  fileBytes = new Uint8Array(await selectedFile.arrayBuffer());
  selectedFileName = selectedFile.name;
  rebuildPackets();
  currentStreamIndex = 0;
  packetMeta.textContent = 'Ready to transmit.';
  startButton.disabled = false;
});

startButton.addEventListener('click', () => {
  if (!streamPackets.length) return;
  stopTransmission();
  isTransmitting = true;
  currentStreamIndex = 0;
  startButton.disabled = true;
  stopButton.disabled = false;
  startCountdownAndTransmit();
});

stopButton.addEventListener('click', () => stopTransmission());
resetButton.addEventListener('click', () => {
  stopTransmission('Ready to transmit.');
  packets = [];
  streamPackets = [];
  fileBytes = null;
  selectedFileName = '';
  fileInput.value = '';
  fileMeta.textContent = 'No file selected.';
  packetMeta.textContent = 'Packet: -';
  warningMeta.textContent = '';
  refreshEstimates();
  const ctx = qrCanvas.getContext('2d');
  ctx?.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
  startButton.disabled = true;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && isTransmitting) {
    stopTransmission('Paused: tab hidden. Resume when visible.');
  }
});

const preferredTheme = localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
setTheme(preferredTheme);
updateSettingsUi();
refreshEstimates();
