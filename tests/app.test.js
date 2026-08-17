"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.localStorage = {
  values: new Map(),
  setItem(key, value) { this.values.set(key, String(value)); },
  getItem(key) { return this.values.get(key) ?? null; },
  removeItem(key) { this.values.delete(key); }
};

const app = require("../app.js");
const {
  state, parseTsv, normalizeQr, buildLabelKey, getExpectedCenterCode, rebuildIndexes,
  parseContainerBarcode, setContainerDepartment, clearContainerDepartment, reconcileCurrentDepartment,
  validateSpdLabel, setPendingSpdLabel, acceptPendingSpdLabel, cancelPendingSpdLabel, validateTargetPeriod,
  getCurrentTargetLabels, getUnreadLabels, getTargetCounts, normalizeJanForComparison,
  detectProductBarcodeType, parseGs1Barcode, extractJanFromBarcode, validateProductBarcode,
  completeItemCheck, canSkip, executeSkip, createHistoryRecord, saveScanHistory,
  loadScanHistory, filterHistory, buildHistoryCsv, shareHistoryCsv, handleContainerDepartmentScan,
  applyMasterData, isValidDateKey, getProductNumber
} = app;

const FACILITY_A = "1234567890";
const FACILITY_B = "0987654321";
const DEPARTMENT_A = "0000000001";
const DEPARTMENT_B = "0000000002";
const CONTAINER_A = FACILITY_A + DEPARTMENT_A;
const QR_A = "00000000010000000001058190006001";
const QR_B = "00000000010000000000000020003004";
const JAN_A = "4901234567894";
const JAN_B = "4987654321098";
const GS1_A = "]C101049012345678941726123110LOT1";

const header = "施設コード\t施設名称\t部署コード\t部署名称\t品名\t製品番号\tJANコード\tラベルキー\t払出予定伝票日付";
const lines = [
  `${FACILITY_A}\t通常病院\t${DEPARTMENT_A}\t手術室\t商品A\tPN-A\t${JAN_A}\t105819-6-1\t20260817`,
  `${FACILITY_A}\t通常病院\t${DEPARTMENT_A}\t手術室\t商品B\tPN-B\t${JAN_B}\t2-3-4\t20260817`,
  `${FACILITY_B}\t千葉白井病院\t${DEPARTMENT_A}\t病棟\t商品C\tPN-C\t4901111111111\t5-6-7\t20260818`,
  `${FACILITY_A}\t通常病院\t${DEPARTMENT_B}\t外来\t商品D\tPN-D\t4902222222222\t8-9-10\t20260818`
];
const parsed = parseTsv(`${header}\r\n${lines.join("\r\n")}`);

function reset(rows = parsed.rows, start = "2026-08-17", end = "2026-08-17") {
  state.masterRows = rows;
  state.masterInfo = { fingerprint: "test", rowCount: rows.length };
  state.readLabelKeys = new Set();
  state.processedResults = new Map();
  state.history = [];
  state.currentDepartment = null;
  state.pendingSpdLabel = null;
  state.mode = "container";
  state.targetStartDate = start;
  state.targetEndDate = end;
  rebuildIndexes();
}

function setContainer() {
  const result = setContainerDepartment(CONTAINER_A);
  assert.equal(result.ok, true);
  return result;
}

function acceptSpd(qr = QR_A) {
  const result = validateSpdLabel(qr);
  assert.equal(result.ok, true);
  assert.equal(setPendingSpdLabel(result, new Date("2026-08-17T01:00:00.000Z")), true);
  return result;
}

(async () => {
  // 既存TSV・日付・QRロジック。
  assert.equal(parsed.rows.length, 4);
  assert.equal(parseTsv(`${header}\n${FACILITY_A}\t通常病院\t${DEPARTMENT_A}\t手術室\t"商品\tA"\tPN-X\t${JAN_A}\t1-2-3\t20260817`).rows[0]["品名"], "商品\tA");
  assert.throws(() => parseTsv("施設名称\t部署コード\n病院\tD01"), /必須列/);
  assert.throws(() => parseTsv(`${header}\n${FACILITY_A}\t通常病院\t${DEPARTMENT_A}\t手術室\t商品\tPN-X\t${JAN_A}\t1-2-3\t20260230`), /正しい日付/);
  assert.throws(() => parseTsv(`${header}\n${FACILITY_A}\t通常病院\t${DEPARTMENT_A}\t手術室\t商品\tPN-X\tABC\t1-2-3\t20260817`), /JANコード/);
  assert.equal(isValidDateKey("20260228"), true);
  assert.equal(isValidDateKey("20260229"), false);
  assert.equal(buildLabelKey("000000000105819", "0006", "001"), "105819-6-1");
  assert.equal(normalizeQr(QR_A).labelKey, "105819-6-1");
  assert.equal(normalizeQr("123").code, "QR_FORMAT");
  assert.equal(getExpectedCenterCode("千葉白井病院"), "0000000002");
  assert.equal(getExpectedCenterCode("湘南ﾘﾊﾋﾞﾘﾃｰｼｮﾝ病院"), "0000000002");
  assert.equal(getProductNumber(parsed.rows[0]), "PN-A");

  // オリコン20桁：10桁＋10桁。先頭ゼロを保持する。
  assert.deepEqual(parseContainerBarcode(CONTAINER_A), { ok: true, raw: CONTAINER_A, facilityCode: FACILITY_A, departmentCode: DEPARTMENT_A });
  assert.equal(parseContainerBarcode("123").code, "CONTAINER_FORMAT");
  reset();
  const container = setContainer();
  assert.equal(container.department.facilityCode, FACILITY_A);
  assert.equal(container.department.departmentCode, DEPARTMENT_A);
  assert.equal(state.mode, "spd");
  assert.equal(setContainerDepartment(FACILITY_B + DEPARTMENT_B).code, "CONTAINER_NOT_FOUND");
  assert.equal(setContainerDepartment(FACILITY_B + DEPARTMENT_A).ok, true, "同じ部署コードでも施設コードとの組合せで特定する");
  reset();
  assert.equal(setContainerDepartment(FACILITY_A + "9999999999").code, "CONTAINER_NOT_FOUND");

  const ambiguousRows = parsed.rows.concat({ ...parsed.rows[0], "施設名称": "別名病院" });
  reset(ambiguousRows);
  assert.equal(setContainerDepartment(CONTAINER_A).code, "AMBIGUOUS_DEPARTMENT");

  // 期間と施設＋部署の対象抽出。
  reset();
  assert.deepEqual(getCurrentTargetLabels().map((row) => row["ラベルキー"]), ["105819-6-1", "2-3-4"]);
  state.targetEndDate = "2026-08-18";
  assert.equal(getCurrentTargetLabels().length, 4);
  state.targetStartDate = "2026-08-19";
  assert.equal(validateTargetPeriod().code, "RANGE_REVERSED");
  assert.deepEqual(getTargetCounts(), { target: 0, read: 0, unread: 0, ok: 0, skip: 0 });
  reset(parsed.rows, "2026-08-17", "2026-08-18");
  setContainer();
  assert.deepEqual(getTargetCounts(), { target: 2, read: 0, unread: 2, ok: 0, skip: 0 });
  clearContainerDepartment();
  assert.equal(getTargetCounts().target, 4);

  // 部署指定音。
  reset();
  let successSounds = 0, alertSounds = 0;
  const containerWithSound = handleContainerDepartmentScan(CONTAINER_A, { playSuccess: () => { successSounds += 1; }, playAlert: () => { alertSounds += 1; } });
  assert.equal(containerWithSound.ok, true);
  assert.equal(successSounds, 1);
  reset();
  handleContainerDepartmentScan(FACILITY_A + "9999999999", { playSuccess: () => {}, playAlert: () => { alertSounds += 1; } });
  assert.equal(alertSounds, 1);

  // SPDは仮受付のみ。件数・未読取数を動かさない。
  reset(); setContainer();
  const spd = validateSpdLabel(QR_A);
  assert.equal(spd.ok, true);
  let spdAcceptSounds = 0;
  assert.equal(acceptPendingSpdLabel(spd, { playSuccess: () => { spdAcceptSounds += 1; } }), true);
  assert.equal(spdAcceptSounds, 1, "SPDラベル仮受付時に既存成功音を鳴らす");
  assert.equal(state.mode, "product");
  assert.equal(state.pendingSpdLabel.labelKey, "105819-6-1");
  assert.deepEqual(getTargetCounts(), { target: 2, read: 0, unread: 2, ok: 0, skip: 0 });
  assert.equal(getUnreadLabels().length, 2);
  assert.equal(cancelPendingSpdLabel(), true);
  assert.equal(state.mode, "spd");
  assert.equal(getTargetCounts().read, 0);

  reset(); setContainer();
  assert.equal(validateSpdLabel("00000000020000000001058190006001").code, "CENTER_MISMATCH");
  assert.equal(validateSpdLabel("00000000020000000000000050006007").code, "DEPARTMENT_MISMATCH");
  state.targetStartDate = "2026-08-18"; state.targetEndDate = "2026-08-18";
  assert.equal(validateSpdLabel(QR_A).code, "OUTSIDE_PERIOD");
  clearContainerDepartment();
  assert.equal(validateSpdLabel(QR_A).code, "NO_DEPARTMENT");

  // 現調くんと同じJAN / GS1-128抽出。
  assert.equal(normalizeJanForComparison(JAN_A), "490123456789");
  assert.equal(normalizeJanForComparison("4901234567899"), "490123456789", "チェックデジットだけ違っても先頭12桁一致");
  assert.equal(detectProductBarcodeType(JAN_A), "JAN");
  assert.equal(detectProductBarcodeType(GS1_A), "GS1-128");
  assert.equal(extractJanFromBarcode(JAN_A).comparisonJan, "490123456789");
  assert.equal(parseGs1Barcode(GS1_A).comparisonJan, "490123456789");
  assert.equal(parseGs1Barcode("17123101").ok, false);

  // JAN一致後にだけ完了登録。商品違いではpendingを維持して再読取できる。
  reset(); setContainer(); acceptSpd();
  assert.equal(validateProductBarcode(JAN_A).ok, true);
  let productSuccessSounds = 0, completeSounds = 0, productAlertSounds = 0;
  const firstCompleted = completeItemCheck(JAN_A, { playProductSuccess: () => { productSuccessSounds += 1; }, playCompletion: () => { completeSounds += 1; }, playAlert: () => { productAlertSounds += 1; } });
  assert.equal(firstCompleted.completed, true);
  assert.equal(state.mode, "spd");
  assert.equal(state.readLabelKeys.has("105819-6-1"), true);
  assert.deepEqual(getTargetCounts(), { target: 2, read: 1, unread: 1, ok: 1, skip: 0 });
  assert.equal(productSuccessSounds, 1, "商品一致時は新しい商品照合成功音を鳴らす");
  assert.equal(state.history.at(-1).result, "OK");
  assert.equal(state.history.at(-1).productRaw, JAN_A);
  assert.equal(validateSpdLabel(QR_A).code, "DUPLICATE");

  reset(); setContainer(); acceptSpd();
  const mismatch = completeItemCheck(JAN_B, { playSuccess: () => {}, playCompletion: () => {}, playAlert: () => { productAlertSounds += 1; } });
  assert.equal(mismatch.code, "PRODUCT_MISMATCH");
  assert.equal(state.mode, "product");
  assert.equal(state.pendingSpdLabel.labelKey, "105819-6-1");
  assert.equal(getTargetCounts().read, 0);
  assert.equal(state.history.at(-1).result, "NG");
  const retry = completeItemCheck(JAN_A, { playProductSuccess: () => { productSuccessSounds += 1; }, playCompletion: () => {}, playAlert: () => {} });
  assert.equal(retry.ok, true);
  assert.equal(state.mode, "spd");
  assert.equal(productAlertSounds, 1);

  // GS1一致・不一致。
  reset(); setContainer(); acceptSpd();
  assert.equal(validateProductBarcode(GS1_A).ok, true);
  cancelPendingSpdLabel(); acceptSpd();
  assert.equal(validateProductBarcode("]C1010499999999999917261231").code, "PRODUCT_MISMATCH");

  // 最終商品一致時だけcomplete.wav。SPD受付時点では鳴らない。
  reset(); setContainer();
  state.readLabelKeys.add("2-3-4"); state.processedResults.set("2-3-4", "OK");
  acceptSpd();
  assert.equal(completeSounds, 0);
  const productSoundsBeforeFinal = productSuccessSounds;
  const finalOk = completeItemCheck(JAN_A, { playProductSuccess: () => { productSuccessSounds += 1; }, playCompletion: () => { completeSounds += 1; }, playAlert: () => {} });
  assert.equal(finalOk.targetCompleted, true);
  assert.equal(completeSounds, 1);
  assert.equal(productSuccessSounds, productSoundsBeforeFinal, "最後の1件では商品成功音を完了音に重ねない");
  assert.equal(getTargetCounts().unread, 0);

  // SKIPは商品待ちだけ。件数・履歴・二重読取・完了音を確認。
  reset(); setContainer();
  assert.equal(canSkip(), false);
  assert.equal(executeSkip().code, "SKIP_NOT_ALLOWED");
  acceptSpd();
  assert.equal(canSkip(), true);
  state.targetStartDate = "2026-08-18"; state.targetEndDate = "2026-08-18";
  assert.equal(canSkip(), false, "pendingの商品が現在の対象期間外になった場合はSKIPできない");
  assert.equal(validateProductBarcode(JAN_A).code, "PENDING_CONDITION_CHANGED");
  state.targetStartDate = "2026-08-17"; state.targetEndDate = "2026-08-17";
  let skipProductSounds = 0;
  const skipped = executeSkip("バーコードなし", { playProductSuccess: () => { skipProductSounds += 1; }, playCompletion: () => { completeSounds += 1; } });
  assert.equal(skipped.ok, true);
  assert.equal(state.mode, "spd");
  assert.equal(state.readLabelKeys.has("105819-6-1"), true);
  assert.deepEqual(getTargetCounts(), { target: 2, read: 1, unread: 1, ok: 0, skip: 1 });
  assert.equal(skipped.record.result, "SKIP");
  assert.equal(skipped.record.skipReason, "バーコードなし");
  assert.equal(skipped.record.productRaw, "");
  assert.equal(skipProductSounds, 1, "通常SKIP時に商品照合成功の3音を鳴らす");
  assert.equal(validateSpdLabel(QR_A).code, "DUPLICATE");

  // 商品違い後SKIPは直前の商品バーコードも履歴へ残す。
  reset(); setContainer(); acceptSpd();
  completeItemCheck(JAN_B, { playSuccess: () => {}, playCompletion: () => {}, playAlert: () => {} });
  const mismatchSkip = executeSkip("商品確認済み", { playProductSuccess: () => { skipProductSounds += 1; }, playCompletion: () => {} });
  assert.equal(mismatchSkip.record.productRaw, JAN_B);
  assert.equal(mismatchSkip.record.scannedJan, JAN_B);
  assert.equal(state.history.some((item) => item.result === "NG"), true);
  assert.equal(state.history.some((item) => item.result === "SKIP"), true);

  // 最後の1件をSKIPしても完了音。取消はSKIPにならない。
  reset(); setContainer(); state.readLabelKeys.add("2-3-4"); state.processedResults.set("2-3-4", "OK"); acceptSpd();
  let skipCompleteSounds = 0;
  const skipSoundsBeforeFinal = skipProductSounds;
  const finalSkip = executeSkip("作業者SKIP", { playProductSuccess: () => { skipProductSounds += 1; }, playCompletion: () => { skipCompleteSounds += 1; } });
  assert.equal(finalSkip.completed, true);
  assert.equal(skipCompleteSounds, 1);
  assert.equal(skipProductSounds, skipSoundsBeforeFinal, "最後のSKIPでは3音を完了音に重ねない");
  assert.deepEqual(getTargetCounts(), { target: 2, read: 2, unread: 0, ok: 1, skip: 1 });
  reset(); setContainer(); acceptSpd(); cancelPendingSpdLabel();
  assert.equal(state.history.length, 0);
  assert.equal(state.readLabelKeys.size, 0);

  // 履歴保存・再読込・絞込・CSV・Web Share。
  reset();
  const basePending = { row: parsed.rows[0], labelKey: "105819-6-1", spdRaw: QR_A, spdReadAt: "2026-08-17T01:00:00.000Z" };
  const okRecord = createHistoryRecord({ result: "OK", detail: "商品一致", pending: basePending, product: extractJanFromBarcode(JAN_A), completedAt: "2026-08-17T01:01:00.000Z" });
  const skipRecord = createHistoryRecord({ result: "SKIP", detail: "作業者確認済み", pending: basePending, skipReason: "バーコードなし", completedAt: "2026-08-18T01:01:00.000Z" });
  await saveScanHistory(okRecord);
  await saveScanHistory(skipRecord);
  assert.equal((await loadScanHistory()).length, 2);
  assert.equal(filterHistory(state.history, { result: "SKIP" }).length, 1);
  assert.equal(filterHistory(state.history, { startDate: "2026-08-18", endDate: "2026-08-18" }).length, 1);
  assert.equal(filterHistory(state.history, { facility: "通常病院", department: "手術室", search: "PN-A" }).length, 2);
  const csv = buildHistoryCsv(state.history);
  assert.equal(csv.includes("判定結果"), true);
  assert.equal(csv.includes("SKIP理由"), true);
  assert.equal(csv.includes("バーコードなし"), true);
  let sharedPayload = null;
  const method = await shareHistoryCsv([skipRecord], { navigatorRef: { canShare: () => true, share: async (payload) => { sharedPayload = payload; } }, documentRef: {} });
  assert.equal(method, "shared");
  assert.equal(sharedPayload.files[0].name.endsWith(".csv"), true);

  // 新マスター適用時は稼働中の作業状態をリセットし、監査履歴は別保存のため維持する。
  reset(); setContainer(); acceptSpd(); state.readLabelKeys.add("105819-6-1"); state.history.push({ result: "OK" });
  applyMasterData(parsed.rows.filter((row) => row["部署コード"] === DEPARTMENT_B), { fingerprint: "new", rowCount: 1 });
  assert.equal(state.currentDepartment, null);
  assert.equal(state.pendingSpdLabel, null);
  assert.equal(state.readLabelKeys.size, 0);
  assert.equal(state.history.length, 1);
  state.masterRows = parsed.rows; rebuildIndexes(); state.currentDepartment = { facilityCode: FACILITY_A, facilityName: "通常病院", departmentCode: DEPARTMENT_A, departmentName: "手術室" };
  state.masterRows = parsed.rows.filter((row) => row["部署コード"] === DEPARTMENT_B); rebuildIndexes();
  assert.equal(reconcileCurrentDepartment(), false);

  // UI構造と削除済みDOM参照。
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");
  for (const id of ["containerModeButton", "spdModeButton"]) { assert.equal(indexSource.includes(id), false); assert.equal(appSource.includes(id), false); }
  for (const id of ["pendingProductPanel", "skipButton", "cancelPendingButton", "historySection", "historyResult"]) assert.equal(indexSource.includes(`id="${id}"`), true);
  for (const removedId of ["skipDialog", "skipReason", "confirmSkipButton", "cancelSkipButton"]) {
    assert.equal(indexSource.includes(removedId), false, `${removedId}確認UIを削除`);
    assert.equal(appSource.includes(`elements.${removedId}`), false, `${removedId}へのDOM参照を削除`);
  }
  assert.equal(indexSource.indexOf('id="skipButton"') < indexSource.indexOf('id="cancelPendingButton"'), true, "SKIPを取消より先に配置");
  for (const section of ["checkSection", "unreadSection", "historySection", "masterSection"]) assert.equal(styleSource.includes(`.tab-button[data-section="${section}"]`), true);
  assert.equal(styleSource.includes(".result-panel--skip"), true);
  assert.equal(styleSource.includes("@media (max-width: 500px)"), true);
  assert.equal(appSource.includes('new Audio("product-ok.wav")'), true, "商品照合成功音を読み込む");
  assert.equal(fs.existsSync(path.join(__dirname, "..", "product-ok.wav")), true, "商品照合成功音ファイルが存在する");

  // GitHub PagesとiPhoneホーム画面用のPWA構成。
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.name, "SPD出荷チェッカー");
  assert.equal(manifest.short_name, "SPD出荷");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(indexSource.includes('rel="apple-touch-icon"'), true);
  assert.equal(indexSource.includes('rel="manifest"'), true);
  assert.equal(indexSource.includes('apple-mobile-web-app-capable'), true);
  assert.equal(appSource.includes('navigator.serviceWorker.register("./service-worker.js")'), true);
  const readPngSize = (fileName) => {
    const png = fs.readFileSync(path.join(__dirname, "..", "icons", fileName));
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };
  assert.deepEqual(readPngSize("favicon-32.png"), [32, 32]);
  assert.deepEqual(readPngSize("apple-touch-icon.png"), [180, 180]);
  assert.deepEqual(readPngSize("icon-192.png"), [192, 192]);
  assert.deepEqual(readPngSize("icon-512.png"), [512, 512]);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "service-worker.js")), true);

  console.log("app.test.js: 3点照合・履歴・SKIPの全テストに合格しました。");
})().catch((error) => { console.error(error); process.exitCode = 1; });
