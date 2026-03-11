import './style.css';
import QRCode from 'qrcode';
import { assemblePacket, chunkFile, type Packet } from '@qr-data-bridge/protocol';

const QR_PREFIX = 'QDB64:';
const QR_SIZE = 400;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
      <canvas id="qr-canvas" width="${QR_SIZE}" height="${QR_SIZE}" aria-label="QR packet output"></canvas>
    </section>
    <aside class="panel">
      <input id="file-input" type="file" />
      <button id="start-btn" type="button" disabled>Start Transmission</button>
      <button id="next-btn" type="button" disabled>Next Packet</button>
      <div id="file-meta">No file selected.</div>
      <div id="packet-meta">Packet: -</div>
      <small>Keep this screen bright and steady.</small>
      <div id="qr-text" class="mono"></div>
    </aside>
  </main>
`;

const fileInput = getElement<HTMLInputElement>('#file-input');
const fileMeta = getElement<HTMLDivElement>('#file-meta');
const packetMeta = getElement<HTMLDivElement>('#packet-meta');
const startButton = getElement<HTMLButtonElement>('#start-btn');
const nextButton = getElement<HTMLButtonElement>('#next-btn');
const qrCanvas = getElement<HTMLCanvasElement>('#qr-canvas');
const qrText = getElement<HTMLDivElement>('#qr-text');

let packets: Packet[] = [];
let currentPacketIndex = 0;

async function renderPacket(packetIndex: number): Promise<void> {
  const packet = packets[packetIndex];
  const packetBytes = assemblePacket(packet);
  const payload = `${QR_PREFIX}${bytesToBase64(packetBytes)}`;

  try {
    await QRCode.toCanvas(qrCanvas, payload, {
      errorCorrectionLevel: 'H',
      width: QR_SIZE,
      margin: 1
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown QR encoding error.';
    packetMeta.textContent = `QR encode failed: ${message}`;
    return;
  }

  packetMeta.textContent = `Packet ${packet.packetIndex + 1} of ${packet.totalPackets}`;
  qrText.textContent = `CRC32: ${packet.packetChecksum.toString(16)} | HEX: ${toHexSnippet(packetBytes)}`;
  console.log('[sender] packet', packet.packetIndex, {
    checksum: packet.packetChecksum,
    hexSnippet: toHexSnippet(packetBytes)
  });
}

fileInput.addEventListener('change', async () => {
  const selectedFile = fileInput.files?.[0];
  if (!selectedFile) {
    packets = [];
    fileMeta.textContent = 'No file selected.';
    packetMeta.textContent = 'Packet: -';
    startButton.disabled = true;
    nextButton.disabled = true;
    return;
  }

  const bytes = new Uint8Array(await selectedFile.arrayBuffer());
  packets = chunkFile(bytes);
  currentPacketIndex = 0;
  fileMeta.textContent = `${selectedFile.name} • ${selectedFile.size} bytes • ${packets.length} packets`;
  packetMeta.textContent = 'Ready to transmit.';
  startButton.disabled = false;
  nextButton.disabled = packets.length < 2;
});

startButton.addEventListener('click', async () => {
  if (packets.length === 0) {
    packetMeta.textContent = 'Choose a file first.';
    return;
  }
  currentPacketIndex = 0;
  await renderPacket(currentPacketIndex);
  nextButton.disabled = packets.length < 2;
});

nextButton.addEventListener('click', async () => {
  if (packets.length < 2) return;
  currentPacketIndex = (currentPacketIndex + 1) % packets.length;
  await renderPacket(currentPacketIndex);
});
