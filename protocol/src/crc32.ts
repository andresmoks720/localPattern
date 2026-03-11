const CRC32_POLYNOMIAL = 0xedb88320;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ CRC32_POLYNOMIAL : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function calculateCRC32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (let i = 0; i < data.length; i += 1) {
    const tableIndex = (crc ^ data[i]) & 0xff;
    crc = (crc >>> 8) ^ CRC32_TABLE[tableIndex];
  }

  return (crc ^ 0xffffffff) >>> 0;
}
