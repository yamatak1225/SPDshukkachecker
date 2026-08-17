"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ok.wavとcomplete.wavの中間に位置する、3音上昇の照合完了チャイム。
const sampleRate = 44100;
const channels = 2;
const durationSeconds = 0.76;
const sampleCount = Math.ceil(sampleRate * durationSeconds);
const left = new Float64Array(sampleCount);
const right = new Float64Array(sampleCount);

function addTone({ start, duration, frequency, volume, pan = 0 }) {
  const startSample = Math.floor(start * sampleRate);
  const endSample = Math.min(sampleCount, Math.ceil((start + duration) * sampleRate));
  const leftGain = Math.sqrt((1 - pan) / 2);
  const rightGain = Math.sqrt((1 + pan) / 2);
  for (let index = startSample; index < endSample; index += 1) {
    const time = (index - startSample) / sampleRate;
    const progress = time / duration;
    const attack = Math.min(1, time / 0.004);
    const decay = Math.exp(-2.5 * progress);
    const release = Math.min(1, (duration - time) / 0.035);
    const phase = 2 * Math.PI * frequency * time;
    const square = Math.sin(phase) >= 0 ? 1 : -1;
    const signal = (
      Math.sin(phase) * 0.58
      + square * 0.22
      + Math.sin(phase * 2) * 0.14
      + Math.sin(phase * 3) * 0.06
    ) * attack * decay * release * volume;
    left[index] += signal * leftGain;
    right[index] += signal * rightGain;
  }
}

// 既存成功音の880Hzへ3段階で上昇する。完了音の5段階より短く控えめにする。
addTone({ start: 0.00, duration: 0.24, frequency: 659, volume: 0.43, pan: -0.05 });
addTone({ start: 0.15, duration: 0.25, frequency: 784, volume: 0.46, pan: 0.00 });
addTone({ start: 0.31, duration: 0.39, frequency: 880, volume: 0.52, pan: 0.05 });
addTone({ start: 0.31, duration: 0.35, frequency: 440, volume: 0.07, pan: 0.00 });

let peak = 0;
for (let index = 0; index < sampleCount; index += 1) peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
const normalization = peak ? 0.66 / peak : 1;
const dataSize = sampleCount * channels * 2;
const wav = Buffer.alloc(44 + dataSize);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write("WAVE", 8);
wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * channels * 2, 28);
wav.writeUInt16LE(channels * 2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(dataSize, 40);
for (let index = 0; index < sampleCount; index += 1) {
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[index] * normalization)) * 32767), 44 + index * 4);
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[index] * normalization)) * 32767), 46 + index * 4);
}

const outputPath = path.resolve(__dirname, "..", "product-ok.wav");
fs.writeFileSync(outputPath, wav);
console.log(`${outputPath}\n${durationSeconds.toFixed(2)}秒 / 44.1kHz / stereo / 16bit PCM`);
