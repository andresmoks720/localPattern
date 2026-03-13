import './style.css';
import jsQR from 'jsqr';
import {
  ReceiverMachine,
  MAGIC_BYTES,
  RECEIVER_ERROR_CODES,
  RECEIVER_LOCK_CONFIRMATION,
  RECEIVER_TIMEOUTS,
  parseFrame,
  FRAME_TYPE_HEADER,
  FRAME_TYPE_DATA,
  FRAME_TYPE_END,
  type ReceiverSnapshot
} from '@qr-data-bridge/protocol';
import { ReceiverIngestService } from './ingestService';
import { selectScanIntervalMs, shouldProcessParsedFrameWithGeometry } from './scanPolicy';

const SIGNAL_LOST_MS = 5000;
const MIN_QR_AREA_RATIO = 0.015;
const MAX_AREA_DRIFT_RATIO = 0.4;
const MAX_ASPECT_DRIFT_RATIO = 0.25;
const MAX_CENTER_DRIFT_RATIO = 0.12;
const STABLE_SCANS_REQUIRED = 2;
const THEME_KEY = 'qdb_theme';
const DEBUG_EVENT_LOG_CAP = 100;
const RECEIVER_LOG_CACHE_KEY = 'receiver_log_cache';
const SCAN_LOOP_LAG_THRESHOLD_MS = 500;
const SLOW_QR_DECODE_THRESHOLD_MS = 120;

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
    <div class="panel-body">
      <div class="side-buttons">
        <button id="scan-btn" type="button">Start Scan</button>
        <button id="download-btn" type="button" disabled>Download File</button>
        <button id="pause-session-btn" type="button">Pause Session</button>
        <button id="copy-events-btn" type="button">Copy Logs to Cache</button>
        <button id="theme-btn" type="button">Theme</button>
      </div>
      <div class="panel-content">
        <label class="inline-check">Camera: <select id="camera-select"><option value="">Auto (rear)</option></select></label>
        <label class="inline-check"><input id="sound-enabled" type="checkbox"/> Completion sound</label>
        <div id="status" class="status">Ready to scan</div>
        <div id="lock-status">Waiting for initial QR</div>
        <div class="progress-wrap"><div id="progress-bar" class="progress-bar"></div></div>
        <div id="progress-text">Searching for transfer header</div>
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
      </div>
    </div>
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
const pauseSessionButton = getElement<HTMLButtonElement>('#pause-session-btn');
const copyEventsButton = getElement<HTMLButtonElement>('#copy-events-btn');

const frameCanvas = document.createElement('canvas');
const frameContextCandidate = frameCanvas.getContext('2d', { willReadFrequently: true });
if (!frameContextCandidate) throw new Error('Failed to initialize frame canvas context.');
const frameContext = frameContextCandidate;

let rafId = 0;
let monitorInterval: number | null = null;
let activeStream: MediaStream | null = null;
let lastScanAt = 0;
let scanStartedAt = 0;
let lastDiscoveryActivityAt = 0;
let lastProtocolFrameSeenAt = 0;
let previousDiscoveryScanCount = 0;
let downloadUrl: string | null = null;
let soundEnabled = false;
let successSoundPlayed = false;
let ingestDecodeError: string | null = null;
let selectedCameraId = '';
let stableGeometryCount = 0;
let lastGeometry: { areaRatio: number; aspectRatio: number; centerX: number; centerY: number } | null = null;
let debugLogEnabled = false;
let isSessionPaused = false;
const debugEventLines: string[] = [];


interface DecodeFunnelCounters {
  sampledFrames: number;
  noQrDetected: number;
  qrDetected: number;
  geometryRejected: number;
  protocolMagicRejected: number;
  parseRejected: number;
  armingWindowRejected: number;
  foreignTransferRejected: number;
  packetCrcRejected: number;
  duplicateScannerRejected: number;
  duplicatePacketRejected: number;
  acceptedUnique: number;
}

interface SessionLifecycleLog {
  scanStartedAt: number | null;
  headerAcceptedAt: number | null;
  headerRepeatedCount: number;
  firstAcceptedDataIndex: number | null;
  firstAcceptedDataAt: number | null;
  endSeenAt: number | null;
  failureAt: number | null;
}

interface RunningStats {
  sampleIntervalsMs: number[];
  decodeDurationsMs: number[];
  sampleAttemptCount: number;
  longestDuplicateStreak: number;
  duplicateStreak: number;
  duplicateBeforeEnd: number;
  duplicateAfterEnd: number;
}

interface ScanLoopDiagnostics {
  loopTicks: number;
  throttledTicks: number;
  lagSpikes: number;
  maxLoopDeltaMs: number;
  decodeAttempts: number;
  decodeHits: number;
  noQrFound: number;
  geometryRejected: number;
  protocolMagicRejected: number;
  parseRejected: number;
  enqueueCalls: number;
  snapshotUpdates: number;
  slowDecodeFrames: number;
  maxDecodeMs: number;
  lastLoopAtMs: number | null;
}


let decodeFunnelCounters: DecodeFunnelCounters = {
  sampledFrames: 0,
  noQrDetected: 0,
  qrDetected: 0,
  geometryRejected: 0,
  protocolMagicRejected: 0,
  parseRejected: 0,
  armingWindowRejected: 0,
  foreignTransferRejected: 0,
  packetCrcRejected: 0,
  duplicateScannerRejected: 0,
  duplicatePacketRejected: 0,
  acceptedUnique: 0
};

let sessionLifecycleLog: SessionLifecycleLog = {
  scanStartedAt: null,
  headerAcceptedAt: null,
  headerRepeatedCount: 0,
  firstAcceptedDataIndex: null,
  firstAcceptedDataAt: null,
  endSeenAt: null,
  failureAt: null
};

let runningStats: RunningStats = {
  sampleIntervalsMs: [],
  decodeDurationsMs: [],
  sampleAttemptCount: 0,
  longestDuplicateStreak: 0,
  duplicateStreak: 0,
  duplicateBeforeEnd: 0,
  duplicateAfterEnd: 0
};

const duplicatePacketHistogram = new Map<number, number>();
let lastSampleAttemptAtMs = 0;
let previousAcceptedReceivedCount = 0;

let scanLoopDiagnostics: ScanLoopDiagnostics = {
  loopTicks: 0,
  throttledTicks: 0,
  lagSpikes: 0,
  maxLoopDeltaMs: 0,
  decodeAttempts: 0,
  decodeHits: 0,
  noQrFound: 0,
  geometryRejected: 0,
  protocolMagicRejected: 0,
  parseRejected: 0,
  enqueueCalls: 0,
  snapshotUpdates: 0,
  slowDecodeFrames: 0,
  maxDecodeMs: 0,
  lastLoopAtMs: null
};

function shortTransferId(transferId: string | null): string {
  if (!transferId) return 'unknown';
  return transferId.length <= 8 ? transferId : `${transferId.slice(0, 8)}…`;
}

function formatMissingRanges(snapshot: ReceiverSnapshot, maxRanges = 4): string {
  if (!snapshot.missingRanges.length) return 'none';
  const shown = snapshot.missingRanges.slice(0, maxRanges).map((range) => (
    range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`
  ));
  const suffix = snapshot.missingRanges.length > maxRanges ? ` (+${snapshot.missingRanges.length - maxRanges} more)` : '';
  return `${shown.join(', ')}${suffix}`;
}


function maybeLogCounterMilestone(label: string, count: number, step = 10): void {
  if (count > 0 && count % step === 0) {
    appendDebugEvent(`${label}: ${count}`);
  }
}


function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recordSampleInterval(now: number): void {
  runningStats.sampleAttemptCount += 1;
  if (lastSampleAttemptAtMs > 0) {
    runningStats.sampleIntervalsMs.push(Math.max(0, Math.round(now - lastSampleAttemptAtMs)));
  }
  lastSampleAttemptAtMs = now;
}

function trackDuplicatePacket(packetIndex: number): void {
  const next = (duplicatePacketHistogram.get(packetIndex) ?? 0) + 1;
  duplicatePacketHistogram.set(packetIndex, next);
  runningStats.duplicateStreak += 1;
  runningStats.longestDuplicateStreak = Math.max(runningStats.longestDuplicateStreak, runningStats.duplicateStreak);
  if (sessionLifecycleLog.endSeenAt === null) {
    runningStats.duplicateBeforeEnd += 1;
  } else {
    runningStats.duplicateAfterEnd += 1;
  }
}

function summarizeTopDuplicateIndices(limit = 5): string {
  if (duplicatePacketHistogram.size === 0) return 'none';
  const top = [...duplicatePacketHistogram.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([index, count]) => `${index}:${count}`);
  return top.join(', ');
}

function summarizeMissingRangeStats(snapshot: ReceiverSnapshot): string {
  const ranges = snapshot.missingRanges;
  if (!ranges.length) return 'missingRanges=[] highestContiguousFromZero=none largestMissingGap=0';
  const largestGap = Math.max(...ranges.map((range) => (range.end - range.start) + 1));
  return `missingRanges=[${formatMissingRanges(snapshot, 12)}] highestContiguousFromZero=${snapshot.lastContiguousPacketIndex} largestMissingGap=${largestGap}`;
}

function buildFailureSnapshot(snapshot: ReceiverSnapshot): string {
  const ingest = receiverIngest.getDiagnostics();
  const sampleAvg = average(runningStats.sampleIntervalsMs);
  const decodeAvg = average(runningStats.decodeDurationsMs);
  const p95Sample = percentile(runningStats.sampleIntervalsMs, 0.95);
  const p95Decode = percentile(runningStats.decodeDurationsMs, 0.95);
  const missingCount = snapshot.missingRanges.reduce((sum, range) => sum + ((range.end - range.start) + 1), 0);
  const timeToHeaderLock = sessionLifecycleLog.scanStartedAt && sessionLifecycleLog.headerAcceptedAt
    ? sessionLifecycleLog.headerAcceptedAt - sessionLifecycleLog.scanStartedAt
    : null;
  const timeFromHeaderToFirstData = sessionLifecycleLog.headerAcceptedAt && sessionLifecycleLog.firstAcceptedDataAt
    ? sessionLifecycleLog.firstAcceptedDataAt - sessionLifecycleLog.headerAcceptedAt
    : null;
  const timeFromLastUniqueToEnd = sessionLifecycleLog.endSeenAt && snapshot.lastUniquePacketAt
    ? sessionLifecycleLog.endSeenAt - snapshot.lastUniquePacketAt
    : null;
  const timeFromEndToFailure = sessionLifecycleLog.endSeenAt && sessionLifecycleLog.failureAt
    ? sessionLifecycleLog.failureAt - sessionLifecycleLog.endSeenAt
    : null;

  return [
    'FAIL SNAPSHOT',
    `transferId=${shortTransferId(snapshot.transferId)}`,
    `reason=${snapshot.error?.code ?? 'UNKNOWN'}`,
    `unique=${snapshot.receivedCount}/${snapshot.totalPackets ?? 0}`,
    `sampled=${decodeFunnelCounters.sampledFrames}`,
    `qrDetected=${decodeFunnelCounters.qrDetected}`,
    `acceptedUnique=${decodeFunnelCounters.acceptedUnique}`,
    `duplicateScanner=${decodeFunnelCounters.duplicateScannerRejected}`,
    `duplicatePacket=${decodeFunnelCounters.duplicatePacketRejected}`,
    `geometryRejected=${decodeFunnelCounters.geometryRejected}`,
    `protocolRejected=${decodeFunnelCounters.protocolMagicRejected}`,
    `parseRejected=${decodeFunnelCounters.parseRejected}`,
    `packetCrcRejected=${decodeFunnelCounters.packetCrcRejected}`,
    `foreignTransferRejected=${decodeFunnelCounters.foreignTransferRejected}`,
    `armingWindowRejected=${decodeFunnelCounters.armingWindowRejected}`,
    `avgSampleIntervalMs=${sampleAvg.toFixed(1)} p95SampleIntervalMs=${p95Sample} maxSampleIntervalMs=${Math.round(Math.max(0, ...runningStats.sampleIntervalsMs))}`,
    `avgDecodeMs=${decodeAvg.toFixed(1)} p95DecodeMs=${p95Decode} maxDecodeMs=${Math.round(Math.max(0, ...runningStats.decodeDurationsMs))}`,
    `queueDepthMax=${ingest.queueDepthMax} queueWaitAvgMs=${ingest.queueWaitAvgMs.toFixed(1)} queueWaitP95Ms=${ingest.queueWaitP95Ms}`,
    `ingestDurationAvgMs=${ingest.ingestDurationAvgMs.toFixed(1)} ingestDurationP95Ms=${ingest.ingestDurationP95Ms}`,
    `headerAcceptedAt=${sessionLifecycleLog.headerAcceptedAt} headerRepeatedCount=${sessionLifecycleLog.headerRepeatedCount}`,
    `firstAcceptedDataIndex=${sessionLifecycleLog.firstAcceptedDataIndex} firstAcceptedDataAt=${sessionLifecycleLog.firstAcceptedDataAt}`,
    `endSeenAt=${sessionLifecycleLog.endSeenAt} failureAt=${sessionLifecycleLog.failureAt}`,
    `timeToHeaderLock=${timeToHeaderLock} timeFromHeaderToFirstData=${timeFromHeaderToFirstData} timeFromLastUniqueToEnd=${timeFromLastUniqueToEnd} timeFromEndToFailure=${timeFromEndToFailure}`,
    `duplicatesTopIndices=${summarizeTopDuplicateIndices()} longestDuplicateStreak=${runningStats.longestDuplicateStreak} beforeEnd=${runningStats.duplicateBeforeEnd} afterEnd=${runningStats.duplicateAfterEnd}`,
    `${summarizeMissingRangeStats(snapshot)} missingCount=${missingCount}`,
    `missingCountBeforeEnd=${sessionLifecycleLog.endSeenAt === null ? missingCount : 'n/a'} missingCountAfterEndGrace=${sessionLifecycleLog.endSeenAt !== null ? missingCount : 'n/a'}`
  ].join(' ');
}

function formatScanLoopDiagnostics(snapshot: ReceiverSnapshot): string {
  const ingest = receiverIngest.getDiagnostics();
  const dim = `${video.videoWidth || 0}x${video.videoHeight || 0}`;
  const decodeHitRate = scanLoopDiagnostics.decodeAttempts > 0
    ? Math.round((scanLoopDiagnostics.decodeHits / scanLoopDiagnostics.decodeAttempts) * 100)
    : 0;

  return [
    '--- Receiver Debug Summary ---',
    `state=${snapshot.state} lockConfirmed=${snapshot.lockConfirmed} transferId=${shortTransferId(snapshot.transferId)}`,
    `received=${snapshot.receivedCount}/${snapshot.totalPackets ?? 0} missingRanges=${formatMissingRanges(snapshot, 8)}`,
    `cameraReadyState=${video.readyState} video=${dim}`,
    `loopTicks=${scanLoopDiagnostics.loopTicks} throttled=${scanLoopDiagnostics.throttledTicks} lagSpikes=${scanLoopDiagnostics.lagSpikes} maxLoopDeltaMs=${scanLoopDiagnostics.maxLoopDeltaMs}`,
    `decodeAttempts=${scanLoopDiagnostics.decodeAttempts} hits=${scanLoopDiagnostics.decodeHits} hitRate=${decodeHitRate}% noQrFound=${scanLoopDiagnostics.noQrFound} geometryRejected=${scanLoopDiagnostics.geometryRejected}` ,
    `funnel sampled=${decodeFunnelCounters.sampledFrames} noQr=${decodeFunnelCounters.noQrDetected} qrDetected=${decodeFunnelCounters.qrDetected} geometryRejected=${decodeFunnelCounters.geometryRejected} protocolMagicRejected=${decodeFunnelCounters.protocolMagicRejected} parseRejected=${decodeFunnelCounters.parseRejected} armingWindowRejected=${decodeFunnelCounters.armingWindowRejected} foreignTransferRejected=${decodeFunnelCounters.foreignTransferRejected} packetCrcRejected=${decodeFunnelCounters.packetCrcRejected} duplicateScannerRejected=${decodeFunnelCounters.duplicateScannerRejected} duplicatePacketRejected=${decodeFunnelCounters.duplicatePacketRejected} acceptedUnique=${decodeFunnelCounters.acceptedUnique}`,
    `cadence sampleAttemptCount=${runningStats.sampleAttemptCount} avgSampleIntervalMs=${average(runningStats.sampleIntervalsMs).toFixed(1)} p95SampleIntervalMs=${percentile(runningStats.sampleIntervalsMs, 0.95)} maxSampleIntervalMs=${Math.round(Math.max(0, ...runningStats.sampleIntervalsMs))}` ,
    `decodeDurationAvgMs=${average(runningStats.decodeDurationsMs).toFixed(1)} decodeDurationP95Ms=${percentile(runningStats.decodeDurationsMs, 0.95)} decodeDurationMaxMs=${Math.round(Math.max(0, ...runningStats.decodeDurationsMs))} slowDecodeFrames=${scanLoopDiagnostics.slowDecodeFrames}` ,
    `ingest: acceptedFrames=${ingest.acceptedFrames} acceptedUniquePackets=${ingest.acceptedUniquePackets} duplicateProtocolPackets=${ingest.duplicateProtocolPackets} duplicateScannerPayloads=${ingest.duplicateScannerPayloads} droppedQueued=${ingest.droppedQueuedPayloads} foreignTransferFrames=${ingest.foreignTransferFrames} badPacketCrcFrames=${ingest.badPacketCrcFrames} malformed=${ingest.malformedPayloads} queueDepthMax=${ingest.queueDepthMax} queueWaitAvgMs=${ingest.queueWaitAvgMs.toFixed(1)} queueWaitP95Ms=${ingest.queueWaitP95Ms} ingestDurationAvgMs=${ingest.ingestDurationAvgMs.toFixed(1)} ingestDurationP95Ms=${ingest.ingestDurationP95Ms} overflowDup=${ingest.overflowDropsDuplicate} overflowNonDup=${ingest.overflowDropsNonDuplicate}`,
    '--- Receiver Event Timeline ---'
  ].join('\n');
}

function appendDebugEvent(message: string, force = false): void {
  if (isSessionPaused && !force) return;
  const timestamp = new Date().toLocaleTimeString();
  debugEventLines.push(`[${timestamp}] ${message}`);
  if (debugEventLines.length > DEBUG_EVENT_LOG_CAP) {
    debugEventLines.splice(0, debugEventLines.length - DEBUG_EVENT_LOG_CAP);
  }
  if (debugLogEnabled) {
    debugLogOutput.textContent = debugEventLines.join('\n');
  }
}


function logGapEvent(event: {
  type: 'gap_detected' | 'gap_filled' | 'gap_lost';
  streamId: string;
  expectedSeq: number;
  receivedSeq: number;
  gapSize: number;
  permanentlyLost: boolean;
}): void {
  console.info('[receiver.gap]', {
    streamId: event.streamId,
    expectedSeq: event.expectedSeq,
    receivedSeq: event.receivedSeq,
    gapSize: event.gapSize,
    event: event.type,
    status: event.permanentlyLost ? 'permanently_lost' : event.type === 'gap_filled' ? 'filled' : 'open'
  });
}

const receiverMachine = new ReceiverMachine({ onGapEvent: logGapEvent });
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
      appendDebugEvent(`Frame accepted: (${shortTransferId(event.tuple.sessionId)}, ${event.tuple.streamId}, ${event.tuple.seq})`);
      runningStats.duplicateStreak = 0;
      if (event.frame.frameType === FRAME_TYPE_HEADER) {
        if (sessionLifecycleLog.headerAcceptedAt === null) {
          sessionLifecycleLog.headerAcceptedAt = Date.now();
        } else {
          sessionLifecycleLog.headerRepeatedCount += 1;
        }
      }
      if (event.frame.frameType === FRAME_TYPE_DATA) {
        if (event.snapshot.receivedCount > previousAcceptedReceivedCount) {
          if (sessionLifecycleLog.firstAcceptedDataAt === null) {
            sessionLifecycleLog.firstAcceptedDataAt = Date.now();
            sessionLifecycleLog.firstAcceptedDataIndex = event.tuple.seq;
          }
          decodeFunnelCounters.acceptedUnique += 1;
          runningStats.duplicateStreak = 0;
        } else {
          decodeFunnelCounters.duplicatePacketRejected += 1;
          trackDuplicatePacket(event.tuple.seq);
        }
        previousAcceptedReceivedCount = event.snapshot.receivedCount;
      }
      if (event.frame.frameType === FRAME_TYPE_END) {
        sessionLifecycleLog.endSeenAt = Date.now();
      }
      return;
    }

    if (event.type === 'frameDropped') {
      if (event.reason === 'foreignTransferFrame') decodeFunnelCounters.foreignTransferRejected += 1;
      if (event.reason === 'duplicateScannerPayload') decodeFunnelCounters.duplicateScannerRejected += 1;
      const tupleLabel = event.tuple ? `(${shortTransferId(event.tuple.sessionId)}, ${event.tuple.streamId}, ${event.tuple.seq})` : '(no-frame)';
      appendDebugEvent(`Frame dropped (${event.reason}): ${tupleLabel}`);
      return;
    }

    if (event.type === 'duplicateScannerPayload') {
      decodeFunnelCounters.duplicateScannerRejected += 1;
      appendDebugEvent('Duplicate scanner payload dropped');
      return;
    }

    if (event.type === 'foreignFrameIgnored') {
      appendDebugEvent('Foreign transfer frame ignored');
      return;
    }

    if (event.type === 'badPacketCrcIgnored') {
      decodeFunnelCounters.packetCrcRejected += 1;
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
    progressText.textContent = 'Searching for transfer header';
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
  scanStatsEl.textContent = `Received ${snapshot.totalScans} scans → ${received} unique packets • acceptedFrames:${diagnostics.acceptedFrames} acceptedUniquePackets:${diagnostics.acceptedUniquePackets} duplicateProtocolPackets:${diagnostics.duplicateProtocolPackets} duplicateScannerPayloads:${diagnostics.duplicateScannerPayloads}`;

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
  statusEl.textContent = isSessionPaused ? `${label} (paused)` : label;
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


function getLockedTransferActivityAt(snapshot: ReceiverSnapshot): number | null {
  if (!snapshot.lockConfirmed) return null;
  if (snapshot.lastMatchingFrameAt !== null) return snapshot.lastMatchingFrameAt;
  if (snapshot.lastLockedTransferFrameAt !== null) return snapshot.lastLockedTransferFrameAt;
  return snapshot.lastUniquePacketAt;
}

function formatDiagnosticsContext(): string {
  const diagnostics = receiverIngest.getDiagnostics();
  if (diagnostics.foreignTransferFrames > 0) {
    return `Detected ${diagnostics.foreignTransferFrames} foreign frames; keep one sender QR visible.`;
  }
  if (diagnostics.badPacketCrcFrames > 0) {
    return `Detected ${diagnostics.badPacketCrcFrames} CRC failures; reduce blur/glare and hold devices steady.`;
  }
  if (diagnostics.malformedPayloads > 0 || diagnostics.nonProtocolPayloads > 0) {
    return 'Camera is seeing non-protocol/invalid payloads; tighten framing and improve lighting.';
  }
  if (diagnostics.duplicateScannerPayloads > 0) {
    return 'Mostly duplicate frames are being read; slow sender pace or increase frame dwell.';
  }
  return 'No ingest anomalies detected; likely true sender/visibility stall.';
}

function applySnapshot(snapshot: ReceiverSnapshot): void {
  updateProgress(snapshot);
  const transferDetails = snapshot.fileName && snapshot.totalPackets !== null && snapshot.expectedFileSize !== null
    ? `${snapshot.fileName} • ${snapshot.expectedFileSize} bytes • ${snapshot.totalPackets} packets`
    : '';

  if (snapshot.state === 'IDLE') {
    setStage('IDLE', 'Ready to scan');
    lockStatusEl.textContent = 'Waiting for initial QR';
    lastPacketEl.textContent = '';
    return;
  }

  if (snapshot.state === 'SCANNING') {
    setStage('SCANNING', 'Searching for transfer header');
    lockStatusEl.textContent = snapshot.transferId
      ? `Locked to transfer ${shortTransferId(snapshot.transferId)}${transferDetails ? ` • ${transferDetails}` : ''}`
      : snapshot.headerConfirmations > 0
        ? `Searching for transfer header (${snapshot.headerConfirmations}/${RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS} confirmations)`
        : 'Waiting for initial QR';
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
    : 'Waiting for initial QR';
  setStage('ERROR', 'Transfer error');
  const diagnosticsContext = formatDiagnosticsContext();
  if (code === RECEIVER_ERROR_CODES.NO_PROGRESS_TIMEOUT) {
    warningEl.textContent = `Locked transfer stalled with no unique progress before timeout. ${diagnosticsContext}`;
  } else if (code === RECEIVER_ERROR_CODES.END_INCOMPLETE) {
    const missing = formatMissingRanges(snapshot);
    warningEl.textContent = `END arrived before all packets were received (missing packet indices: ${missing}). Restart sender, increase redundancy, and keep sender visible until completion.`;
  } else if (code === RECEIVER_ERROR_CODES.HEADER_CONFLICT) {
    warningEl.textContent = 'Header conflict: another transfer stream was detected. Keep only one sender QR visible and retry.';
  } else if (code === RECEIVER_ERROR_CODES.FILE_CRC_MISMATCH) {
    warningEl.textContent = 'Corruption detected (CRC mismatch), often caused by motion blur or glare. Retry with steadier framing/slower settings.';
  } else if (code === RECEIVER_ERROR_CODES.FILE_SIZE_MISMATCH || code === RECEIVER_ERROR_CODES.MISSING_PACKET) {
    warningEl.textContent = 'Packet loss detected (missing/size mismatch). Retry with slower pace and higher redundancy settings.';
  } else {
    warningEl.textContent = snapshot.error?.message ?? 'Transfer failed. Restart sender and retry.';
  }
  sessionLifecycleLog.failureAt = Date.now();
  appendDebugEvent(`Transfer failed: ${code ?? 'UNKNOWN'}${snapshot.error?.message ? ` (${snapshot.error.message})` : ''}`);
  appendDebugEvent(buildFailureSnapshot(snapshot), true);
  stopScanLoop(true);
  scanButton.textContent = 'Restart Scan';
}

function resetUiForNewScan(): void {
  receiverMachine.startScanning();
  receiverIngest.reset();
  revokeDownloadUrl();
  downloadButton.disabled = true;
  warningEl.textContent = '';
  isSessionPaused = false;
  pauseSessionButton.textContent = 'Pause Session';
  ingestDecodeError = null;
  successSoundPlayed = false;
  lastPacketEl.textContent = '';
  lastDiscoveryActivityAt = Date.now();
  lastProtocolFrameSeenAt = 0;
  previousDiscoveryScanCount = 0;
  lastReceivedTimeEl.textContent = 'Last packet: -';
  stableGeometryCount = 0;
  lastGeometry = null;
  lockStatusEl.textContent = 'Waiting for initial QR';
  progressHealthEl.textContent = 'Progress health: waiting for initial QR…';
  diagnosticHintEl.textContent = 'Diagnostics: waiting for scan data.';
  debugEventLines.length = 0;
  decodeFunnelCounters = { sampledFrames: 0, noQrDetected: 0, qrDetected: 0, geometryRejected: 0, protocolMagicRejected: 0, parseRejected: 0, armingWindowRejected: 0, foreignTransferRejected: 0, packetCrcRejected: 0, duplicateScannerRejected: 0, duplicatePacketRejected: 0, acceptedUnique: 0 };
  sessionLifecycleLog = { scanStartedAt: Date.now(), headerAcceptedAt: null, headerRepeatedCount: 0, firstAcceptedDataIndex: null, firstAcceptedDataAt: null, endSeenAt: null, failureAt: null };
  runningStats = { sampleIntervalsMs: [], decodeDurationsMs: [], sampleAttemptCount: 0, longestDuplicateStreak: 0, duplicateStreak: 0, duplicateBeforeEnd: 0, duplicateAfterEnd: 0 };
  duplicatePacketHistogram.clear();
  lastSampleAttemptAtMs = 0;
  previousAcceptedReceivedCount = 0;
  scanLoopDiagnostics = {
    loopTicks: 0,
    throttledTicks: 0,
    lagSpikes: 0,
    maxLoopDeltaMs: 0,
    decodeAttempts: 0,
    decodeHits: 0,
    noQrFound: 0,
    geometryRejected: 0,
    protocolMagicRejected: 0,
    parseRejected: 0,
    enqueueCalls: 0,
    snapshotUpdates: 0,
    slowDecodeFrames: 0,
    maxDecodeMs: 0,
    lastLoopAtMs: null
  };
  debugLogOutput.textContent = 'No events yet.';
  appendDebugEvent('Scan started');
  applySnapshot(receiverMachine.snapshot);
}

function processFrame(now: number): void {
  scanLoopDiagnostics.loopTicks += 1;
  if (scanLoopDiagnostics.lastLoopAtMs !== null) {
    const loopDelta = now - scanLoopDiagnostics.lastLoopAtMs;
    scanLoopDiagnostics.maxLoopDeltaMs = Math.max(scanLoopDiagnostics.maxLoopDeltaMs, Math.round(loopDelta));
    if (loopDelta > SCAN_LOOP_LAG_THRESHOLD_MS) {
      scanLoopDiagnostics.lagSpikes += 1;
      appendDebugEvent(`Scan loop lag spike: ${Math.round(loopDelta)}ms`);
    }
  }
  scanLoopDiagnostics.lastLoopAtMs = now;

  if (isSessionPaused) {
    rafId = requestAnimationFrame(processFrame);
    return;
  }

  if (!video.videoWidth || !video.videoHeight) {
    rafId = requestAnimationFrame(processFrame);
    return;
  }

  const scanIntervalMs = selectScanIntervalMs(receiverMachine.snapshot.lockConfirmed);
  if (now - lastScanAt < scanIntervalMs) {
    scanLoopDiagnostics.throttledTicks += 1;
    rafId = requestAnimationFrame(processFrame);
    return;
  }

  lastScanAt = now;
  recordSampleInterval(now);
  decodeFunnelCounters.sampledFrames += 1;
  const decodeStartedAt = performance.now();
  frameCanvas.width = video.videoWidth;
  frameCanvas.height = video.videoHeight;
  frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
  const image = frameContext.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
  scanLoopDiagnostics.decodeAttempts += 1;
  const result = jsQR(image.data, image.width, image.height);
  const decodeElapsedMs = Math.round(performance.now() - decodeStartedAt);
  runningStats.decodeDurationsMs.push(decodeElapsedMs);
  scanLoopDiagnostics.maxDecodeMs = Math.max(scanLoopDiagnostics.maxDecodeMs, decodeElapsedMs);
  if (decodeElapsedMs > SLOW_QR_DECODE_THRESHOLD_MS) {
    scanLoopDiagnostics.slowDecodeFrames += 1;
  }

  if (!result?.binaryData?.length) {
    scanLoopDiagnostics.noQrFound += 1;
    decodeFunnelCounters.noQrDetected += 1;
    rafId = requestAnimationFrame(processFrame);
    return;
  }

  scanLoopDiagnostics.decodeHits += 1;
  decodeFunnelCounters.qrDetected += 1;
  {
    const nowMs = Date.now();
    const rawPayload = Uint8Array.from(result.binaryData);
    if (!isProtocolPayload(rawPayload)) {
      scanLoopDiagnostics.protocolMagicRejected += 1;
      decodeFunnelCounters.protocolMagicRejected += 1;
      maybeLogCounterMilestone('Protocol magic-rejected QR payloads', scanLoopDiagnostics.protocolMagicRejected, 5);
      rafId = requestAnimationFrame(processFrame);
      return;
    }

    let parsedFrame: ReturnType<typeof parseFrame>;
    try {
      parsedFrame = parseFrame(rawPayload);
    } catch {
      scanLoopDiagnostics.parseRejected += 1;
      decodeFunnelCounters.parseRejected += 1;
      maybeLogCounterMilestone('Protocol parse rejections', scanLoopDiagnostics.parseRejected, 3);
      rafId = requestAnimationFrame(processFrame);
      return;
    }

    const geometryDecision = shouldProcessParsedFrameWithGeometry(hasStableQrGeometry(result, image.width, image.height));
    if (geometryDecision.geometryRejected) {
      scanLoopDiagnostics.geometryRejected += 1;
      decodeFunnelCounters.geometryRejected += 1;
      maybeLogCounterMilestone('Geometry-rejected QR detections', scanLoopDiagnostics.geometryRejected, 5);
    }

    lastProtocolFrameSeenAt = nowMs;

    if (geometryDecision.shouldProcess) {
      const machineSnapshot = receiverMachine.snapshot;
      if (!machineSnapshot.lockConfirmed && parsedFrame.frameType !== FRAME_TYPE_HEADER) {
        decodeFunnelCounters.armingWindowRejected += 1;
        rafId = requestAnimationFrame(processFrame);
        return;
      }
      scanLoopDiagnostics.enqueueCalls += 1;
      void receiverIngest.enqueue(rawPayload, nowMs, parsedFrame).then((snapshot) => {
        if (snapshot) {
          scanLoopDiagnostics.snapshotUpdates += 1;
          applySnapshot(snapshot);
        } else if (ingestDecodeError) {
          warningEl.textContent = `Decode error: ${ingestDecodeError}`;
        }
      });
    }
  }

  rafId = requestAnimationFrame(processFrame);
}

function updateSignalHealth(): void {
  const now = Date.now();
  const snapshot = receiverMachine.tick(now);
  applySnapshot(snapshot);

  if (isSessionPaused) {
    progressHealthEl.textContent = 'Progress health: paused (logging frozen)';
    return;
  }

  const lockedActivityAt = getLockedTransferActivityAt(snapshot);
  const diagnostics = receiverIngest.getDiagnostics();

  if (!snapshot.lockConfirmed) {
    if (snapshot.totalScans > previousDiscoveryScanCount) {
      previousDiscoveryScanCount = snapshot.totalScans;
      lastDiscoveryActivityAt = now;
    }

    const scanReference = snapshot.scanStartedAt ?? scanStartedAt;
    const discoveryReference = Math.max(lastDiscoveryActivityAt, lastProtocolFrameSeenAt, scanReference);
    const discoveryAgeSeconds = discoveryReference > 0 ? Math.max(0, Math.floor((now - discoveryReference) / 1000)) : null;

    progressHealthEl.textContent = discoveryAgeSeconds === null
      ? 'Progress health: waiting for initial QR…'
      : `Progress health: searching for transfer header (${snapshot.headerConfirmations}/${RECEIVER_LOCK_CONFIRMATION.REQUIRED_HEADERS} header confirmations, ${discoveryAgeSeconds}s since last protocol frame)`;

    warningEl.textContent = snapshot.headerConfirmations > 0
      ? 'Searching for transfer header… keep sender QR centered and steady.'
      : 'Waiting for initial QR… align sender QR inside the frame.';

    lastReceivedTimeEl.textContent = discoveryReference > 0
      ? `Last packet: ${new Date(discoveryReference).toLocaleTimeString()}`
      : 'Last packet: -';
    return;
  }

  const uniqueReference = snapshot.lastUniquePacketAt ?? snapshot.headerLockedAt ?? snapshot.scanStartedAt ?? scanStartedAt;
  const sinceLastUniqueSeconds = uniqueReference > 0 ? Math.max(0, Math.floor((now - uniqueReference) / 1000)) : null;

  let timeoutText = 'Progress timeout inactive';
  if (snapshot.lastUniquePacketAt) {
    const uniqueRemainingMs = Math.max(0, RECEIVER_TIMEOUTS.NO_UNIQUE_PROGRESS_TIMEOUT_MS - (now - snapshot.lastUniquePacketAt));
    const activityRemainingMs = snapshot.lastMatchingFrameAt === null
      ? 0
      : Math.max(0, RECEIVER_TIMEOUTS.LOCKED_TRANSFER_ACTIVITY_GRACE_MS - (now - snapshot.lastMatchingFrameAt));
    const uniqueRemainingSeconds = Math.ceil(uniqueRemainingMs / 1000);
    const activityRemainingSeconds = Math.ceil(activityRemainingMs / 1000);
    timeoutText = `no-progress in ${uniqueRemainingSeconds}s (locked-activity grace ${activityRemainingSeconds}s)`;
    if (uniqueRemainingSeconds <= 5 && sinceLastUniqueSeconds !== null) {
      warningEl.textContent = `No new unique packets for ${sinceLastUniqueSeconds}s. Timeout requires activity silence too (${activityRemainingSeconds}s grace left).`;
    }
  }

  progressHealthEl.textContent = sinceLastUniqueSeconds === null
    ? `Progress health: waiting for first unique packet • ${timeoutText}`
    : `Progress health: ${sinceLastUniqueSeconds}s since last unique packet • ${timeoutText}`;

  const postLockReference = lockedActivityAt ?? uniqueReference;
  lastReceivedTimeEl.textContent = postLockReference && postLockReference > 0
    ? `Last packet: ${new Date(postLockReference).toLocaleTimeString()}`
    : 'Last packet: -';

  const canShowLockedSignalLoss = (snapshot.state === 'RECEIVING' || snapshot.state === 'VERIFYING') && Boolean(snapshot.transferId);
  if (canShowLockedSignalLoss && postLockReference > 0 && now - postLockReference > SIGNAL_LOST_MS) {
    warningEl.textContent = `Signal Lost - Locked transfer has no frame activity for ${Math.floor((now - postLockReference) / 1000)}s. ${formatDiagnosticsContext()} (dup:${diagnostics.duplicateScannerPayloads} foreign:${diagnostics.foreignTransferFrames} badCrc:${diagnostics.badPacketCrcFrames} malformed:${diagnostics.malformedPayloads})`;
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
    setStage('SCANNING', 'Waiting for initial QR');
    lockStatusEl.textContent = 'Waiting for initial QR';
    lastScanAt = 0;
    scanStartedAt = Date.now();
    isSessionPaused = false;
    pauseSessionButton.textContent = 'Pause Session';
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
    isSessionPaused = false;
    pauseSessionButton.textContent = 'Pause Session';
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


pauseSessionButton.addEventListener('click', () => {
  isSessionPaused = !isSessionPaused;
  pauseSessionButton.textContent = isSessionPaused ? 'Resume Session' : 'Pause Session';
  appendDebugEvent(isSessionPaused ? 'Session paused: ingest/logging frozen' : 'Session resumed', true);
  if (isSessionPaused) {
    warningEl.textContent = 'Session paused. Logging is frozen until resumed.';
  } else if (warningEl.textContent.includes('Session paused')) {
    warningEl.textContent = '';
  }
  applySnapshot(receiverMachine.snapshot);
});

copyEventsButton.addEventListener('click', async () => {
  const summary = formatScanLoopDiagnostics(receiverMachine.snapshot);
  const timeline = debugEventLines.length > 0 ? debugEventLines.join('\n') : 'No events yet.';
  const report = `${summary}\n${timeline}`;
  localStorage.setItem(RECEIVER_LOG_CACHE_KEY, report);
  try {
    await navigator.clipboard.writeText(report);
    warningEl.textContent = `Copied ${debugEventLines.length} receiver timeline event${debugEventLines.length === 1 ? '' : 's'} to clipboard and cached locally.`;
  } catch {
    warningEl.textContent = 'Log data cached locally, but clipboard copy was blocked by the browser.';
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
