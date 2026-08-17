"use strict";

const fs = require("node:fs");
const path = require("node:path");

// 既存のok.wav・alert.wavと同じ44.1kHz／16bit／ステレオで生成する。
const sampleRate = 44100;
const channels = 2;
const durationSeconds = 1.15;
const sampleCount = Math.ceil(sampleRate * durationSeconds);
const left = new Float64Array(sampleCount);
const right = new Float64Array(sampleCount);

function addSystemChime({ start, duration, frequency, volume, pan = 0 }) {
  const startSample = Math.floor(start * sampleRate);
  const endSample = Math.min(sampleCount, Math.ceil((start + duration) * sampleRate));
  const leftGain = Math.sqrt((1 - pan) / 2);
  const rightGain = Math.sqrt((1 + pan) / 2);

  for (let index = startSample; index < endSample; index += 1) {
    const localTime = (index - startSample) / sampleRate;
    const progress = localTime / duration;
    const attack = Math.min(1, localTime / 0.004);
    const decay = Math.exp(-2.8 * progress);
    const release = Math.min(1, (duration - localTime) / 0.04);
    const envelope = attack * decay * release;
    const phase = 2 * Math.PI * frequency * localTime;

    // 矩形波系の倍音を加え、物流現場でも輪郭が分かる明瞭な電子チャイムにする。
    const square = Math.sin(phase) >= 0 ? 1 : -1;
    const value = (
      Math.sin(phase) * 0.50
      + square * 0.28
      + Math.sin(phase * 2) * 0.15
      + Math.sin(phase * 3) * 0.07
    ) * envelope * volume;

    left[index] += value * leftGain;
    right[index] += value * rightGain;
  }
}

// 短い4段階の上昇音から成功音の主成分880Hzへ着地する、5音の業務用完了チャイム。
addSystemChime({ start: 0.00, duration: 0.23, frequency: 587, volume: 0.39, pan: -0.08 });
addSystemChime({ start: 0.13, duration: 0.23, frequency: 660, volume: 0.41, pan: -0.04 });
addSystemChime({ start: 0.26, duration: 0.23, frequency: 740, volume: 0.43, pan: 0.00 });
addSystemChime({ start: 0.39, duration: 0.25, frequency: 831, volume: 0.45, pan: 0.04 });
addSystemChime({ start: 0.55, duration: 0.52, frequency: 880, volume: 0.56, pan: 0.08 });
// 最終音に薄い低音を重ね、音数が増えても甲高くなりすぎないようにする。
addSystemChime({ start: 0.55, duration: 0.48, frequency: 440, volume: 0.10, pan: 0 });

let peak = 0;
for (let index = 0; index < sampleCount; index += 1) {
  peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
}
const normalization = peak > 0 ? 0.70 / peak : 1;

const dataSize = sampleCount * channels * 2;
const wav = Buffer.alloc(44 + dataSize);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + dataSize, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(channels, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * channels * 2, 28);
wav.writeUInt16LE(channels * 2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(dataSize, 40);

for (let index = 0; index < sampleCount; index += 1) {
  const leftValue = Math.max(-1, Math.min(1, left[index] * normalization));
  const rightValue = Math.max(-1, Math.min(1, right[index] * normalization));
  wav.writeInt16LE(Math.round(leftValue * 32767), 44 + index * 4);
  wav.writeInt16LE(Math.round(rightValue * 32767), 46 + index * 4);
}

const outputPath = path.resolve(__dirname, "..", "complete.wav");
fs.writeFileSync(outputPath, wav);
console.log(`${outputPath}\n${durationSeconds.toFixed(2)}秒 / 44.1kHz / stereo / 16bit PCM`);
