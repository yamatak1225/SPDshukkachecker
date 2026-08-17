"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readWave(filePath) {
  const buffer = fs.readFileSync(filePath);
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      format = {
        encoding: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14)
      };
    }
    if (id === "data") data = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !data || format.encoding !== 1 || format.bits !== 16) throw new Error(`${filePath}は解析対象外のWAV形式です。`);

  const frameCount = data.length / (format.channels * 2);
  const samples = new Float64Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      sum += data.readInt16LE((frame * format.channels + channel) * 2) / 32768;
    }
    samples[frame] = sum / format.channels;
  }
  return { ...format, samples, duration: frameCount / format.sampleRate };
}

function analyze(filePath) {
  const wave = readWave(filePath);
  let sumSquares = 0;
  let peak = 0;
  for (const sample of wave.samples) {
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }

  const frameSize = Math.round(wave.sampleRate * 0.04);
  const envelope = [];
  for (let start = 0; start < wave.samples.length; start += frameSize) {
    let squares = 0;
    const end = Math.min(wave.samples.length, start + frameSize);
    for (let index = start; index < end; index += 1) squares += wave.samples[index] ** 2;
    envelope.push(Math.sqrt(squares / (end - start)));
  }
  const loudestFrame = envelope.indexOf(Math.max(...envelope));
  const analysisStart = loudestFrame * frameSize;
  const analysisLength = Math.min(Math.round(wave.sampleRate * 0.16), wave.samples.length - analysisStart);
  const spectrum = [];
  for (let frequency = 150; frequency <= 2500; frequency += 10) {
    const omega = 2 * Math.PI * frequency / wave.sampleRate;
    const coefficient = 2 * Math.cos(omega);
    let previous = 0;
    let previous2 = 0;
    for (let index = 0; index < analysisLength; index += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, analysisLength - 1));
      const current = wave.samples[analysisStart + index] * window + coefficient * previous - previous2;
      previous2 = previous;
      previous = current;
    }
    const power = previous2 ** 2 + previous ** 2 - coefficient * previous * previous2;
    spectrum.push({ frequency, power });
  }
  spectrum.sort((a, b) => b.power - a.power);
  const peaks = [];
  for (const candidate of spectrum) {
    if (peaks.every((peakItem) => Math.abs(peakItem.frequency - candidate.frequency) >= 40)) peaks.push(candidate);
    if (peaks.length === 5) break;
  }

  return {
    file: path.basename(filePath), duration: Number(wave.duration.toFixed(3)),
    sampleRate: wave.sampleRate, channels: wave.channels,
    rms: Number(Math.sqrt(sumSquares / wave.samples.length).toFixed(3)),
    peak: Number(peak.toFixed(3)),
    prominentHz: peaks.map((item) => item.frequency)
  };
}

for (const name of ["ok.wav", "product-ok.wav", "alert.wav", "complete.wav"]) {
  console.log(JSON.stringify(analyze(path.resolve(__dirname, "..", name))));
}
