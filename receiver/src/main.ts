import './style.css';
import jsQR from 'jsqr';
import { parsePacket } from '@qr-data-bridge/protocol';

const QR_PREFIX = 'QDB64:';

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toHexSnippet(bytes: Uint8Array, maxBytes = 24): string {
  return Array.from(bytes.slice(0, maxBytes), (value) => value.toString(16).padStart(2, '0')).join(' ');
}

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
}

const app = getElement<HTMLDivElement>('#app');

app.innerHTML = `
  <main class="layout">
    <section class="stage">
      <video id="camera-preview" autoplay muted playsinline></video>
    </section>
    <aside class="panel">
      <button id="scan-btn" type="button">Start Scan</button>
      <div id="status" class="status">Waiting for packets...</div>
      <a id="download-link" href="#" aria-disabled="true">Download placeholder</a>
      <div class="hint">Ensure camera is focused and hold steady.</div>
      <div id="last-packet"></div>
    </aside>
  </main>
`;

const scanButton = getElement<HTMLButtonElement>('#scan-btn');
const statusEl = getElement<HTMLDivElement>('#status');
const video = getElement<HTMLVideoElement>('#camera-preview');
const lastPacketEl = getElement<HTMLDivElement>('#last-packet');

const frameCanvas = document.createElement('canvas');
const context = frameCanvas.getContext('2d', { willReadFrequently: true });
if (!context) {
  throw new Error('Failed to initialize frame canvas context.');
}
const frameContext = context;

let rafId = 0;
let frameCount = 0;
let activeStream: MediaStream | null = null;
let lastDecodedPayload = '';

function stopScanLoop(): void {
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function scanLoop(): void {
  if (!video.videoWidth || !video.videoHeight) {
    rafId = requestAnimationFrame(scanLoop);
    return;
  }

  frameCount += 1;
  if (frameCount % 3 === 0) {
    frameCanvas.width = video.videoWidth;
    frameCanvas.height = video.videoHeight;
    frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    const image = frameContext.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
    const result = jsQR(image.data, image.width, image.height);

    if (result?.data && result.data.startsWith(QR_PREFIX) && result.data !== lastDecodedPayload) {
      lastDecodedPayload = result.data;
      try {
        const bytes = base64ToBytes(result.data.slice(QR_PREFIX.length));
        const packet = parsePacket(bytes);
        statusEl.textContent = 'Packet Received!';
        lastPacketEl.textContent = `Index ${packet.packetIndex + 1}/${packet.totalPackets} | CRC ok | ${toHexSnippet(bytes)}`;
        console.log('[receiver] packet decoded', {
          packetIndex: packet.packetIndex,
          checksumValid: true,
          checksum: packet.packetChecksum,
          hexSnippet: toHexSnippet(bytes)
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown packet decode error.';
        statusEl.textContent = 'Checksum Failed';
        lastPacketEl.textContent = message;
        console.error('[receiver] packet validation failed', message);
      }
    }
  }

  rafId = requestAnimationFrame(scanLoop);
}

scanButton.addEventListener('click', async () => {
  stopScanLoop();

  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }

  statusEl.textContent = 'Initializing Camera...';

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false
    });
    video.srcObject = activeStream;
    await video.play();
    statusEl.textContent = 'Scanning...';
    frameCount = 0;
    lastDecodedPayload = '';
    scanLoop();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Camera unavailable.';
    statusEl.textContent = `Camera access denied/unavailable: ${message}`;
  }
});

window.addEventListener('beforeunload', () => {
  stopScanLoop();
  activeStream?.getTracks().forEach((track) => track.stop());
});
