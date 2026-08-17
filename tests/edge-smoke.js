"use strict";

const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const edgeCandidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];
const edgePath = edgeCandidates.find(fs.existsSync);
if (!edgePath) throw new Error("Microsoft Edgeが見つかりません。");

const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "spd-edge-"));
const screenshotPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
try {
  const pageUrl = pathToFileURL(path.resolve(__dirname, "..", "index.html")).href;
  const child = spawnSync(edgePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--window-size=390,844",
    "--disable-features=msEdgeFirstRunExperience",
    `--user-data-dir=${profilePath}`, "--dump-dom", pageUrl
  ], { encoding: "utf8", timeout: 20000, windowsHide: true });

  const dom = child.stdout || "";
  const result = {
    status: child.status,
    error: child.error?.code || null,
    domBytes: Buffer.byteLength(dom),
    title: dom.includes("<title>SPD出荷チェッカー</title>"),
    initialized: dom.includes('data-app-ready="true"'),
    periodInputs: dom.includes('id="targetStartDate"') && dom.includes('id="targetEndDate"'),
    departmentClear: dom.includes('id="clearDepartmentButton"'),
    compactModeStatus: dom.includes('id="modeStatus"'),
    pendingProductPanel: dom.includes('id="pendingProductPanel"'),
    skipControls: dom.includes('id="skipButton"') && dom.includes('id="cancelPendingButton"'),
    historyScreen: dom.includes('id="historySection"') && dom.includes('id="historyResult"'),
    pwaMetadata: dom.includes('rel="manifest"') && dom.includes('rel="apple-touch-icon"')
      && dom.includes('apple-mobile-web-app-capable'),
    manualModeButtonsAbsent: !dom.includes('id="containerModeButton"') && !dom.includes('id="spdModeButton"'),
    scannerReady: dom.includes("Bluetoothリーダー入力待機中")
  };
  console.log(JSON.stringify(result));
  if (!result.title || !result.initialized || !result.periodInputs || !result.departmentClear
    || !result.pendingProductPanel || !result.skipControls || !result.historyScreen || !result.pwaMetadata
    || !result.compactModeStatus || !result.manualModeButtonsAbsent || !result.scannerReady) process.exitCode = 1;

  if (screenshotPath) {
    const screenshot = spawnSync(edgePath, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--window-size=500,844", "--hide-scrollbars",
      "--disable-features=msEdgeFirstRunExperience",
      `--user-data-dir=${profilePath}`, `--screenshot=${screenshotPath}`, pageUrl
    ], { encoding: "utf8", timeout: 20000, windowsHide: true });
    if (screenshot.status !== 0 || !fs.existsSync(screenshotPath)) {
      console.error(screenshot.stderr || "390px画面のスクリーンショットを作成できませんでした。");
      process.exitCode = 1;
    }
  }
} finally {
  fs.rmSync(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
