import './style.css';
import {
  ReceiverMachine,
  parseFrame,
  MAGIC_BYTES,
  FRAME_TYPE_HEADER,
  FRAME_TYPE_DATA,
  FRAME_TYPE_END,
  type ReceiverSnapshot
} from '@qr-data-bridge/protocol';
import { JsQrFrameDecoder } from '../../receiver/src/decode/ReceiverFrameDecoder';
import { DecodePipeline } from '../../receiver/src/decode/DecodePipeline';

type Strategy = 'full-frame' | 'downscaled' | 'roi' | 'multi-pass';

interface AttemptDiagnostic {
  strategy: Strategy;
  decoded: boolean;
  parseOk: boolean;
  accepted: boolean;
  message: string;
}

interface FrameDiagnostic {
  frameIndex: number;
  timeMs: number;
  attempts: AttemptDiagnostic[];
  acceptedStrategy: Strategy | null;
  state: ReceiverSnapshot['state'];
  lockConfirmed: boolean;
  receivedCount: number;
  totalPackets: number | null;
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
<main class="layout">
  <h1>Replay Receiver Debugger</h1>
  <section class="panel controls">
    <label>Video input
      <input id="video-file" type="file" accept="video/*" />
    </label>
    <label>Frame step (ms)
      <input id="frame-step-ms" type="number" min="10" value="120" />
    </label>
    <label>Offline sample period (ms)
      <input id="offline-step-ms" type="number" min="20" value="80" />
    </label>
    <label><input id="timeout-enabled" type="checkbox" /> Apply live timeout semantics</label>
    <div>
      <div>Decode strategies (comparison)</div>
      <div class="strategy-list">
        <label><input type="checkbox" class="strategy" value="full-frame" checked /> full-frame</label>
        <label><input type="checkbox" class="strategy" value="downscaled" checked /> downscaled</label>
        <label><input type="checkbox" class="strategy" value="roi" checked /> ROI</label>
        <label><input type="checkbox" class="strategy" value="multi-pass" checked /> multi-pass</label>
      </div>
    </div>
    <div class="row">
      <button id="realtime-btn" type="button">Start real-time replay</button>
      <button id="pause-btn" type="button">Pause</button>
      <button id="step-btn" type="button">Frame step</button>
      <button id="offline-btn" type="button">Run offline max-effort</button>
      <button id="export-btn" type="button" disabled>Export JSON report</button>
      <button id="reset-btn" type="button">Reset session</button>
    </div>
  </section>

  <section class="panel">
    <video id="video" controls playsinline></video>
    <p id="status" class="muted">Load a video and choose a mode.</p>
    <pre id="summary">No diagnostics yet.</pre>
  </section>

  <section class="panel table-wrap">
    <table>
      <thead><tr><th>#</th><th>t(ms)</th><th>accepted</th><th>state</th><th>received</th><th>attempts</th></tr></thead>
      <tbody id="diag-body"></tbody>
    </table>
  </section>
</main>`;

const fileInput = query<HTMLInputElement>('#video-file');
const frameStepMsInput = query<HTMLInputElement>('#frame-step-ms');
const offlineStepMsInput = query<HTMLInputElement>('#offline-step-ms');
const timeoutEnabledInput = query<HTMLInputElement>('#timeout-enabled');
const realtimeButton = query<HTMLButtonElement>('#realtime-btn');
const pauseButton = query<HTMLButtonElement>('#pause-btn');
const stepButton = query<HTMLButtonElement>('#step-btn');
const offlineButton = query<HTMLButtonElement>('#offline-btn');
const exportButton = query<HTMLButtonElement>('#export-btn');
const resetButton = query<HTMLButtonElement>('#reset-btn');
const video = query<HTMLVideoElement>('#video');
const statusEl = query<HTMLParagraphElement>('#status');
const summaryEl = query<HTMLPreElement>('#summary');
const diagBody = query<HTMLTableSectionElement>('#diag-body');

const decoder = new JsQrFrameDecoder();
const roiPipeline = new DecodePipeline(decoder, {
  roiPaddingRatio: 0.4,
  roiMissesBeforeFull: 3,
  forceFullEveryAttempts: 10,
  noSuccessResetMs: 1200,
  maxFullSidePx: 448,
  maxRoiSidePx: 448
});

const frameCanvas = document.createElement('canvas');
const frameCtxCandidate = frameCanvas.getContext('2d', { willReadFrequently: true });
if (!frameCtxCandidate) throw new Error('Unable to create frame context');
const frameCtx = frameCtxCandidate;

let machine = new ReceiverMachine();
let diagnostics: FrameDiagnostic[] = [];
let frameIndex = 0;
let loopActive = false;
let strategyStats: Record<Strategy, number> = {
  'full-frame': 0,
  downscaled: 0,
  roi: 0,
  'multi-pass': 0
};

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  video.src = URL.createObjectURL(file);
  statusEl.textContent = `Loaded ${file.name}`;
});

realtimeButton.addEventListener('click', async () => {
  if (!video.src) return;
  loopActive = true;
  await video.play();
  statusEl.textContent = 'Real-time replay running';
  runRealtimeLoop();
});

pauseButton.addEventListener('click', () => {
  loopActive = false;
  video.pause();
  statusEl.textContent = 'Paused';
});

stepButton.addEventListener('click', async () => {
  if (!video.src) return;
  const stepMs = Number(frameStepMsInput.value) || 120;
  video.pause();
  video.currentTime = Math.min(video.duration || 0, video.currentTime + stepMs / 1000);
  await seekSettled();
  processCurrentFrame('frame-step');
  statusEl.textContent = `Stepped to ${(video.currentTime * 1000).toFixed(0)}ms`;
});

offlineButton.addEventListener('click', async () => {
  if (!video.src) return;
  loopActive = false;
  video.pause();
  statusEl.textContent = 'Offline max-effort analysis in progress...';
  const intervalMs = Number(offlineStepMsInput.value) || 80;
  const totalMs = Math.max(0, Math.floor((video.duration || 0) * 1000));
  for (let t = 0; t <= totalMs; t += intervalMs) {
    video.currentTime = t / 1000;
    await seekSettled();
    processCurrentFrame('offline');
  }
  statusEl.textContent = `Offline analysis complete (${diagnostics.length} samples)`;
});

resetButton.addEventListener('click', () => {
  machine = new ReceiverMachine();
  machine.startScanning();
  roiPipeline.resetForFreshAttempt();
  diagnostics = [];
  frameIndex = 0;
  strategyStats = { 'full-frame': 0, downscaled: 0, roi: 0, 'multi-pass': 0 };
  renderDiagnostics();
  statusEl.textContent = 'Session reset';
});

exportButton.addEventListener('click', () => {
  const report = {
    generatedAt: new Date().toISOString(),
    source: fileInput.files?.[0]?.name ?? null,
    timeoutSemanticsEnabled: timeoutEnabledInput.checked,
    summary: summarizeMachine(machine.snapshot),
    strategyStats,
    frameDiagnostics: diagnostics
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'receiver-video-report.json';
  a.click();
  URL.revokeObjectURL(url);
});

machine.startScanning();

function runRealtimeLoop(): void {
  if (!loopActive) return;
  if (video.paused || video.ended) {
    loopActive = false;
    statusEl.textContent = 'Real-time replay ended';
    return;
  }
  processCurrentFrame('realtime');
  requestAnimationFrame(runRealtimeLoop);
}

function processCurrentFrame(mode: 'realtime' | 'frame-step' | 'offline'): void {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  frameCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);

  const selectedStrategies = getSelectedStrategies();
  const attempts: AttemptDiagnostic[] = [];
  let accepted: Strategy | null = null;

  for (const strategy of selectedStrategies) {
    const attempt = runStrategy(strategy);
    attempts.push(attempt);
    if (!accepted && attempt.accepted) {
      accepted = strategy;
      strategyStats[strategy] += 1;
    }
  }

  if (timeoutEnabledInput.checked) {
    machine.tick(Date.now());
  }

  diagnostics.push({
    frameIndex: frameIndex += 1,
    timeMs: Math.round(video.currentTime * 1000),
    attempts,
    acceptedStrategy: accepted,
    state: machine.snapshot.state,
    lockConfirmed: machine.snapshot.lockConfirmed,
    receivedCount: machine.snapshot.receivedCount,
    totalPackets: machine.snapshot.totalPackets
  });

  if (mode !== 'realtime' || diagnostics.length % 6 === 0) {
    renderDiagnostics();
  }
}

function runStrategy(strategy: Strategy): AttemptDiagnostic {
  if (strategy === 'full-frame') {
    return decodeFromCanvas(strategy, frameCanvas.width, frameCanvas.height);
  }
  if (strategy === 'downscaled') {
    const side = 360;
    const scale = Math.min(1, side / Math.max(frameCanvas.width, frameCanvas.height));
    return decodeFromCanvas(strategy, Math.max(1, Math.round(frameCanvas.width * scale)), Math.max(1, Math.round(frameCanvas.height * scale)));
  }
  if (strategy === 'roi') {
    const res = roiPipeline.decode(frameCanvas, frameCanvas.width, frameCanvas.height, true, performance.now());
    if (!res.decodeResult) {
      return { strategy, decoded: false, parseOk: false, accepted: false, message: 'no qr' };
    }
    return parseAndApply(strategy, res.decodeResult.payload);
  }

  const fullTry = decodeFromCanvas('multi-pass', frameCanvas.width, frameCanvas.height, true);
  if (fullTry.accepted || fullTry.decoded) return { ...fullTry, strategy: 'multi-pass', message: `full pass: ${fullTry.message}` };
  const downTry = decodeFromCanvas('multi-pass', Math.max(1, Math.round(frameCanvas.width * 0.65)), Math.max(1, Math.round(frameCanvas.height * 0.65)), true);
  if (downTry.accepted || downTry.decoded) return { ...downTry, strategy: 'multi-pass', message: `downscale pass: ${downTry.message}` };
  const roiTry = runStrategy('roi');
  return { ...roiTry, strategy: 'multi-pass', message: `roi pass: ${roiTry.message}` };
}

function decodeFromCanvas(strategy: Strategy, targetW: number, targetH: number, decodeOnly = false): AttemptDiagnostic {
  const scratch = document.createElement('canvas');
  scratch.width = targetW;
  scratch.height = targetH;
  const context = scratch.getContext('2d', { willReadFrequently: true });
  if (!context) return { strategy, decoded: false, parseOk: false, accepted: false, message: 'context unavailable' };
  context.drawImage(frameCanvas, 0, 0, frameCanvas.width, frameCanvas.height, 0, 0, targetW, targetH);
  const image = context.getImageData(0, 0, targetW, targetH);
  const decoded = decoder.decode(image.data, targetW, targetH);
  if (!decoded) {
    return { strategy, decoded: false, parseOk: false, accepted: false, message: 'no qr' };
  }
  if (decodeOnly) {
    return parseAndApply(strategy, decoded.payload);
  }
  return parseAndApply(strategy, decoded.payload);
}

function parseAndApply(strategy: Strategy, payload: Uint8Array): AttemptDiagnostic {
  if (!isLikelyProtocol(payload)) {
    return { strategy, decoded: true, parseOk: false, accepted: false, message: 'magic mismatch' };
  }
  try {
    const frame = parseFrame(payload);
    const before = machine.snapshot.receivedCount;
    machine.noteLockedTransferActivity(frame, Date.now());
    machine.applyFrame(frame, Date.now());
    const after = machine.snapshot.receivedCount;
    return {
      strategy,
      decoded: true,
      parseOk: true,
      accepted: after > before || frame.frameType !== 1,
      message: `${frame.frameType === FRAME_TYPE_HEADER ? 'header' : frame.frameType === FRAME_TYPE_DATA ? `data#${frame.packetIndex}` : frame.frameType === FRAME_TYPE_END ? 'end' : 'unknown'} ok`
    };
  } catch (error) {
    return {
      strategy,
      decoded: true,
      parseOk: false,
      accepted: false,
      message: error instanceof Error ? error.message : 'parse failed'
    };
  }
}

function isLikelyProtocol(payload: Uint8Array): boolean {
  if (payload.length < MAGIC_BYTES.length) return false;
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (payload[i] !== MAGIC_BYTES[i]) return false;
  }
  return true;
}

function getSelectedStrategies(): Strategy[] {
  const selected = [...document.querySelectorAll<HTMLInputElement>('input.strategy:checked')]
    .map((input) => input.value as Strategy);
  return selected.length > 0 ? selected : ['full-frame'];
}

function renderDiagnostics(): void {
  exportButton.disabled = diagnostics.length === 0;
  const latest = diagnostics.slice(-150);
  diagBody.innerHTML = latest.map((entry) => `
    <tr>
      <td>${entry.frameIndex}</td>
      <td>${entry.timeMs}</td>
      <td>${entry.acceptedStrategy ?? '-'}</td>
      <td>${entry.state}${entry.lockConfirmed ? ' (locked)' : ''}</td>
      <td>${entry.receivedCount}/${entry.totalPackets ?? '?'}</td>
      <td>${entry.attempts.map((a) => `${a.strategy}:${a.message}`).join(' | ')}</td>
    </tr>
  `).join('');
  summaryEl.textContent = [
    summarizeMachine(machine.snapshot),
    `frames analysed: ${diagnostics.length}`,
    `strategy accepted counts: ${Object.entries(strategyStats).map(([k, v]) => `${k}=${v}`).join(', ')}`
  ].join('\n');
}

function summarizeMachine(snapshot: ReceiverSnapshot): string {
  return `state=${snapshot.state}, lock=${snapshot.lockConfirmed}, transfer=${snapshot.transferId ?? '-'}, packets=${snapshot.receivedCount}/${snapshot.totalPackets ?? '?'}, file=${snapshot.fileName || '-'}`;
}

function query<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}

function seekSettled(): Promise<void> {
  return new Promise((resolve) => {
    const onSeek = () => {
      video.removeEventListener('seeked', onSeek);
      resolve();
    };
    video.addEventListener('seeked', onSeek, { once: true });
  });
}
