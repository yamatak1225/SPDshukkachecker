"use strict";

const STORAGE_KEYS = {
  master: "spd-shipping-master-v1",
  state: "spd-shipping-state-v1"
};

const REQUIRED_HEADERS = [
  "施設コード", "施設名称", "部署コード", "部署名称", "品名",
  "ラベルキー", "払出予定伝票日付"
];

// 実際のラベルマスタ.tsvで確認した製品番号列の見出し名。
const PRODUCT_NUMBER_HEADER = "製品番号";

const state = {
  masterRows: [],
  masterInfo: null,
  labelIndex: new Map(),
  departmentIndex: new Map(),
  readLabelKeys: new Set(),
  history: [],
  targetStartDate: "",
  targetEndDate: "",
  currentDepartment: null,
  mode: "container",
  scannerBuffer: "",
  scannerTimer: null
};

let successSound = null;
let alertSound = null;
let completionSound = null;
let elements = {};

function normalizeHeader(value) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function normalizeValue(value) {
  return String(value ?? "").trim();
}

// 引用符付きセル、セル内タブ・改行も壊さずにTSVを分解する。
function splitTsvRecords(text) {
  const records = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === "\t") {
      row.push(cell);
      cell = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) records.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (quoted) throw new Error("TSV内の引用符が閉じられていません。");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value !== "")) records.push(row);
  }
  return records;
}

function isValidDateKey(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function normalizeLabelKey(value) {
  return normalizeValue(value).replace(/\s+/g, "");
}

function getProductNumber(row) {
  return normalizeValue(row?.[PRODUCT_NUMBER_HEADER]) || "―";
}

function parseTsv(text) {
  const records = splitTsvRecords(String(text ?? "").replace(/^\uFEFF/, ""));
  if (records.length < 2) throw new Error("TSVに見出し行またはデータ行がありません。");

  const headers = records[0].map(normalizeHeader);
  const duplicateHeaders = headers.filter((header, index) => header && headers.indexOf(header) !== index);
  if (duplicateHeaders.length > 0) {
    throw new Error(`同じ見出しが複数あります：${[...new Set(duplicateHeaders)].join("、")}`);
  }

  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missingHeaders.length > 0) {
    throw new Error(`必須列がありません：${missingHeaders.join("、")}`);
  }

  const column = Object.fromEntries(headers.map((header, index) => [header, index]));
  const rows = [];
  const errors = [];

  records.slice(1).forEach((record, recordIndex) => {
    const lineNumber = recordIndex + 2;
    if (record.length > headers.length && record.slice(headers.length).some((value) => normalizeValue(value) !== "")) {
      errors.push(`${lineNumber}行目：見出し数を超えるデータがあります。`);
      return;
    }
    const row = {};
    headers.forEach((header, index) => { if (header) row[header] = normalizeValue(record[index]); });

    const emptyFields = REQUIRED_HEADERS.filter((header) => !row[header]);
    if (emptyFields.length > 0) {
      errors.push(`${lineNumber}行目：必須項目が空欄です（${emptyFields.join("、")}）。`);
      return;
    }
    if (!isValidDateKey(row["払出予定伝票日付"])) {
      errors.push(`${lineNumber}行目：払出予定伝票日付「${row["払出予定伝票日付"]}」がyyyyMMdd形式の正しい日付ではありません。`);
      return;
    }

    row["ラベルキー"] = normalizeLabelKey(row["ラベルキー"]);
    row.__lineNumber = lineNumber;
    rows.push(row);
  });

  if (errors.length > 0) {
    const preview = errors.slice(0, 5).join("\n");
    const suffix = errors.length > 5 ? `\nほか${errors.length - 5}件のエラーがあります。` : "";
    throw new Error(`${preview}${suffix}`);
  }
  if (rows.length === 0) throw new Error("有効なデータ行がありません。");
  return { headers, rows };
}

function removeLeadingZeros(value) {
  const normalized = String(value).replace(/^0+/, "");
  return normalized || "0";
}

// QRの15桁・4桁・3桁の各要素から先頭ゼロを除き、TSV用ラベルキーを作る。
function buildLabelKey(first, second, third) {
  if (!/^\d{15}$/.test(first) || !/^\d{4}$/.test(second) || !/^\d{3}$/.test(third)) {
    throw new Error("QRのラベルキー部分が不正です。");
  }
  return [first, second, third].map(removeLeadingZeros).join("-");
}

// SPD QRは「センター10桁＋ラベルキー15桁＋4桁＋3桁」の固定32桁として分解する。
function normalizeQr(rawValue) {
  const raw = normalizeValue(rawValue);
  if (!/^\d{32}$/.test(raw)) {
    return { ok: false, code: "QR_FORMAT", title: "QR形式エラー", message: "SPDラベルQRは数字32桁で読み取ってください。" };
  }
  try {
    return {
      ok: true,
      raw,
      centerCode: raw.slice(0, 10),
      labelKey: buildLabelKey(raw.slice(10, 25), raw.slice(25, 29), raw.slice(29, 32))
    };
  } catch (error) {
    return { ok: false, code: "QR_FORMAT", title: "QR形式エラー", message: error.message };
  }
}

// 施設名称から期待するセンターコードを決める。施設追加時はこの関数だけを変更する。
function getExpectedCenterCode(facilityName) {
  const center2Facilities = new Set(["千葉白井病院", "湘南ﾘﾊﾋﾞﾘﾃｰｼｮﾝ病院"]);
  return center2Facilities.has(normalizeValue(facilityName)) ? "0000000002" : "0000000001";
}

function rebuildIndexes() {
  state.labelIndex = new Map();
  state.departmentIndex = new Map();
  state.masterRows.forEach((row) => {
    const labelKey = row["ラベルキー"];
    const departmentCode = row["部署コード"];
    if (!state.labelIndex.has(labelKey)) state.labelIndex.set(labelKey, []);
    state.labelIndex.get(labelKey).push(row);
    if (!state.departmentIndex.has(departmentCode)) state.departmentIndex.set(departmentCode, []);
    state.departmentIndex.get(departmentCode).push(row);
  });
}

function findLabel(labelKey) {
  const candidates = state.labelIndex.get(normalizeLabelKey(labelKey)) || [];
  if (candidates.length === 0) return { ok: false, code: "NOT_FOUND", candidates };
  if (candidates.length > 1) return { ok: false, code: "AMBIGUOUS_LABEL", candidates };
  return { ok: true, row: candidates[0] };
}

function uniqueDepartmentCandidates(rows) {
  const unique = new Map();
  rows.forEach((row) => {
    const key = [row["施設コード"], row["施設名称"], row["部署コード"], row["部署名称"]].join("\u001f");
    if (!unique.has(key)) unique.set(key, row);
  });
  return [...unique.values()];
}

function setContainerDepartment(rawDepartmentCode) {
  if (!state.masterInfo || state.masterRows.length === 0) {
    return { ok: false, title: "マスター未読込", message: "先にラベルマスタ.tsvを読み込んでください。" };
  }
  const departmentCode = normalizeValue(rawDepartmentCode);
  if (!departmentCode) return { ok: false, title: "部署コードエラー", message: "部署コードが空です。" };
  const candidates = uniqueDepartmentCandidates(state.departmentIndex.get(departmentCode) || []);
  if (candidates.length === 0) {
    return { ok: false, code: "DEPARTMENT_NOT_FOUND", title: "部署コードがマスターに存在しません", message: `部署コード「${departmentCode}」はマスターに存在しません。` };
  }
  if (candidates.length > 1) {
    return { ok: false, code: "AMBIGUOUS_DEPARTMENT", title: "部署コードを一意に特定できません", message: `部署コード「${departmentCode}」が複数の施設・部署に存在します。マスターを確認してください。` };
  }

  const row = candidates[0];
  state.currentDepartment = {
    facilityCode: row["施設コード"], facilityName: row["施設名称"],
    departmentCode: row["部署コード"], departmentName: row["部署名称"]
  };
  state.mode = "spd";
  saveState();
  return { ok: true, department: state.currentDepartment };
}

function clearContainerDepartment() {
  state.currentDepartment = null;
  state.mode = "container";
  saveState();
}

function isCurrentDepartmentAvailable() {
  if (!state.currentDepartment) return false;
  const candidates = uniqueDepartmentCandidates(state.departmentIndex.get(state.currentDepartment.departmentCode) || []);
  if (candidates.length !== 1) return false;
  const row = candidates[0];
  return row["施設コード"] === state.currentDepartment.facilityCode
    && row["施設名称"] === state.currentDepartment.facilityName
    && row["部署コード"] === state.currentDepartment.departmentCode
    && row["部署名称"] === state.currentDepartment.departmentName;
}

function reconcileCurrentDepartment() {
  if (state.currentDepartment && !isCurrentDepartmentAvailable()) {
    state.currentDepartment = null;
    state.mode = "container";
    return false;
  }
  return Boolean(state.currentDepartment);
}

// センター、オリコン部署、二重読取の全条件が確定した場合だけOKを返す。
function validateSpdLabel(rawValue) {
  if (!state.masterInfo || state.masterRows.length === 0) {
    return { ok: false, code: "NO_MASTER", title: "マスター未読込", message: "先にラベルマスタ.tsvを読み込んでください。" };
  }
  if (!state.currentDepartment) {
    return { ok: false, code: "NO_DEPARTMENT", title: "オリコン部署未指定", message: "先にオリコンの部署ラベルを読み取ってください。" };
  }
  const period = validateTargetPeriod();
  if (!period.ok) {
    return { ok: false, code: "TARGET_PERIOD_ERROR", title: "対象期間エラー", message: period.message };
  }

  const qr = normalizeQr(rawValue);
  if (!qr.ok) return qr;
  const found = findLabel(qr.labelKey);
  if (found.code === "NOT_FOUND") {
    return { ok: false, code: found.code, title: "マスターに存在しません", message: `ラベルキー：${qr.labelKey}`, labelKey: qr.labelKey };
  }
  if (found.code === "AMBIGUOUS_LABEL") {
    return { ok: false, code: found.code, title: "ラベルを特定できません", message: `ラベルキー「${qr.labelKey}」がマスターに複数あります。`, labelKey: qr.labelKey };
  }

  const row = found.row;
  const expectedCenterCode = getExpectedCenterCode(row["施設名称"]);
  if (qr.centerCode !== expectedCenterCode) {
    return {
      ok: false, code: "CENTER_MISMATCH", title: "センターコード不一致",
      message: `読取：${qr.centerCode} ／ 正：${expectedCenterCode}`, row, labelKey: qr.labelKey
    };
  }

  // 部署コードだけでなく施設も照合し、同じ部署コードが別施設にある場合の誤投入を防ぐ。
  const departmentMatches = row["部署コード"] === state.currentDepartment.departmentCode;
  const facilityMatches = row["施設コード"] === state.currentDepartment.facilityCode && row["施設名称"] === state.currentDepartment.facilityName;
  if (!departmentMatches || !facilityMatches) {
    return {
      ok: false, code: "DEPARTMENT_MISMATCH", title: "部署違い",
      message: "オリコンとSPDラベルの施設・部署が一致しません。", row, labelKey: qr.labelKey
    };
  }

  // Setで読取済ラベルキーを照合し、同一作業中の二重読取を高速に検出する。
  if (state.readLabelKeys.has(qr.labelKey)) {
    return { ok: false, code: "DUPLICATE", title: "二重読取", message: `ラベルキー：${qr.labelKey}`, row, labelKey: qr.labelKey };
  }
  return { ok: true, code: "OK", title: "OK", message: "オリコンの部署と一致しました。", row, labelKey: qr.labelKey };
}

function addHistory(result) {
  const row = result.row || {};
  state.history.push({
    timestamp: new Date().toISOString(),
    labelKey: result.labelKey || "",
    facilityName: row["施設名称"] || "",
    departmentName: row["部署名称"] || "",
    productName: row["品名"] || "",
    result: result.title,
    resultCode: result.code || "ERROR"
  });
  if (state.history.length > 1000) state.history = state.history.slice(-1000);
}

function registerReadLabel(result) {
  if (!result.ok || !result.labelKey) return false;
  state.readLabelKeys.add(result.labelKey);
  addHistory(result);
  saveState();
  return true;
}

// 正常読取の直前と直後を比較し、指定部署・指定期間の未読取がゼロになった瞬間だけ完了音を選ぶ。
function registerSuccessfulScan(result, effects = {}) {
  const beforeCounts = getTargetCounts();
  const registered = registerReadLabel(result);
  const afterCounts = getTargetCounts();
  const completed = registered
    && Boolean(state.currentDepartment)
    && validateTargetPeriod().ok
    && beforeCounts.target > 0
    && beforeCounts.unread > 0
    && afterCounts.unread === 0;

  if (registered) {
    if (completed) (effects.playCompletion || playCompletionSound)();
    else (effects.playSuccess || playSuccessSound)();
  }
  return { registered, completed, beforeCounts, afterCounts };
}

function parseDateInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function parseMasterDate(value) {
  if (!isValidDateKey(value)) return null;
  const date = new Date(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)));
  date.setHours(0, 0, 0, 0);
  return date;
}

function validateTargetPeriod(startValue = state.targetStartDate, endValue = state.targetEndDate) {
  if (!startValue) return { ok: false, code: "START_REQUIRED", message: "開始日を指定してください。" };
  if (!endValue) return { ok: false, code: "END_REQUIRED", message: "終了日を指定してください。" };
  const startDate = parseDateInput(startValue);
  const endDate = parseDateInput(endValue);
  if (!startDate) return { ok: false, code: "START_INVALID", message: "開始日が正しくありません。" };
  if (!endDate) return { ok: false, code: "END_INVALID", message: "終了日が正しくありません。" };
  if (startDate.getTime() > endDate.getTime()) {
    return { ok: false, code: "RANGE_REVERSED", message: "開始日は終了日以前の日付を指定してください。" };
  }
  return { ok: true, startDate, endDate };
}

function matchesCurrentDepartment(row) {
  if (!state.currentDepartment) return true;
  return row["施設コード"] === state.currentDepartment.facilityCode
    && row["施設名称"] === state.currentDepartment.facilityName
    && row["部署コード"] === state.currentDepartment.departmentCode
    && row["部署名称"] === state.currentDepartment.departmentName;
}

// 対象期間と現在の「施設＋部署」を一か所で絞り込み、件数と未読取一覧の条件ずれを防ぐ。
function getCurrentTargetLabels() {
  const period = validateTargetPeriod();
  if (!period.ok) return [];
  return state.masterRows.filter((row) => {
    const plannedDate = parseMasterDate(row["払出予定伝票日付"]);
    if (!plannedDate) return false;
    const time = plannedDate.getTime();
    return time >= period.startDate.getTime()
      && time <= period.endDate.getTime()
      && matchesCurrentDepartment(row);
  });
}

function getUniqueLabelRows(rows) {
  const unique = new Map();
  rows.forEach((row) => {
    if (!unique.has(row["ラベルキー"])) unique.set(row["ラベルキー"], row);
  });
  return [...unique.values()];
}

// 対象ラベルキー集合と読取済Setを比較し、未読取ラベルそのものを求める。
function getUnreadLabels() {
  return getUniqueLabelRows(getCurrentTargetLabels()).filter((row) => !state.readLabelKeys.has(row["ラベルキー"]));
}

function getTargetCounts() {
  const uniqueKeys = new Set(getCurrentTargetLabels().map((row) => row["ラベルキー"]));
  const readCount = [...uniqueKeys].filter((key) => state.readLabelKeys.has(key)).length;
  return { target: uniqueKeys.size, read: readCount, unread: uniqueKeys.size - readCount };
}

function formatLocalDateTime(isoValue) {
  if (!isoValue) return "―";
  const date = new Date(isoValue);
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

function dateInputToKey(value) {
  return String(value || "").replaceAll("-", "");
}

function formatDateForDisplay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.replaceAll("-", "/") : "―";
}

function keyToDateInput(value) {
  if (!/^\d{8}$/.test(value || "")) return "";
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function todayInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function getDuplicateLabelKeyCount(rows) {
  const counts = new Map();
  rows.forEach((row) => counts.set(row["ラベルキー"], (counts.get(row["ラベルキー"]) || 0) + 1));
  return [...counts.values()].filter((count) => count > 1).length;
}

function saveState() {
  try {
    const savedState = {
      readLabelKeys: [...state.readLabelKeys], history: state.history,
      targetStartDate: state.targetStartDate, targetEndDate: state.targetEndDate,
      currentDepartment: state.currentDepartment, mode: state.mode,
      masterFingerprint: state.masterInfo?.fingerprint || null
    };
    localStorage.setItem(STORAGE_KEYS.state, JSON.stringify(savedState));
    return true;
  } catch (error) {
    console.error("作業状態の保存に失敗しました。", error);
    showImportMessage("ブラウザに作業状態を保存できませんでした。空き容量やSafariの設定を確認してください。", true);
    return false;
  }
}

function saveMaster(rows, info) {
  // 見出し名を各行に繰り返さず、配列で保存してiPhoneのlocalStorage使用量を抑える。
  const headers = Object.keys(rows[0] || {}).filter((header) => header !== "__lineNumber");
  const records = rows.map((row) => headers.map((header) => row[header] ?? ""));
  const serialized = JSON.stringify({ formatVersion: 2, headers, records, info });
  localStorage.setItem(STORAGE_KEYS.master, serialized);
}

function restoreState() {
  state.targetStartDate = todayInputValue();
  state.targetEndDate = todayInputValue();
  try {
    const savedMaster = JSON.parse(localStorage.getItem(STORAGE_KEYS.master) || "null");
    if (savedMaster?.info && Array.isArray(savedMaster.records) && Array.isArray(savedMaster.headers)) {
      state.masterInfo = savedMaster.info;
      state.masterRows = savedMaster.records.map((record) => Object.fromEntries(
        savedMaster.headers.map((header, index) => [header, record[index] ?? ""])
      ));
      rebuildIndexes();
    } else if (savedMaster?.info && Array.isArray(savedMaster.rows)) {
      // 初期試作版の保存形式も読み戻し、次回取込まで利用可能にする。
      state.masterInfo = savedMaster.info;
      state.masterRows = savedMaster.rows;
      rebuildIndexes();
    }
  } catch (error) {
    console.error("保存済みマスターを読み込めません。", error);
    localStorage.removeItem(STORAGE_KEYS.master);
  }

  try {
    const savedState = JSON.parse(localStorage.getItem(STORAGE_KEYS.state) || "null");
    if (savedState) {
      // 旧版の対象日保存値は、開始日・終了日の両方へ安全に移行する。
      const legacyTargetDate = savedState.targetDate || "";
      if (savedState.targetStartDate || legacyTargetDate) state.targetStartDate = savedState.targetStartDate || legacyTargetDate;
      if (savedState.targetEndDate || legacyTargetDate) state.targetEndDate = savedState.targetEndDate || legacyTargetDate;
      if (state.masterInfo && savedState.masterFingerprint === state.masterInfo.fingerprint) {
        state.readLabelKeys = new Set(Array.isArray(savedState.readLabelKeys) ? savedState.readLabelKeys : []);
        state.history = Array.isArray(savedState.history) ? savedState.history : [];
        state.currentDepartment = savedState.currentDepartment || null;
        state.mode = savedState.mode === "spd" && state.currentDepartment ? "spd" : "container";
        reconcileCurrentDepartment();
      }
    }
  } catch (error) {
    console.error("保存済み作業状態を読み込めません。", error);
    localStorage.removeItem(STORAGE_KEYS.state);
  }
  if (state.masterInfo) saveState();
}

async function decodeMasterFile(file) {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder("shift-jis", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Error("TSVをCP932（Shift-JIS系）として読み込めませんでした。文字コードを確認してください。");
  }
}

async function loadMasterFile(file) {
  if (!file) throw new Error("TSVファイルが選択されていません。");
  if (!/\.tsv$/i.test(file.name)) throw new Error(".tsvファイルを選択してください。");
  const text = await decodeMasterFile(file);
  const parsed = parseTsv(text);
  const dateKeys = parsed.rows.map((row) => row["払出予定伝票日付"]).sort();
  return {
    rows: parsed.rows,
    info: {
      fileName: file.name, importedAt: new Date().toISOString(), rowCount: parsed.rows.length,
      minDate: dateKeys[0], maxDate: dateKeys.at(-1),
      duplicateLabelKeyCount: getDuplicateLabelKeyCount(parsed.rows),
      fingerprint: createFingerprint(file, parsed.rows)
    }
  };
}

function applyMasterData(rows, info) {
  // 保存成功後にだけ稼働中マスターを置換し、旧マスター由来の作業状態を完全に切り離す。
  saveMaster(rows, info);
  state.masterRows = rows;
  state.masterInfo = info;
  rebuildIndexes();
  state.readLabelKeys = new Set();
  state.history = [];
  state.currentDepartment = null;
  state.mode = "container";
  saveState();
}

function createFingerprint(file, rows) {
  const first = rows[0]?.["ラベルキー"] || "";
  const last = rows.at(-1)?.["ラベルキー"] || "";
  return `${file.name}:${file.size}:${file.lastModified}:${rows.length}:${first}:${last}`;
}

async function importMaster(file) {
  if (!file) return;
  showImportMessage("TSVを読み込み、内容を検証しています…", false);
  try {
    const masterData = await loadMasterFile(file);
    applyMasterData(masterData.rows, masterData.info);
    showImportMessage(`${masterData.rows.length}件を取り込みました。以前の作業状態はリセットしました。`, false, true);
    renderAll();
    showResult("idle", "取込完了", "オリコンの部署ラベルを読み取ってください。", []);
  } catch (error) {
    console.error("TSV取込エラー", error);
    showImportMessage(`取込を中止しました。現在のマスターは変更していません。\n${error.message}`, true);
    playAlertSound();
  } finally {
    elements.masterFile.value = "";
  }
}

function initAudio() {
  if (!successSound) {
    successSound = new Audio("ok.wav");
    successSound.preload = "auto";
  }
  if (!alertSound) {
    alertSound = new Audio("alert.wav");
    alertSound.preload = "auto";
  }
  if (!completionSound) {
    completionSound = new Audio("complete.wav");
    completionSound.preload = "auto";
  }
  successSound.load();
  alertSound.load();
  completionSound.load();
}

async function unlockAudio() {
  initAudio();
  try {
    const sounds = [successSound, alertSound, completionSound];
    sounds.forEach((sound) => { sound.muted = true; });
    await Promise.all(sounds.map((sound) => sound.play()));
    sounds.forEach((sound) => {
      sound.pause();
      sound.currentTime = 0;
      sound.muted = false;
    });
    elements.audioStatus.textContent = "有効";
  } catch (error) {
    [successSound, alertSound, completionSound].forEach((sound) => { if (sound) sound.muted = false; });
    elements.audioStatus.textContent = "有効化できません";
    console.error("音声の有効化に失敗しました。", error);
  }
}

function playSound(sound, label) {
  if (!sound) initAudio();
  const target = label === "success" ? successSound : label === "completion" ? completionSound : alertSound;
  target.currentTime = 0;
  target.play().catch((error) => {
    console.error("音声を再生できません。", error);
    if (elements.audioStatus) elements.audioStatus.textContent = "要タップ確認";
  });
}

function playSuccessSound() { playSound(successSound, "success"); }
function playAlertSound() { playSound(alertSound, "alert"); }
function playCompletionSound() { playSound(completionSound, "completion"); }

function handleContainerDepartmentScan(rawValue, effects = {}) {
  const result = setContainerDepartment(rawValue);
  if (result.ok) (effects.playSuccess || playSuccessSound)();
  else (effects.playAlert || playAlertSound)();
  return result;
}

function processScan(rawValue) {
  const value = normalizeValue(rawValue);
  if (!value) return;
  if (state.mode === "container") {
    // 部署未指定時の32桁値は部署コードと誤解釈せず、SPDラベルとして安全に拒否する。
    if (/^\d{32}$/.test(value) && !state.currentDepartment) {
      const result = validateSpdLabel(value);
      addHistory(result);
      saveState();
      showResult("ng", result.title, result.message, []);
      playAlertSound();
      elements.manualScanInput.value = "";
      return;
    }

    const result = handleContainerDepartmentScan(value);
    if (result.ok) {
      renderAll();
      showResult("ok", "部署指定 OK", `${result.department.departmentName} のSPDラベルを読み取ってください。`, [
        ["施設名称", result.department.facilityName], ["部署名称", result.department.departmentName], ["部署コード", result.department.departmentCode]
      ]);
    } else {
      showResult("ng", result.title, result.message, []);
    }
  } else {
    const result = validateSpdLabel(value);
    if (result.ok) {
      registerSuccessfulScan(result);
      renderAll();
      showResult("ok", "OK", result.message, [
        ["施設名称", result.row["施設名称"]], ["部署名称", result.row["部署名称"]],
        ["製品番号", getProductNumber(result.row)], ["品名", result.row["品名"]],
        ["ラベルキー", result.labelKey]
      ]);
    } else {
      addHistory(result);
      saveState();
      const details = [];
      if (result.code === "DEPARTMENT_MISMATCH" && result.row) {
        details.push(
          ["オリコン側", `${state.currentDepartment.facilityName} ／ ${state.currentDepartment.departmentName}（${state.currentDepartment.departmentCode}）`],
          ["SPDラベル側", `${result.row["施設名称"]} ／ ${result.row["部署名称"]}（${result.row["部署コード"]}）`],
          ["製品番号", getProductNumber(result.row)], ["品名", result.row["品名"]]
        );
      } else if (result.row) {
        details.push(
          ["施設名称", result.row["施設名称"]], ["部署名称", result.row["部署名称"]],
          ["製品番号", getProductNumber(result.row)], ["品名", result.row["品名"]]
        );
      }
      if (result.labelKey) details.push(["ラベルキー", result.labelKey]);
      showResult("ng", result.title, result.message, details);
      playAlertSound();
    }
  }
  elements.manualScanInput.value = "";
}

function handleClearDepartment() {
  clearContainerDepartment();
  renderAll();
  showResult("idle", "部署指定解除", "オリコンの部署ラベルを読み取ってください。", []);
}

function handleGlobalKeydown(event) {
  const target = event.target;
  if (target === elements.manualScanInput || target === elements.targetStartDate || target === elements.targetEndDate || target === elements.masterFile) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === "Enter") {
    if (state.scannerBuffer) {
      event.preventDefault();
      const scan = state.scannerBuffer;
      state.scannerBuffer = "";
      clearTimeout(state.scannerTimer);
      renderScannerStatus();
      processScan(scan);
    }
    return;
  }
  if (event.key.length === 1) {
    state.scannerBuffer += event.key;
    clearTimeout(state.scannerTimer);
    state.scannerTimer = setTimeout(() => {
      state.scannerBuffer = "";
      renderScannerStatus();
    }, 1500);
    renderScannerStatus();
  }
}

function showResult(kind, title, message, details) {
  elements.resultPanel.className = `result-panel result-panel--${kind}`;
  elements.resultTitle.textContent = title;
  elements.resultMessage.textContent = message;
  elements.resultDetails.replaceChildren(...details.map(([term, description]) => {
    const wrapper = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = description;
    wrapper.append(dt, dd);
    return wrapper;
  }));
}

function showImportMessage(message, isError, isSuccess = false) {
  if (!elements.importMessage) return;
  elements.importMessage.textContent = message;
  elements.importMessage.className = `import-message${isError ? " is-error" : isSuccess ? " is-ok" : ""}`;
}

function renderMode() {
  const isSpd = state.mode === "spd" && state.currentDepartment;
  elements.modeStatus.className = `mode-status ${isSpd ? "mode-status--spd" : "mode-status--container"}`;
  elements.modeStatus.textContent = isSpd ? "● SPDラベル読取中" : "● オリコン部署待ち";
  elements.clearDepartmentButton.disabled = !state.currentDepartment;
}

function renderDepartment() {
  const department = state.currentDepartment;
  elements.currentFacility.textContent = department?.facilityName || "施設未指定";
  elements.currentDepartment.textContent = department?.departmentName || "部署ラベルを読み取ってください";
  elements.currentDepartmentCode.textContent = `部署コード：${department?.departmentCode || "―"}`;
}

function renderCounts() {
  const period = validateTargetPeriod();
  const counts = getTargetCounts();
  elements.targetCount.textContent = counts.target;
  elements.readCount.textContent = counts.read;
  elements.unreadCount.textContent = counts.unread;
  elements.unreadTargetCount.textContent = counts.target;
  elements.unreadReadCount.textContent = counts.read;
  elements.unreadRemainingCount.textContent = counts.unread;
  elements.periodError.textContent = period.ok ? "" : period.message;
  elements.unreadPeriodLabel.textContent = period.ok
    ? `対象期間：${formatDateForDisplay(state.targetStartDate)} ～ ${formatDateForDisplay(state.targetEndDate)}`
    : `対象期間：エラー（${period.message}）`;
  elements.unreadDepartmentLabel.textContent = state.currentDepartment
    ? `対象部署：${state.currentDepartment.facilityName} / ${state.currentDepartment.departmentName}`
    : "対象部署：指定なし（全体）";
}

function renderUnreadList() {
  elements.unreadList.replaceChildren();
  if (!state.masterInfo) {
    elements.unreadList.append(createEmptyState("マスターを読み込んでください。"));
    return;
  }
  const period = validateTargetPeriod();
  if (!period.ok) {
    elements.unreadList.append(createEmptyState(`対象期間を修正してください。${period.message}`));
    return;
  }
  const unreadRows = getUnreadLabels();
  if (unreadRows.length === 0) {
    elements.unreadList.append(createEmptyState(getTargetCounts().target === 0 ? "対象条件に該当するラベルはありません。" : "未読取ラベルはありません。"));
    return;
  }
  unreadRows.forEach((row) => {
    const article = document.createElement("article");
    article.className = "unread-item";
    const title = document.createElement("h3");
    title.textContent = row["品名"];
    const place = document.createElement("p");
    place.textContent = `${row["施設名称"]} ／ ${row["部署名称"]}`;
    const productNumber = document.createElement("p");
    productNumber.className = "item-product";
    productNumber.textContent = `製品番号：${getProductNumber(row)}`;
    const key = document.createElement("p");
    key.className = "item-key";
    key.textContent = `ラベルキー：${row["ラベルキー"]}`;
    article.append(title, productNumber, place, key);
    elements.unreadList.append(article);
  });
}

function createEmptyState(message) {
  const element = document.createElement("p");
  element.className = "empty-state";
  element.textContent = message;
  return element;
}

function renderMasterInfo() {
  const info = state.masterInfo;
  elements.masterStatusBadge.textContent = info ? "マスター読込済み" : "マスター未読込";
  elements.masterStatusBadge.className = `status-badge ${info ? "status-badge--ok" : "status-badge--ng"}`;
  elements.masterLoaded.textContent = info ? "読込済み" : "未読込";
  elements.masterFileName.textContent = info?.fileName || "―";
  elements.masterImportedAt.textContent = formatLocalDateTime(info?.importedAt);
  elements.masterRowCount.textContent = `${info?.rowCount || 0}件`;
  elements.masterMinDate.textContent = info ? formatDateForDisplay(keyToDateInput(info.minDate)) : "―";
  elements.masterMaxDate.textContent = info ? formatDateForDisplay(keyToDateInput(info.maxDate)) : "―";
  elements.masterDuplicateCount.textContent = `${info?.duplicateLabelKeyCount || 0}件`;
}

function renderScannerStatus() {
  elements.scannerBufferStatus.textContent = state.scannerBuffer
    ? `Bluetoothリーダー入力中（${state.scannerBuffer.length}文字）`
    : "Bluetoothリーダー入力待機中";
}

function renderAll() {
  elements.targetStartDate.value = state.targetStartDate;
  elements.targetEndDate.value = state.targetEndDate;
  renderMode();
  renderDepartment();
  renderCounts();
  renderUnreadList();
  renderMasterInfo();
  renderScannerStatus();
}

function switchSection(sectionId) {
  document.querySelectorAll(".screen").forEach((section) => section.classList.toggle("is-active", section.id === sectionId));
  document.querySelectorAll(".tab-button").forEach((button) => button.classList.toggle("is-active", button.dataset.section === sectionId));
  if (sectionId === "unreadSection") renderUnreadList();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cacheElements() {
  [
    "masterStatusBadge", "targetStartDate", "targetEndDate", "periodError", "modeStatus", "clearDepartmentButton",
    "currentFacility", "currentDepartment", "currentDepartmentCode", "resultPanel", "resultTitle", "resultMessage", "resultDetails",
    "targetCount", "readCount", "unreadCount", "manualScanInput", "manualScanButton", "scannerBufferStatus",
    "refreshUnreadButton", "unreadPeriodLabel", "unreadDepartmentLabel", "unreadTargetCount", "unreadReadCount", "unreadRemainingCount", "unreadList",
    "masterFile", "importMessage", "masterLoaded", "masterFileName", "masterImportedAt", "masterRowCount", "masterMinDate", "masterMaxDate",
    "masterDuplicateCount", "enableAudioButton", "audioStatus"
  ].forEach((id) => { elements[id] = document.getElementById(id); });
}

function bindEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", () => switchSection(button.dataset.section)));
  elements.clearDepartmentButton.addEventListener("click", handleClearDepartment);
  const handlePeriodChange = () => {
    state.targetStartDate = elements.targetStartDate.value;
    state.targetEndDate = elements.targetEndDate.value;
    saveState();
    renderCounts();
    renderUnreadList();
  };
  elements.targetStartDate.addEventListener("change", handlePeriodChange);
  elements.targetEndDate.addEventListener("change", handlePeriodChange);
  elements.masterFile.addEventListener("change", () => importMaster(elements.masterFile.files[0]));
  elements.manualScanButton.addEventListener("click", () => processScan(elements.manualScanInput.value));
  elements.manualScanInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); processScan(elements.manualScanInput.value); }
  });
  elements.refreshUnreadButton.addEventListener("click", () => { renderCounts(); renderUnreadList(); });
  elements.enableAudioButton.addEventListener("click", unlockAudio);
  window.addEventListener("keydown", handleGlobalKeydown);
}

function init() {
  cacheElements();
  restoreState();
  initAudio();
  bindEvents();
  renderAll();
  if (!state.masterInfo) showResult("idle", "待機中", "マスターを読み込んでください。", []);
  else if (!state.currentDepartment) showResult("idle", "待機中", "オリコンの部署ラベルを読み取ってください。", []);
  else showResult("idle", "待機中", "SPDラベルQRを読み取ってください。", []);
  document.body.dataset.appReady = "true";
}

if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", init);

// Node.jsによるローカル単体テスト用。ブラウザでは使用しない。
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    state, parseTsv, normalizeQr, buildLabelKey, getExpectedCenterCode, rebuildIndexes,
    findLabel, setContainerDepartment, clearContainerDepartment, reconcileCurrentDepartment,
    validateSpdLabel, validateTargetPeriod, getCurrentTargetLabels, getUnreadLabels, getTargetCounts,
    registerReadLabel, registerSuccessfulScan, handleContainerDepartmentScan, applyMasterData,
    isValidDateKey, normalizeLabelKey, parseDateInput, getProductNumber
  };
}
