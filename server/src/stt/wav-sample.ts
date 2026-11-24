import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Builds a valid 16-bit PCM mono 16kHz WAV buffer containing quiet synthetic tone/silence. */
export function createSampleWav(durationSec = 20, sampleRate = 16000): Buffer {
  const numSamples = Math.max(1, Math.round(durationSec * sampleRate));
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  // Subtle 440Hz sine pulse in the first 2 seconds so VAD/whisper sees valid PCM samples
  const speechSamples = Math.min(numSamples, sampleRate * 2);
  for (let i = 0; i < speechSamples; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 1200);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

export function loadSttSampleWav(): { wav: Buffer; durationSec: number } {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, '..', '..', 'assets', 'stt-sample-id.wav'),
    path.resolve(process.cwd(), 'server', 'assets', 'stt-sample-id.wav'),
    path.resolve(process.cwd(), 'assets', 'stt-sample-id.wav'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const wav = fs.readFileSync(candidate);
      // Estimate duration for 16kHz 16-bit mono WAV if valid header
      const dataBytes = Math.max(0, wav.byteLength - 44);
      const durationSec = dataBytes > 0 ? Math.max(1, Math.round(dataBytes / (16000 * 2))) : 20;
      return { wav, durationSec };
    }
  }
  return { wav: createSampleWav(20, 16000), durationSec: 20 };
}
