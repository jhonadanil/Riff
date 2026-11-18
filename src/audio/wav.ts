/** Codifica un AudioBuffer como WAV PCM de 16 o 24 bits. */
export function encodeWav(buffer: AudioBuffer, bitDepth: 16 | 24 = 24): Uint8Array {
  const channels = buffer.numberOfChannels;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = buffer.length * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // tamaño del bloque fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  const max = 2 ** (bitDepth - 1) - 1;
  let o = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.round(Math.max(-1, Math.min(1, data[c][i])) * max);
      if (bitDepth === 16) {
        view.setInt16(o, v, true);
      } else {
        view.setUint8(o, v & 0xff);
        view.setUint8(o + 1, (v >> 8) & 0xff);
        view.setUint8(o + 2, (v >> 16) & 0xff);
      }
      o += bytesPerSample;
    }
  }
  return new Uint8Array(out);
}
