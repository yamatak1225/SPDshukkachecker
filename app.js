"use strict";

const STORAGE_KEYS = { master: "spd-shipping-master-v1", state: "spd-shipping-state-v2" };
const HISTORY_DB_NAME = "spd-shipping-history-v1";
const HISTORY_STORE_NAME = "scanHistory";
const REQUIRED_HEADERS = ["施設コード", "施設名称", "部署コード", "部署名称", "品名", "製品番号", "ラベルキー", "払出予定伝票日付"];
const PRODUCT_NUMBER_HEADER = "製品番号";

const state = {
  masterRows: [], masterInfo: null, labelIndex: new Map(), containerIndex: new Map(),
  readLabelKeys: new Set(), processedResults: new Map(), history: [],
  targetStartDate: "", targetEndDate: "", currentDepartment: null,
  mode: "container", pendingSpdLabel: null, scannerBuffer: "", scannerTimer: null
};
let successSound = null;
let productSuccessSound = null;
let alertSound = null;
let completionSound = null;
let historyDbPromise = null;
let elements = {};

function normalizeHeader(value) { return String(value ?? "").replace(/^\uFEFF/, "").trim(); }
function normalizeValue(value) { return String(value ?? "").trim(); }
function normalizeLabelKey(value) { return normalizeValue(value).replace(/\s+/g, ""); }
function getProductNumber(row) { return normalizeValue(row?.[PRODUCT_NUMBER_HEADER]) || "―"; }

function splitTsvRecords(text) {
  const records = [];
  let row = [], cell = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === "\t") { row.push(cell); cell = ""; }
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) records.push(row);
      row = []; cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("TSV内の引用符が閉じられていません。");
  if (cell !== "" || row.length) { row.push(cell); if (row.some((value) => value !== "")) records.push(row); }
  return records;
}

function isValidDateKey(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6, 8));
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// 現調くんと同じく、13桁JANはチェックデジットを除いた先頭12桁で比較する。
function normalizeJanForComparison(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 13) return digits.slice(0, 12);
  if (digits.length === 12) return digits;
  return "";
}

function parseTsv(text) {
  const records = splitTsvRecords(String(text ?? "").replace(/^\uFEFF/, ""));
  if (records.length < 2) throw new Error("TSVに見出し行またはデータ行がありません。");
  const headers = records[0].map(normalizeHeader);
  const duplicates = headers.filter((header, index) => header && headers.indexOf(header) !== index);
  if (duplicates.length) throw new Error(`同じ見出しが複数あります：${[...new Set(duplicates)].join("、")}`);
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`必須列がありません：${missing.join("、")}`);
  const rows = [], errors = [];
  records.slice(1).forEach((record, recordIndex) => {
    const line = recordIndex + 2;
    if (record.length > headers.length && record.slice(headers.length).some((value) => normalizeValue(value))) {
      errors.push(`${line}行目：見出し数を超えるデータがあります。`); return;
    }
    const row = {};
    headers.forEach((header, index) => { if (header) row[header] = normalizeValue(record[index]); });
    const empty = REQUIRED_HEADERS.filter((header) => !row[header]);
    if (empty.length) { errors.push(`${line}行目：必須項目が空欄です（${empty.join("、")}）。`); return; }
    if (!isValidDateKey(row["払出予定伝票日付"])) { errors.push(`${line}行目：払出予定伝票日付「${row["払出予定伝票日付"]}」がyyyyMMdd形式の正しい日付ではありません。`); return; }
    // JANコードは任意。値がある場合だけ、照合可能な形式かを検証する。
    if (normalizeValue(row["JANコード"]) && !normalizeJanForComparison(row["JANコード"])) { errors.push(`${line}行目：JANコード「${row["JANコード"]}」を12桁比較値へ変換できません。`); return; }
    row["ラベルキー"] = normalizeLabelKey(row["ラベルキー"]);
    row.__lineNumber = line;
    rows.push(row);
  });
  if (errors.length) throw new Error(`${errors.slice(0, 5).join("\n")}${errors.length > 5 ? `\nほか${errors.length - 5}件のエラーがあります。` : ""}`);
  if (!rows.length) throw new Error("有効なデータ行がありません。");
  return { headers, rows };
}

function removeLeadingZeros(value) { const normalized = String(value).replace(/^0+/, ""); return normalized || "0"; }
function buildLabelKey(first, second, third) {
  if (!/^\d{15}$/.test(first) || !/^\d{4}$/.test(second) || !/^\d{3}$/.test(third)) throw new Error("QRのラベルキー部分が不正です。");
  return [first, second, third].map(removeLeadingZeros).join("-");
}
function normalizeQr(rawValue) {
  const raw = normalizeValue(rawValue);
  if (!/^\d{32}$/.test(raw)) return { ok: false, code: "QR_FORMAT", title: "QR形式エラー", message: "SPDラベルQRは数字32桁で読み取ってください。" };
  try { return { ok: true, raw, centerCode: raw.slice(0, 10), labelKey: buildLabelKey(raw.slice(10, 25), raw.slice(25, 29), raw.slice(29, 32)) }; }
  catch (error) { return { ok: false, code: "QR_FORMAT", title: "QR形式エラー", message: error.message }; }
}
function getExpectedCenterCode(facilityName) {
  return new Set(["千葉白井病院", "湘南ﾘﾊﾋﾞﾘﾃｰｼｮﾝ病院"]).has(normalizeValue(facilityName)) ? "0000000002" : "0000000001";
}

function containerIndexKey(facilityCode, departmentCode) { return `${facilityCode}\u001f${departmentCode}`; }
function rebuildIndexes() {
  state.labelIndex = new Map(); state.containerIndex = new Map();
  state.masterRows.forEach((row) => {
    const labelKey = row["ラベルキー"], key = containerIndexKey(row["施設コード"], row["部署コード"]);
    if (!state.labelIndex.has(labelKey)) state.labelIndex.set(labelKey, []);
    if (!state.containerIndex.has(key)) state.containerIndex.set(key, []);
    state.labelIndex.get(labelKey).push(row); state.containerIndex.get(key).push(row);
  });
}
function findLabel(labelKey) {
  const candidates = state.labelIndex.get(normalizeLabelKey(labelKey)) || [];
  if (!candidates.length) return { ok: false, code: "NOT_FOUND", candidates };
  if (candidates.length > 1) return { ok: false, code: "AMBIGUOUS_LABEL", candidates };
  return { ok: true, row: candidates[0] };
}
function uniqueDepartmentCandidates(rows) {
  const unique = new Map();
  rows.forEach((row) => { const key = [row["施設コード"], row["施設名称"], row["部署コード"], row["部署名称"]].join("\u001f"); if (!unique.has(key)) unique.set(key, row); });
  return [...unique.values()];
}
function parseContainerBarcode(rawValue) {
  const raw = normalizeValue(rawValue);
  if (!/^\d{20}$/.test(raw)) return { ok: false, code: "CONTAINER_FORMAT", title: "オリコン形式エラー", message: "オリコンラベルは施設コード10桁＋部署コード10桁の数字20桁です。" };
  return { ok: true, raw, facilityCode: raw.slice(0, 10), departmentCode: raw.slice(10) };
}
function setContainerDepartment(rawValue) {
  if (!state.masterInfo || !state.masterRows.length) return { ok: false, code: "NO_MASTER", title: "マスター未読込", message: "先にラベルマスタ.tsvを読み込んでください。" };
  const parsed = parseContainerBarcode(rawValue);
  if (!parsed.ok) return parsed;
  const candidates = uniqueDepartmentCandidates(state.containerIndex.get(containerIndexKey(parsed.facilityCode, parsed.departmentCode)) || []);
  if (!candidates.length) return { ok: false, code: "CONTAINER_NOT_FOUND", title: "オリコンがマスターに存在しません", message: `施設コード：${parsed.facilityCode} ／ 部署コード：${parsed.departmentCode}` };
  if (candidates.length > 1) return { ok: false, code: "AMBIGUOUS_DEPARTMENT", title: "オリコンを一意に特定できません", message: "施設コード＋部署コードが複数の施設・部署名称に対応しています。マスターを確認してください。" };
  const row = candidates[0];
  state.currentDepartment = { facilityCode: row["施設コード"], facilityName: row["施設名称"], departmentCode: row["部署コード"], departmentName: row["部署名称"] };
  state.pendingSpdLabel = null; state.mode = "spd"; saveState();
  return { ok: true, code: "CONTAINER_OK", department: state.currentDepartment };
}
function clearContainerDepartment() { state.currentDepartment = null; state.pendingSpdLabel = null; state.mode = "container"; saveState(); }
function isCurrentDepartmentAvailable() {
  if (!state.currentDepartment) return false;
  const candidates = uniqueDepartmentCandidates(state.containerIndex.get(containerIndexKey(state.currentDepartment.facilityCode, state.currentDepartment.departmentCode)) || []);
  if (candidates.length !== 1) return false;
  const row = candidates[0];
  return row["施設コード"] === state.currentDepartment.facilityCode && row["施設名称"] === state.currentDepartment.facilityName
    && row["部署コード"] === state.currentDepartment.departmentCode && row["部署名称"] === state.currentDepartment.departmentName;
}
function reconcileCurrentDepartment() {
  if (state.currentDepartment && !isCurrentDepartmentAvailable()) { state.currentDepartment = null; state.pendingSpdLabel = null; state.mode = "container"; return false; }
  return Boolean(state.currentDepartment);
}

function parseDateInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  date.setHours(0, 0, 0, 0); return date;
}
function parseMasterDate(value) { if (!isValidDateKey(value)) return null; const date = new Date(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))); date.setHours(0, 0, 0, 0); return date; }
function validateTargetPeriod(startValue = state.targetStartDate, endValue = state.targetEndDate) {
  if (!startValue) return { ok: false, code: "START_REQUIRED", message: "開始日を指定してください。" };
  if (!endValue) return { ok: false, code: "END_REQUIRED", message: "終了日を指定してください。" };
  const startDate = parseDateInput(startValue), endDate = parseDateInput(endValue);
  if (!startDate) return { ok: false, code: "START_INVALID", message: "開始日が正しくありません。" };
  if (!endDate) return { ok: false, code: "END_INVALID", message: "終了日が正しくありません。" };
  if (startDate > endDate) return { ok: false, code: "RANGE_REVERSED", message: "開始日は終了日以前の日付を指定してください。" };
  return { ok: true, startDate, endDate };
}
function isRowInTargetPeriod(row) { const period = validateTargetPeriod(), date = parseMasterDate(row?.["払出予定伝票日付"]); return Boolean(period.ok && date && date >= period.startDate && date <= period.endDate); }
function matchesCurrentDepartment(row) {
  if (!state.currentDepartment) return true;
  return row["施設コード"] === state.currentDepartment.facilityCode && row["施設名称"] === state.currentDepartment.facilityName
    && row["部署コード"] === state.currentDepartment.departmentCode && row["部署名称"] === state.currentDepartment.departmentName;
}
function getCurrentTargetLabels() { return validateTargetPeriod().ok ? state.masterRows.filter((row) => isRowInTargetPeriod(row) && matchesCurrentDepartment(row)) : []; }
function getUniqueLabelRows(rows) { const unique = new Map(); rows.forEach((row) => { if (!unique.has(row["ラベルキー"])) unique.set(row["ラベルキー"], row); }); return [...unique.values()]; }
function getUnreadLabels() { return getUniqueLabelRows(getCurrentTargetLabels()).filter((row) => !state.readLabelKeys.has(row["ラベルキー"])); }
function getTargetCounts() {
  const keys = new Set(getCurrentTargetLabels().map((row) => row["ラベルキー"]));
  const readKeys = [...keys].filter((key) => state.readLabelKeys.has(key));
  const skip = readKeys.filter((key) => state.processedResults.get(key) === "SKIP").length;
  return { target: keys.size, read: readKeys.length, unread: keys.size - readKeys.length, ok: readKeys.length - skip, skip };
}

function validateSpdLabel(rawValue) {
  if (!state.masterInfo || !state.masterRows.length) return { ok: false, code: "NO_MASTER", title: "マスター未読込", message: "先にラベルマスタ.tsvを読み込んでください。" };
  if (!state.currentDepartment) return { ok: false, code: "NO_DEPARTMENT", title: "オリコン未指定", message: "先にオリコンラベルを読み取ってください。" };
  const period = validateTargetPeriod();
  if (!period.ok) return { ok: false, code: "TARGET_PERIOD_ERROR", title: "対象期間エラー", message: period.message };
  const qr = normalizeQr(rawValue);
  if (!qr.ok) return qr;
  const found = findLabel(qr.labelKey);
  if (found.code === "NOT_FOUND") return { ok: false, code: found.code, title: "マスターに存在しません", message: `ラベルキー：${qr.labelKey}`, labelKey: qr.labelKey, spdRaw: qr.raw };
  if (found.code === "AMBIGUOUS_LABEL") return { ok: false, code: found.code, title: "ラベルを特定できません", message: `ラベルキー「${qr.labelKey}」がマスターに複数あります。`, labelKey: qr.labelKey, spdRaw: qr.raw };
  const row = found.row, expectedCenterCode = getExpectedCenterCode(row["施設名称"]);
  if (qr.centerCode !== expectedCenterCode) return { ok: false, code: "CENTER_MISMATCH", title: "センターコード不一致", message: `読取：${qr.centerCode} ／ 正：${expectedCenterCode}`, row, labelKey: qr.labelKey, spdRaw: qr.raw };
  if (!matchesCurrentDepartment(row)) return { ok: false, code: "DEPARTMENT_MISMATCH", title: "部署違い", message: "オリコンとSPDラベルの施設・部署が一致しません。", row, labelKey: qr.labelKey, spdRaw: qr.raw };
  if (!isRowInTargetPeriod(row)) return { ok: false, code: "OUTSIDE_PERIOD", title: "対象期間外", message: `払出予定伝票日付：${row["払出予定伝票日付"]}`, row, labelKey: qr.labelKey, spdRaw: qr.raw };
  if (state.readLabelKeys.has(qr.labelKey)) return { ok: false, code: "DUPLICATE", title: "二重読取", message: `ラベルキー：${qr.labelKey}`, row, labelKey: qr.labelKey, spdRaw: qr.raw };
  return { ok: true, code: "SPD_PENDING", title: "SPDラベル受付", message: "商品のJAN / GS1-128を読み取ってください。", row, labelKey: qr.labelKey, spdRaw: qr.raw };
}
function setPendingSpdLabel(result, now = new Date()) {
  if (!result?.ok || !result.row || !result.labelKey) return false;
  state.pendingSpdLabel = { row: result.row, labelKey: result.labelKey, spdRaw: result.spdRaw || "", spdReadAt: now.toISOString(), lastProductAttempt: null };
  state.mode = "product"; saveState(); return true;
}
function acceptPendingSpdLabel(result, effects = {}) {
  const accepted = setPendingSpdLabel(result);
  if (accepted) (effects.playSuccess || playSuccessSound)();
  return accepted;
}
function acceptOrAutoSkipSpdLabel(result, effects = {}) {
  const accepted = acceptPendingSpdLabel(result, { playSuccess: effects.playSuccess || playSuccessSound });
  if (!accepted) return { accepted: false, autoSkipped: false };
  if (normalizeValue(result.row["JANコード"])) return { accepted: true, autoSkipped: false };

  // SPD受付音の直後に自動SKIPする。通常のSKIP用3音は重ねず、最終件だけ完了音を少し遅らせる。
  const playCompletionAfterSpd = effects.playCompletion || (() => setTimeout(playCompletionSound, 520));
  const skipResult = executeSkip("マスターJANなし", {
    playProductSuccess: () => {},
    playCompletion: playCompletionAfterSpd
  });
  return { accepted: true, autoSkipped: true, skipResult };
}
function cancelPendingSpdLabel() { if (!state.pendingSpdLabel) return false; state.pendingSpdLabel = null; state.mode = state.currentDepartment ? "spd" : "container"; saveState(); return true; }

function detectProductBarcodeType(rawValue) {
  const raw = normalizeValue(rawValue), digits = raw.replace(/^\]C1/, "").replace(/\D/g, "");
  if ((raw.startsWith("]C1") || digits.startsWith("01")) && digits.length >= 15) return "GS1-128";
  if (/^\d{12,13}$/.test(raw)) return "JAN";
  return "UNKNOWN";
}
// 現調くんのparseJANに合わせ、AI(01)の3文字目から12桁を抽出する。
function parseGs1Barcode(rawValue) {
  const raw = normalizeValue(rawValue), digits = raw.replace(/^\]C1/, "").replace(/\D/g, "");
  if (!digits.startsWith("01") || digits.length < 15) return { ok: false, code: "GS1_PARSE_ERROR", message: "GS1-128のAI(01)から商品コードを取得できません。" };
  const comparisonJan = digits.substring(3, 15);
  if (!/^\d{12}$/.test(comparisonJan)) return { ok: false, code: "GS1_PARSE_ERROR", message: "GS1-128の商品コードが不正です。" };
  const gtin = digits.length >= 16 ? digits.slice(2, 16) : "";
  let remaining = digits.slice(16), expiryDate = "", lotNumber = "";
  if (remaining.startsWith("17") && remaining.length >= 8) { expiryDate = remaining.slice(2, 8); remaining = remaining.slice(8); }
  if (remaining.startsWith("10")) lotNumber = remaining.slice(2);
  return { ok: true, raw, gtin, jan: comparisonJan, comparisonJan, expiryDate, lotNumber };
}
function extractJanFromBarcode(rawValue) {
  const raw = normalizeValue(rawValue), type = detectProductBarcodeType(raw), readAt = new Date().toISOString();
  if (type === "JAN") return { ok: true, type, raw, readAt, jan: raw, comparisonJan: normalizeJanForComparison(raw), gtin: "", expiryDate: "", lotNumber: "" };
  if (type === "GS1-128") { const parsed = parseGs1Barcode(raw); return parsed.ok ? { ...parsed, type, readAt } : { ...parsed, type, raw, readAt }; }
  return { ok: false, type: "不明", raw, readAt, code: "PRODUCT_FORMAT", message: "JANまたはGS1-128として解析できません。" };
}
function validateProductBarcode(rawValue) {
  if (!state.pendingSpdLabel || state.mode !== "product") return { ok: false, code: "NO_PENDING", title: "SPDラベル未読取", message: "先にSPDラベルを読み取ってください。" };
  if (!state.masterInfo || !state.currentDepartment || !validateTargetPeriod().ok
    || !isRowInTargetPeriod(state.pendingSpdLabel.row) || !matchesCurrentDepartment(state.pendingSpdLabel.row)) {
    return { ok: false, code: "PENDING_CONDITION_CHANGED", title: "照合条件変更", message: "対象期間またはオリコン指定が変わりました。SPDラベル読取を取消して、再度読み取ってください。", pending: state.pendingSpdLabel };
  }
  const product = extractJanFromBarcode(rawValue);
  if (!product.ok) return { ...product, title: "商品バーコードエラー", pending: state.pendingSpdLabel };
  const masterJan = normalizeJanForComparison(state.pendingSpdLabel.row["JANコード"]);
  if (!masterJan) return { ok: false, code: "MASTER_JAN_INVALID", title: "マスターJAN不正", message: "TSVのJANコードを12桁比較値へ変換できません。", product, pending: state.pendingSpdLabel };
  if (product.comparisonJan !== masterJan) return { ok: false, code: "PRODUCT_MISMATCH", title: "商品違い", message: "SPDラベルの商品と読み取った商品が一致しません。", product, pending: state.pendingSpdLabel };
  return { ok: true, code: "PRODUCT_MATCH", title: "OK", message: "SPDラベルと商品が一致しました。", product, pending: state.pendingSpdLabel };
}

function formatLocalDateTime(isoValue) { if (!isoValue) return "―"; const date = new Date(isoValue); return Number.isNaN(date.getTime()) ? "―" : new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "medium" }).format(date); }
function createHistoryRecord({ result, detail = "", pending = null, product = null, skipReason = "", completedAt = "" }) {
  const source = pending || state.pendingSpdLabel, row = source?.row || {}, now = new Date().toISOString();
  return {
    eventAt: now, completedAt, spdReadAt: source?.spdReadAt || "", productReadAt: product?.readAt || (product ? now : ""),
    facilityCode: row["施設コード"] || state.currentDepartment?.facilityCode || "", facilityName: row["施設名称"] || state.currentDepartment?.facilityName || "",
    departmentCode: row["部署コード"] || state.currentDepartment?.departmentCode || "", departmentName: row["部署名称"] || state.currentDepartment?.departmentName || "",
    plannedDate: row["払出予定伝票日付"] || "", labelKey: source?.labelKey || "", productNumber: row["製品番号"] || "", productName: row["品名"] || "",
    masterJan: row["JANコード"] || "", scannedJan: product?.jan || "", productBarcodeType: product?.type || "",
    spdRaw: source?.spdRaw || "", productRaw: product?.raw || "", result, detail, skipReason
  };
}
function openHistoryDb(indexedDbRef = globalThis.indexedDB) {
  if (!indexedDbRef) return Promise.resolve(null);
  if (historyDbPromise) return historyDbPromise;
  historyDbPromise = new Promise((resolve, reject) => {
    const request = indexedDbRef.open(HISTORY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) { const store = db.createObjectStore(HISTORY_STORE_NAME, { keyPath: "id", autoIncrement: true }); store.createIndex("eventAt", "eventAt"); store.createIndex("result", "result"); }
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  return historyDbPromise;
}
async function saveScanHistory(record) {
  state.history.push(record); renderHistoryIfReady();
  try {
    const db = await openHistoryDb();
    if (db) await new Promise((resolve, reject) => { const request = db.transaction(HISTORY_STORE_NAME, "readwrite").objectStore(HISTORY_STORE_NAME).add(record); request.onsuccess = () => { record.id = request.result; resolve(); }; request.onerror = () => reject(request.error); });
  } catch (error) { console.error("読取履歴をIndexedDBへ保存できません。", error); }
  return record;
}
async function loadScanHistory() {
  try {
    const db = await openHistoryDb();
    if (db) state.history = await new Promise((resolve, reject) => { const request = db.transaction(HISTORY_STORE_NAME, "readonly").objectStore(HISTORY_STORE_NAME).getAll(); request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); });
  } catch (error) { console.error("読取履歴を読み込めません。", error); }
  renderHistoryIfReady(); return state.history;
}
async function clearScanHistory() {
  const db = await openHistoryDb();
  if (db) await new Promise((resolve, reject) => { const request = db.transaction(HISTORY_STORE_NAME, "readwrite").objectStore(HISTORY_STORE_NAME).clear(); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
  state.history = []; renderHistoryIfReady();
}
function saveNgHistory(result, product = null) {
  const pending = result.pending || (result.row ? { row: result.row, labelKey: result.labelKey || "", spdRaw: result.spdRaw || "", spdReadAt: "" } : state.pendingSpdLabel);
  return saveScanHistory(createHistoryRecord({ result: "NG", detail: result.title || result.code || "NG", pending, product }));
}
function didCompleteTarget(before, after) { return Boolean(state.currentDepartment) && validateTargetPeriod().ok && before.target > 0 && before.unread > 0 && after.unread === 0; }
function completeItemCheck(rawValue, effects = {}) {
  const validation = validateProductBarcode(rawValue);
  if (!validation.ok) {
    if (state.pendingSpdLabel && validation.product) state.pendingSpdLabel.lastProductAttempt = validation.product;
    saveState(); void saveNgHistory(validation, validation.product || null); (effects.playAlert || playAlertSound)();
    return { ...validation, completed: false, counts: getTargetCounts() };
  }
  const beforeCounts = getTargetCounts(), pending = state.pendingSpdLabel;
  state.readLabelKeys.add(pending.labelKey); state.processedResults.set(pending.labelKey, "OK");
  const record = createHistoryRecord({ result: "OK", detail: "商品一致", pending, product: validation.product, completedAt: new Date().toISOString() });
  state.pendingSpdLabel = null; state.mode = "spd"; saveState(); void saveScanHistory(record);
  const afterCounts = getTargetCounts(), targetCompleted = didCompleteTarget(beforeCounts, afterCounts);
  if (targetCompleted) (effects.playCompletion || playCompletionSound)();
  else (effects.playProductSuccess || effects.playSuccess || playProductSuccessSound)();
  return { ...validation, completed: true, targetCompleted, beforeCounts, afterCounts, record };
}
function canSkip() {
  return Boolean(state.masterInfo && state.currentDepartment && state.pendingSpdLabel && state.mode === "product"
    && validateTargetPeriod().ok && isRowInTargetPeriod(state.pendingSpdLabel.row) && matchesCurrentDepartment(state.pendingSpdLabel.row));
}
function executeSkip(reason = "作業者SKIP", effects = {}) {
  if (!canSkip()) return { ok: false, code: "SKIP_NOT_ALLOWED", title: "SKIPできません", message: "SPDラベル受付後の商品バーコード待ち状態でのみSKIPできます。" };
  const beforeCounts = getTargetCounts(), pending = state.pendingSpdLabel, product = pending.lastProductAttempt || null, skipReason = normalizeValue(reason) || "作業者SKIP";
  state.readLabelKeys.add(pending.labelKey); state.processedResults.set(pending.labelKey, "SKIP");
  const detail = skipReason === "マスターJANなし" ? "マスターJANなしによる自動SKIP" : "作業者確認済み";
  const record = createHistoryRecord({ result: "SKIP", detail, pending, product, skipReason, completedAt: new Date().toISOString() });
  state.pendingSpdLabel = null; state.mode = "spd"; saveState(); void saveScanHistory(record);
  const afterCounts = getTargetCounts(), completed = didCompleteTarget(beforeCounts, afterCounts);
  if (completed) (effects.playCompletion || playCompletionSound)();
  else (effects.playProductSuccess || playProductSuccessSound)();
  return { ok: true, code: "SKIP", title: "SKIP", message: "商品バーコード照合を作業者確認で完了しました。", record, completed, beforeCounts, afterCounts };
}

function formatDateForDisplay(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.replaceAll("-", "/") : "―"; }
function keyToDateInput(value) { return /^\d{8}$/.test(value || "") ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : ""; }
function todayInputValue() { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function getUniqueFacilityNames(rows) { return [...new Set(rows.map((row) => normalizeValue(row["施設名称"])).filter(Boolean))]; }
function getMasterFacilityName(rows) {
  const facilityNames = getUniqueFacilityNames(rows);
  if (facilityNames.length !== 1) throw new Error(`施設名称は1ファイルにつき1種類にしてください。検出数：${facilityNames.length}`);
  return facilityNames[0];
}
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEYS.state, JSON.stringify({ readLabelKeys: [...state.readLabelKeys], processedResults: [...state.processedResults.entries()], targetStartDate: state.targetStartDate, targetEndDate: state.targetEndDate, currentDepartment: state.currentDepartment, masterFingerprint: state.masterInfo?.fingerprint || null }));
    return true;
  } catch (error) { console.error("作業状態の保存に失敗しました。", error); showImportMessage("ブラウザに作業状態を保存できませんでした。空き容量やSafariの設定を確認してください。", true); return false; }
}
function saveMaster(rows, info) { const headers = Object.keys(rows[0] || {}).filter((header) => header !== "__lineNumber"); const records = rows.map((row) => headers.map((header) => row[header] ?? "")); localStorage.setItem(STORAGE_KEYS.master, JSON.stringify({ formatVersion: 2, headers, records, info })); }
function restoreState() {
  state.targetStartDate = todayInputValue(); state.targetEndDate = todayInputValue();
  try {
    const savedMaster = JSON.parse(localStorage.getItem(STORAGE_KEYS.master) || "null");
    if (savedMaster?.info && Array.isArray(savedMaster.records) && Array.isArray(savedMaster.headers)) { state.masterInfo = savedMaster.info; state.masterRows = savedMaster.records.map((record) => Object.fromEntries(savedMaster.headers.map((header, index) => [header, record[index] ?? ""]))); rebuildIndexes(); }
    else if (savedMaster?.info && Array.isArray(savedMaster.rows)) { state.masterInfo = savedMaster.info; state.masterRows = savedMaster.rows; rebuildIndexes(); }
  } catch (error) { console.error("保存済みマスターを読み込めません。", error); localStorage.removeItem(STORAGE_KEYS.master); }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.state) || localStorage.getItem("spd-shipping-state-v1") || "null");
    if (saved) {
      const legacy = saved.targetDate || ""; state.targetStartDate = saved.targetStartDate || legacy || state.targetStartDate; state.targetEndDate = saved.targetEndDate || legacy || state.targetEndDate;
      if (state.masterInfo && saved.masterFingerprint === state.masterInfo.fingerprint) {
        state.readLabelKeys = new Set(Array.isArray(saved.readLabelKeys) ? saved.readLabelKeys : []);
        state.processedResults = new Map(Array.isArray(saved.processedResults) ? saved.processedResults : [...state.readLabelKeys].map((key) => [key, "OK"]));
        state.currentDepartment = saved.currentDepartment || null; reconcileCurrentDepartment();
      }
    }
  } catch (error) { console.error("保存済み作業状態を読み込めません。", error); localStorage.removeItem(STORAGE_KEYS.state); }
  // pendingは再起動後に別商品へ引き継がないよう、意図的に保存・復元しない。
  state.pendingSpdLabel = null; state.mode = state.currentDepartment ? "spd" : "container"; if (state.masterInfo) saveState();
}
async function decodeMasterFile(file) { const buffer = await file.arrayBuffer(); try { return new TextDecoder("shift-jis", { fatal: true }).decode(buffer); } catch { throw new Error("TSVをCP932（Shift-JIS系）として読み込めませんでした。文字コードを確認してください。"); } }
async function loadMasterFile(file) {
  if (!file) throw new Error("TSVファイルが選択されていません。");
  if (!/\.tsv$/i.test(file.name)) throw new Error(".tsvファイルを選択してください。");
  const parsed = parseTsv(await decodeMasterFile(file)), dates = parsed.rows.map((row) => row["払出予定伝票日付"]).sort();
  return { rows: parsed.rows, info: { fileName: file.name, facilityName: getMasterFacilityName(parsed.rows), importedAt: new Date().toISOString(), rowCount: parsed.rows.length, maxDate: dates.at(-1), fingerprint: createFingerprint(file, parsed.rows) } };
}
function applyMasterData(rows, info) { saveMaster(rows, info); state.masterRows = rows; state.masterInfo = info; rebuildIndexes(); state.readLabelKeys = new Set(); state.processedResults = new Map(); state.currentDepartment = null; state.pendingSpdLabel = null; state.mode = "container"; saveState(); }
function createFingerprint(file, rows) { return `${file.name}:${file.size}:${file.lastModified}:${rows.length}:${rows[0]?.["ラベルキー"] || ""}:${rows.at(-1)?.["ラベルキー"] || ""}`; }
async function importMaster(file) {
  if (!file) return; showImportMessage("TSVを読み込み、内容を検証しています…", false);
  try { const data = await loadMasterFile(file); applyMasterData(data.rows, data.info); showImportMessage(`${data.rows.length}件を取り込みました。以前の作業状態はリセットしました。`, false, true); renderAll(); showResult("idle", "取込完了", "20桁のオリコンラベルを読み取ってください。", []); }
  catch (error) { console.error("TSV取込エラー", error); showImportMessage(`取込を中止しました。現在のマスターは変更していません。\n${error.message}`, true); playAlertSound(); }
  finally { elements.masterFile.value = ""; }
}

function initAudio() { if (!successSound) { successSound = new Audio("ok.wav"); successSound.preload = "auto"; } if (!productSuccessSound) { productSuccessSound = new Audio("product-ok.wav"); productSuccessSound.preload = "auto"; } if (!alertSound) { alertSound = new Audio("alert.wav"); alertSound.preload = "auto"; } if (!completionSound) { completionSound = new Audio("complete.wav"); completionSound.preload = "auto"; } successSound.load(); productSuccessSound.load(); alertSound.load(); completionSound.load(); }
async function unlockAudio() {
  initAudio(); const sounds = [successSound, productSuccessSound, alertSound, completionSound];
  try { sounds.forEach((sound) => { sound.muted = true; }); await Promise.all(sounds.map((sound) => sound.play())); sounds.forEach((sound) => { sound.pause(); sound.currentTime = 0; sound.muted = false; }); elements.audioStatus.textContent = "有効"; }
  catch (error) { sounds.forEach((sound) => { if (sound) sound.muted = false; }); elements.audioStatus.textContent = "有効化できません"; console.error("音声の有効化に失敗しました。", error); }
}
function playSound(label) { if (!successSound) initAudio(); const target = label === "success" ? successSound : label === "product-success" ? productSuccessSound : label === "completion" ? completionSound : alertSound; target.currentTime = 0; target.play().catch((error) => { console.error("音声を再生できません。", error); if (elements.audioStatus) elements.audioStatus.textContent = "要タップ確認"; }); }
function playSuccessSound() { playSound("success"); }
function playProductSuccessSound() { playSound("product-success"); }
function playAlertSound() { playSound("alert"); }
function playCompletionSound() { playSound("completion"); }
function handleContainerDepartmentScan(rawValue, effects = {}) { const result = setContainerDepartment(rawValue); if (result.ok) (effects.playSuccess || playSuccessSound)(); else (effects.playAlert || playAlertSound)(); return result; }

function getResultDetails(result) {
  const details = [], row = result.row || result.pending?.row;
  if (result.code === "DEPARTMENT_MISMATCH" && row) details.push(["オリコン側", `${state.currentDepartment.facilityName} ／ ${state.currentDepartment.departmentName}`], ["SPDラベル側", `${row["施設名称"]} ／ ${row["部署名称"]}`]);
  if (row) details.push(["製品番号", getProductNumber(row)], ["品名", row["品名"]]);
  if (["PRODUCT_MISMATCH", "PRODUCT_MATCH"].includes(result.code)) details.push(["TSV側JAN", result.pending.row["JANコード"]], ["読取種類", result.product.type], ["抽出JAN", result.product.jan]);
  if (result.labelKey) details.push(["ラベルキー", result.labelKey]);
  return details;
}
async function processScan(rawValue) {
  const value = normalizeValue(rawValue); if (!value) return;
  if (state.mode === "container") {
    if (/^\d{32}$/.test(value)) { const result = { code: "NO_DEPARTMENT", title: "オリコン未指定", message: "先に20桁のオリコンラベルを読み取ってください。", spdRaw: value }; void saveNgHistory(result); showResult("ng", result.title, result.message, []); playAlertSound(); }
    else { const result = handleContainerDepartmentScan(value); if (result.ok) { renderAll(); showResult("ok", "オリコン指定 OK", "SPDラベルQRを読み取ってください。", [["施設名称", result.department.facilityName], ["部署名称", result.department.departmentName], ["施設コード", result.department.facilityCode], ["部署コード", result.department.departmentCode]]); } else { void saveNgHistory(result); showResult("ng", result.title, result.message, []); } }
  } else if (state.mode === "spd") {
    if (!/^\d{32}$/.test(value)) { const result = { code: "SCAN_ORDER", title: "読取順序エラー", message: "SPDラベルを先に読み取ってください。" }; void saveNgHistory(result); showResult("ng", result.title, result.message, []); playAlertSound(); }
    else {
      const result = validateSpdLabel(value);
      if (result.ok) {
        const accepted = acceptOrAutoSkipSpdLabel(result);
        renderAll();
        if (accepted.autoSkipped) {
          showResult("skip", "自動SKIP", "マスターにJANコードがないため、SPDラベル確認で処理済にしました。", [["製品番号", getProductNumber(result.row)], ["品名", result.row["品名"]], ["SKIP理由", "マスターJANなし"], ["ラベルキー", result.labelKey]]);
        } else {
          showResult("pending", "商品バーコード待ち", result.message, [["製品番号", getProductNumber(result.row)], ["品名", result.row["品名"]], ["JAN", result.row["JANコード"]], ["ラベルキー", result.labelKey]]);
        }
      } else { void saveNgHistory(result); showResult("ng", result.title, result.message, getResultDetails(result)); playAlertSound(); }
    }
  } else if (/^\d{20}$/.test(value) || /^\d{32}$/.test(value)) {
    const result = { code: "SCAN_ORDER", title: "読取順序エラー", message: "現在の商品照合を完了するか、SPDラベル読取を取消してください。", pending: state.pendingSpdLabel };
    void saveNgHistory(result); showResult("ng", result.title, result.message, getResultDetails(result)); playAlertSound();
  } else {
    const result = completeItemCheck(value); renderAll(); showResult(result.ok ? "ok" : "ng", result.ok ? "OK" : result.title, result.message, getResultDetails(result));
  }
  if (elements.manualScanInput) elements.manualScanInput.value = "";
}
function handleClearDepartment() { clearContainerDepartment(); renderAll(); showResult("idle", "オリコン指定解除", "20桁のオリコンラベルを読み取ってください。", []); }
function handleCancelPending() { if (cancelPendingSpdLabel()) { renderAll(); showResult("idle", "キャンセル", "SPDラベル待ちへ戻りました。", []); } }
function handleSkip() {
  const result = executeSkip("作業者SKIP");
  renderAll();
  if (result.ok) showResult("skip", "SKIP", result.message, [["製品番号", result.record.productNumber], ["品名", result.record.productName], ["SKIP理由", result.record.skipReason], ["ラベルキー", result.record.labelKey]]);
  else { showResult("ng", result.title, result.message, []); playAlertSound(); }
}
function handleGlobalKeydown(event) {
  const ignored = [elements.manualScanInput, elements.targetStartDate, elements.targetEndDate, elements.masterFile, elements.historySearch, elements.historyStartDate, elements.historyEndDate, elements.historyFacility, elements.historyDepartment, elements.historyResult];
  if (ignored.includes(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "Enter") { if (state.scannerBuffer) { event.preventDefault(); const scan = state.scannerBuffer; state.scannerBuffer = ""; clearTimeout(state.scannerTimer); renderScannerStatus(); void processScan(scan); } return; }
  if (event.key.length === 1) { state.scannerBuffer += event.key; clearTimeout(state.scannerTimer); state.scannerTimer = setTimeout(() => { state.scannerBuffer = ""; renderScannerStatus(); }, 1500); renderScannerStatus(); }
}

function showResult(kind, title, message, details) {
  if (!elements.resultPanel) return;
  elements.resultPanel.className = `result-panel result-panel--${kind}`; elements.resultTitle.textContent = title; elements.resultMessage.textContent = message;
  elements.resultDetails.replaceChildren(...details.map(([term, description]) => { const wrapper = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = term; dd.textContent = description; wrapper.append(dt, dd); return wrapper; }));
}
function showImportMessage(message, isError, isSuccess = false) { if (elements.importMessage) { elements.importMessage.textContent = message; elements.importMessage.className = `import-message${isError ? " is-error" : isSuccess ? " is-ok" : ""}`; } }
function renderMode() { const modes = { container: ["mode-status--container", "● オリコンラベル待ち"], spd: ["mode-status--spd", "● SPDラベル待ち"], product: ["mode-status--product", "● 商品バーコード待ち"] }, current = modes[state.mode] || modes.container; elements.modeStatus.className = `mode-status ${current[0]}`; elements.modeStatus.textContent = current[1]; elements.clearDepartmentButton.disabled = !state.currentDepartment; }
function renderDepartment() { const department = state.currentDepartment; elements.currentFacility.textContent = department?.facilityName || "施設未指定"; elements.currentDepartment.textContent = department?.departmentName || "オリコンラベルを読み取ってください"; elements.currentDepartmentCode.textContent = `施設コード：${department?.facilityCode || "―"}　部署コード：${department?.departmentCode || "―"}`; }
function renderPendingPanel() { const pending = state.pendingSpdLabel; elements.pendingProductPanel.hidden = !pending; if (pending) { elements.pendingProductNumber.textContent = getProductNumber(pending.row); elements.pendingProductName.textContent = pending.row["品名"]; elements.skipButton.disabled = !canSkip(); } }
function renderCounts() {
  const period = validateTargetPeriod(), counts = getTargetCounts();
  elements.targetCount.textContent = counts.target; elements.readCount.textContent = counts.read; elements.unreadCount.textContent = counts.unread; elements.processingBreakdown.textContent = `OK：${counts.ok}件　SKIP：${counts.skip}件`;
  elements.unreadTargetCount.textContent = counts.target; elements.unreadReadCount.textContent = counts.read; elements.unreadRemainingCount.textContent = counts.unread; elements.periodError.textContent = period.ok ? "" : period.message;
  elements.unreadPeriodLabel.textContent = period.ok ? `対象期間：${formatDateForDisplay(state.targetStartDate)} ～ ${formatDateForDisplay(state.targetEndDate)}` : `対象期間：エラー（${period.message}）`;
  elements.unreadDepartmentLabel.textContent = state.currentDepartment ? `対象部署：${state.currentDepartment.facilityName} / ${state.currentDepartment.departmentName}` : "対象部署：指定なし（全体）";
}
function createEmptyState(message) { const element = document.createElement("p"); element.className = "empty-state"; element.textContent = message; return element; }
function renderUnreadList() {
  elements.unreadList.replaceChildren();
  if (!state.masterInfo) { elements.unreadList.append(createEmptyState("マスターを読み込んでください。")); return; }
  const period = validateTargetPeriod(); if (!period.ok) { elements.unreadList.append(createEmptyState(`対象期間を修正してください。${period.message}`)); return; }
  const rows = getUnreadLabels(); if (!rows.length) { elements.unreadList.append(createEmptyState(getTargetCounts().target ? "未読取ラベルはありません。" : "対象条件に該当するラベルはありません。")); return; }
  rows.forEach((row) => { const article = document.createElement("article"), title = document.createElement("h3"), product = document.createElement("p"), place = document.createElement("p"), key = document.createElement("p"); article.className = "unread-item"; title.textContent = row["品名"]; product.className = "item-product"; product.textContent = `製品番号：${getProductNumber(row)}　JAN：${row["JANコード"] || "―"}`; place.textContent = `${row["施設名称"]} ／ ${row["部署名称"]}`; key.className = "item-key"; key.textContent = `ラベルキー：${row["ラベルキー"]}`; article.append(title, product, place, key); elements.unreadList.append(article); });
}
function renderMasterInfo() {
  const info = state.masterInfo;
  const savedFacilityName = normalizeValue(info?.facilityName);
  const restoredFacilityNames = getUniqueFacilityNames(state.masterRows);
  const facilityName = savedFacilityName || (restoredFacilityNames.length === 1 ? restoredFacilityNames[0] : restoredFacilityNames.length > 1 ? "複数施設（再取込してください）" : "―");
  elements.masterStatusBadge.textContent = info ? "マスター読込済み" : "マスター未読込";
  elements.masterStatusBadge.className = `status-badge ${info ? "status-badge--ok" : "status-badge--ng"}`;
  elements.masterLoaded.textContent = info ? "読込済み" : "未読込";
  elements.masterFileName.textContent = info?.fileName || "―";
  elements.masterFacilityName.textContent = info ? facilityName : "―";
  elements.masterImportedAt.textContent = formatLocalDateTime(info?.importedAt);
  elements.masterRowCount.textContent = `${info?.rowCount || 0}件`;
  elements.masterMaxDate.textContent = info ? formatDateForDisplay(keyToDateInput(info.maxDate)) : "―";
}
function renderScannerStatus() { elements.scannerBufferStatus.textContent = state.scannerBuffer ? `Bluetoothリーダー入力中（${state.scannerBuffer.length}文字）` : "Bluetoothリーダー入力待機中"; }

function getHistoryFiltersFromUi() { return { startDate: elements.historyStartDate.value, endDate: elements.historyEndDate.value, facility: elements.historyFacility.value, department: elements.historyDepartment.value, result: elements.historyResult.value, search: elements.historySearch.value }; }
function filterHistory(records, filters = {}) {
  const start = filters.startDate ? `${filters.startDate}T00:00:00` : "", end = filters.endDate ? `${filters.endDate}T23:59:59.999` : "", search = normalizeValue(filters.search).toLowerCase();
  return records.filter((record) => { const timestamp = record.completedAt || record.eventAt || ""; if (start && timestamp < start || end && timestamp > end || filters.facility && record.facilityName !== filters.facility || filters.department && record.departmentName !== filters.department || filters.result && record.result !== filters.result) return false; return !search || [record.productNumber, record.productName, record.labelKey, record.masterJan, record.scannedJan].join(" ").toLowerCase().includes(search); });
}
function updateHistoryFilterOptions() {
  const setOptions = (select, values, label) => { const current = select.value; select.replaceChildren(new Option(label, ""), ...[...new Set(values.filter(Boolean))].sort().map((value) => new Option(value, value))); select.value = current; };
  setOptions(elements.historyFacility, state.history.map((item) => item.facilityName), "すべての施設"); setOptions(elements.historyDepartment, state.history.map((item) => item.departmentName), "すべての部署");
}
function renderHistory() {
  updateHistoryFilterOptions(); const records = filterHistory(state.history, getHistoryFiltersFromUi()).sort((a, b) => (b.eventAt || "").localeCompare(a.eventAt || ""));
  elements.historyCount.textContent = `${records.length}件`; elements.historyList.replaceChildren();
  if (!records.length) { elements.historyList.append(createEmptyState("条件に該当する履歴はありません。")); return; }
  records.slice(0, 500).forEach((record) => { const article = document.createElement("article"), heading = document.createElement("div"), result = document.createElement("strong"), time = document.createElement("time"), title = document.createElement("h3"), place = document.createElement("p"), detail = document.createElement("p"); article.className = `history-item history-item--${record.result.toLowerCase()}`; heading.className = "history-item-heading"; result.textContent = record.result; time.textContent = formatLocalDateTime(record.completedAt || record.eventAt); heading.append(result, time); title.textContent = `${record.productNumber || "―"}　${record.productName || ""}`; place.textContent = `${record.facilityName || "―"} ／ ${record.departmentName || "―"}`; detail.className = "item-key"; detail.textContent = `ラベル：${record.labelKey || "―"}　JAN：${record.scannedJan || record.masterJan || "―"}${record.skipReason ? `　理由：${record.skipReason}` : ""}`; article.append(heading, title, place, detail); elements.historyList.append(article); });
}
function renderHistoryIfReady() { if (elements.historyList) renderHistory(); }
function csvEscape(value) { const text = String(value ?? ""); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function buildHistoryCsv(records) {
  const columns = [["完了日時", "completedAt"], ["SPDラベル読取日時", "spdReadAt"], ["商品バーコード読取日時", "productReadAt"], ["施設コード", "facilityCode"], ["施設名称", "facilityName"], ["部署コード", "departmentCode"], ["部署名称", "departmentName"], ["払出予定伝票日付", "plannedDate"], ["ラベルキー", "labelKey"], ["製品番号", "productNumber"], ["品名", "productName"], ["TSV側JANコード", "masterJan"], ["読取商品JANコード", "scannedJan"], ["商品バーコード種別", "productBarcodeType"], ["SPD QR", "spdRaw"], ["商品バーコード", "productRaw"], ["判定結果", "result"], ["判定詳細", "detail"], ["SKIP理由", "skipReason"]];
  return [columns.map(([label]) => csvEscape(label)).join(","), ...records.map((record) => columns.map(([, key]) => csvEscape(record[key])).join(","))].join("\r\n");
}
function createHistoryCsvFile(records, name = `SPD読取履歴_${todayInputValue().replaceAll("-", "")}.csv`) { return new File(["\uFEFF", buildHistoryCsv(records)], name, { type: "text/csv;charset=utf-8" }); }
function downloadFile(file, documentRef = document) { const url = URL.createObjectURL(file), anchor = documentRef.createElement("a"); anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
// 現調くんと同じWeb Share APIを使い、非対応時だけダウンロードへ戻す。
async function shareHistoryCsv(records = filterHistory(state.history, getHistoryFiltersFromUi()), env = {}) {
  if (!records.length) throw new Error("共有対象の履歴がありません。");
  const navigatorRef = env.navigatorRef || navigator, documentRef = env.documentRef || document, file = createHistoryCsvFile(records);
  if (navigatorRef.canShare?.({ files: [file] }) && navigatorRef.share) { await navigatorRef.share({ title: "SPD出荷チェッカー 読取履歴", text: "読取履歴CSVです。", files: [file] }); return "shared"; }
  downloadFile(file, documentRef); return "downloaded";
}

function renderAll() { elements.targetStartDate.value = state.targetStartDate; elements.targetEndDate.value = state.targetEndDate; renderMode(); renderDepartment(); renderPendingPanel(); renderCounts(); renderUnreadList(); renderMasterInfo(); renderScannerStatus(); renderHistory(); }
function switchSection(sectionId) { document.querySelectorAll(".screen").forEach((section) => section.classList.toggle("is-active", section.id === sectionId)); document.querySelectorAll(".tab-button").forEach((button) => button.classList.toggle("is-active", button.dataset.section === sectionId)); if (sectionId === "unreadSection") renderUnreadList(); if (sectionId === "historySection") renderHistory(); window.scrollTo({ top: 0, behavior: "smooth" }); }
function cacheElements() {
  ["masterStatusBadge", "targetStartDate", "targetEndDate", "periodError", "modeStatus", "clearDepartmentButton", "currentFacility", "currentDepartment", "currentDepartmentCode", "resultPanel", "resultTitle", "resultMessage", "resultDetails", "pendingProductPanel", "pendingProductNumber", "pendingProductName", "skipButton", "cancelPendingButton", "processingBreakdown", "targetCount", "readCount", "unreadCount", "manualScanInput", "manualScanButton", "scannerBufferStatus", "refreshUnreadButton", "unreadPeriodLabel", "unreadDepartmentLabel", "unreadTargetCount", "unreadReadCount", "unreadRemainingCount", "unreadList", "historyStartDate", "historyEndDate", "historyFacility", "historyDepartment", "historyResult", "historySearch", "historyCount", "historyList", "shareHistoryButton", "clearHistoryButton", "historyMessage", "masterFile", "importMessage", "masterLoaded", "masterFileName", "masterFacilityName", "masterImportedAt", "masterRowCount", "masterMaxDate", "enableAudioButton", "audioStatus"].forEach((id) => { elements[id] = document.getElementById(id); });
}
function bindEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", () => switchSection(button.dataset.section)));
  elements.clearDepartmentButton.addEventListener("click", handleClearDepartment); elements.cancelPendingButton.addEventListener("click", handleCancelPending); elements.skipButton.addEventListener("click", handleSkip);
  const handlePeriodChange = () => {
    state.targetStartDate = elements.targetStartDate.value; state.targetEndDate = elements.targetEndDate.value;
    if (state.pendingSpdLabel && (!validateTargetPeriod().ok || !isRowInTargetPeriod(state.pendingSpdLabel.row))) cancelPendingSpdLabel();
    saveState(); renderMode(); renderPendingPanel(); renderCounts(); renderUnreadList();
  };
  elements.targetStartDate.addEventListener("change", handlePeriodChange); elements.targetEndDate.addEventListener("change", handlePeriodChange); elements.masterFile.addEventListener("change", () => importMaster(elements.masterFile.files[0])); elements.manualScanButton.addEventListener("click", () => void processScan(elements.manualScanInput.value)); elements.manualScanInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void processScan(elements.manualScanInput.value); } }); elements.refreshUnreadButton.addEventListener("click", () => { renderCounts(); renderUnreadList(); });
  [elements.historyStartDate, elements.historyEndDate, elements.historyFacility, elements.historyDepartment, elements.historyResult].forEach((input) => input.addEventListener("change", renderHistory)); elements.historySearch.addEventListener("input", renderHistory);
  elements.shareHistoryButton.addEventListener("click", async () => { try { const method = await shareHistoryCsv(); elements.historyMessage.textContent = method === "shared" ? "共有画面を開きました。メールアプリを選択できます。" : "共有非対応のためCSVをダウンロードしました。"; } catch (error) { if (error.name !== "AbortError") elements.historyMessage.textContent = error.message; } });
  elements.clearHistoryButton.addEventListener("click", async () => { if (!confirm("スマホ内の読取履歴をすべて削除します。元に戻せません。削除しますか？")) return; await clearScanHistory(); elements.historyMessage.textContent = "読取履歴をすべて削除しました。"; });
  elements.enableAudioButton.addEventListener("click", unlockAudio); window.addEventListener("keydown", handleGlobalKeydown);
}
async function init() { cacheElements(); restoreState(); initAudio(); bindEvents(); renderAll(); await loadScanHistory(); if (!state.masterInfo) showResult("idle", "待機中", "マスターを読み込んでください。", []); else if (!state.currentDepartment) showResult("idle", "待機中", "20桁のオリコンラベルを読み取ってください。", []); else showResult("idle", "待機中", "SPDラベルQRを読み取ってください。", []); document.body.dataset.appReady = "true"; }
function registerServiceWorker() {
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch((error) => console.error("オフライン機能を登録できません。", error)));
  }
}
if (typeof window !== "undefined") registerServiceWorker();
if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", () => { void init(); });

if (typeof module !== "undefined" && module.exports) module.exports = {
  state, parseTsv, normalizeQr, buildLabelKey, getExpectedCenterCode, rebuildIndexes, findLabel,
  parseContainerBarcode, setContainerDepartment, clearContainerDepartment, reconcileCurrentDepartment,
  validateSpdLabel, setPendingSpdLabel, acceptPendingSpdLabel, acceptOrAutoSkipSpdLabel, cancelPendingSpdLabel, validateTargetPeriod, getCurrentTargetLabels,
  getUnreadLabels, getTargetCounts, normalizeJanForComparison, detectProductBarcodeType, parseGs1Barcode,
  extractJanFromBarcode, validateProductBarcode, completeItemCheck, canSkip, executeSkip,
  createHistoryRecord, saveScanHistory, loadScanHistory, clearScanHistory, filterHistory, buildHistoryCsv,
  shareHistoryCsv, handleContainerDepartmentScan, applyMasterData, isValidDateKey, normalizeLabelKey,
  parseDateInput, getProductNumber, getUniqueFacilityNames, getMasterFacilityName
};
