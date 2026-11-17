'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../logic.js');

// 決まった順番で乱数を返すスタブ。使い切ったら例外にして「余計な抽選」を検出する
function seq(values) {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error('rng exhausted at call ' + i);
    return values[i++];
  };
}
const H = 0.1; // 1/4.13 に当たる値
const M = 0.9; // 外れる値

// ---- 定数 ----

test('基本定数', () => {
  assert.equal(L.P_HIT, 1 / 319.7);
  assert.equal(L.P_RUSH, 1 / 144.7);
  assert.equal(L.RUSH_ST_COUNT, 100);
  assert.equal(L.P_CHARGE, 1 / 4.13);
  assert.equal(L.P_RECHARGE, 0.62);
  assert.equal(L.P_RUSH_ENTRY, 0.5);
  assert.equal(L.HOLD_MAX, 4);
  assert.deepEqual(L.SPIN_RATE_OPTIONS, [22, 25, 26.3, 28, 31]);
  assert.equal(L.DEFAULT_SPIN_RATE, 26.3);
  assert.equal(L.calcSpinCost(26.3), 250 / 26.3);
  assert.equal(L.FIRST_HIT_NOMINAL, 300);
  assert.equal(L.FIRST_HIT_ACTUAL, 280);
  assert.equal(L.CHARGE_HIT_NOMINAL, 1500);
  assert.equal(L.CHARGE_HIT_ACTUAL, 1400);
});

// ---- 通常時 ----

test('spinNormal: 当たり・偽先咆哮・はずれ', () => {
  assert.equal(L.spinNormal(seq([0])), 'hit');
  assert.equal(L.spinNormal(seq([0.5, 0])), 'false_enzoku');
  assert.equal(L.spinNormal(seq([0.5, 0.5])), 'miss');
});

test('偽先咆哮の確率は信頼度60%になる量', () => {
  const p = L.falseEnzokuProbability();
  assert.ok(Math.abs(L.P_HIT / (L.P_HIT + p) - 0.6) < 1e-12);
});

// ---- チャージ補助 ----

test('rollUntilHit: 当たるまでの回転数を返す', () => {
  assert.equal(L.rollUntilHit(seq([H])), 1);
  assert.equal(L.rollUntilHit(seq([M, M, H])), 3);
});

test('fillHolds: 既存の保留を残して4個まで補充する', () => {
  assert.deepEqual(L.fillHolds([], seq([H, M, M, H])), [true, false, false, true]);
  assert.deepEqual(L.fillHolds([true, false], seq([M, H])), [true, false, false, true]);
  assert.deepEqual(L.fillHolds([false, false, false, false], seq([])), [false, false, false, false]);
});

test('classifyCharge', () => {
  assert.equal(L.classifyCharge(1500), 'b1500');
  assert.equal(L.classifyCharge(3000), 'b3000');
  assert.equal(L.classifyCharge(4500), 'savanna');
  assert.equal(L.classifyCharge(13500), 'savanna');
});

// ---- applyChargeStep ----

function runAll(state, rng) {
  const events = [];
  while (state.phase !== 'done') {
    const r = L.applyChargeStep(state, rng);
    state = r.state;
    events.push(r.event);
  }
  return { state, events };
}

test('初回の当該: 再チャージ判定なしで保留4個をためる', () => {
  const s0 = L.createChargeState();
  assert.equal(s0.phase, 'gai_initial');
  const { state, event } = L.applyChargeStep(s0, seq([M, H, M, M, M, M]));
  assert.deepEqual(event, { type: 'gai', initial: true, spins: 2, recharge: null });
  assert.equal(state.phase, 'holds');
  assert.equal(state.nominal, 1500);
  assert.equal(state.actual, 1400);
  assert.equal(state.hits, 1);
  assert.equal(state.recharge, false);
  assert.deepEqual(state.holds, [false, false, false, false]);
});

test('保留全ハズレ → 1500で終了', () => {
  const { state, events } = runAll(L.createChargeState(), seq([H, M, M, M, M]));
  assert.equal(state.nominal, 1500);
  assert.equal(events.length, 5);
  assert.deepEqual(events[1], { type: 'hold', hit: false, rechargeResult: null, refilled: false });
  assert.equal(L.classifyCharge(state.nominal), 'b1500');
});

test('保留1個当たり・再チャージ失敗 → 3000で終了', () => {
  const { state, events } = runAll(L.createChargeState(), seq([H, H, M, M, M, M]));
  assert.equal(state.nominal, 3000);
  assert.equal(state.actual, 2800);
  assert.deepEqual(events[1], { type: 'hold', hit: true, rechargeResult: false, refilled: false });
  assert.equal(L.classifyCharge(state.nominal), 'b3000');
});

test('再チャージ成功: 残りの保留を保持したまま4個に補充し、権利を得る', () => {
  let { state } = L.applyChargeStep(L.createChargeState(), seq([H, H, H, M, M]));
  // holds = [true, true, false, false]
  const r = L.applyChargeStep(state, seq([H, M]));
  assert.deepEqual(r.event, { type: 'hold', hit: true, rechargeResult: true, refilled: true });
  assert.deepEqual(r.state.holds, [true, false, false, false]);
  assert.equal(r.state.recharge, true);
  assert.equal(r.state.nominal, 3000);
});

test('権利ありで保留切れ → 再チャージ当該 → 保留4個', () => {
  // 初回当該H, 保留[H,M,M,M], 1個目当たり・再チャージ成功(H)・補充M
  let state = L.applyChargeStep(L.createChargeState(), seq([H, H, M, M, M])).state;
  state = L.applyChargeStep(state, seq([H, M])).state; // holds [F,F,F,F], recharge true
  for (let i = 0; i < 3; i++) state = L.applyChargeStep(state, seq([])).state;
  const last = L.applyChargeStep(state, seq([]));
  assert.equal(last.state.phase, 'gai_recharge');
  assert.equal(last.state.holds.length, 0);
  // 再チャージ当該: 3回転目で当たり、再チャージ判定失敗、保留4個補充
  const g = L.applyChargeStep(last.state, seq([M, M, H, M, M, M, M, M]));
  assert.deepEqual(g.event, { type: 'gai', initial: false, spins: 3, recharge: false });
  assert.equal(g.state.phase, 'holds');
  assert.equal(g.state.recharge, false);
  assert.equal(g.state.nominal, 4500);
  assert.equal(g.state.hits, 3);
  assert.deepEqual(g.state.holds, [false, false, false, false]);
  const end = runAll(g.state, seq([]));
  assert.equal(end.state.nominal, 4500);
  assert.equal(L.classifyCharge(end.state.nominal), 'savanna');
});

test('再チャージ当該でも再チャージ判定に成功すれば権利を得る', () => {
  const s = { ...L.createChargeState(), phase: 'gai_recharge', recharge: true, nominal: 3000, actual: 2800, hits: 2 };
  const g = L.applyChargeStep(s, seq([H, H, M, M, M, M]));
  assert.equal(g.event.recharge, true);
  assert.equal(g.state.recharge, true);
});

test('権利は次の当たりで消費され、改めて判定される', () => {
  const s = { ...L.createChargeState(), phase: 'holds', recharge: true, holds: [true, false], nominal: 3000, actual: 2800, hits: 2 };
  const r = L.applyChargeStep(s, seq([M]));
  assert.equal(r.event.rechargeResult, false);
  assert.equal(r.state.recharge, false);
  assert.deepEqual(r.state.holds, [false]);
});

test('ハズレの保留では権利は消費されない', () => {
  const s = { ...L.createChargeState(), phase: 'holds', recharge: true, holds: [false, false], nominal: 3000, actual: 2800, hits: 2 };
  const r = L.applyChargeStep(s, seq([]));
  assert.equal(r.state.recharge, true);
});

test('権利なしで保留切れ → done、doneでは何も起きない', () => {
  const s = { ...L.createChargeState(), phase: 'holds', recharge: false, holds: [false], nominal: 1500, actual: 1400, hits: 1 };
  const r = L.applyChargeStep(s, seq([]));
  assert.equal(r.state.phase, 'done');
  const d = L.applyChargeStep(r.state, seq([]));
  assert.equal(d.event, null);
  assert.equal(d.state, r.state);
});

test('applyChargeStep は元の状態を書き換えない', () => {
  const s = { ...L.createChargeState(), phase: 'holds', recharge: false, holds: [true, false], nominal: 1500, actual: 1400, hits: 1 };
  const snapshot = JSON.parse(JSON.stringify(s));
  L.applyChargeStep(s, seq([H, M, M, M]));
  assert.deepEqual(s, snapshot);
});

test('統計: 振り分けとサバンナチャンス平均が仕様どおり', () => {
  const N = 200000;
  let b1500 = 0, b3000 = 0, sc = 0, scSum = 0;
  for (let i = 0; i < N; i++) {
    const { state } = runAll(L.createChargeState(), Math.random);
    const k = L.classifyCharge(state.nominal);
    if (k === 'b1500') b1500++;
    else if (k === 'b3000') b3000++;
    else { sc++; scSum += state.nominal; }
  }
  assert.ok(Math.abs(b1500 / N - 0.33) < 0.015, `1500: ${b1500 / N}`);
  assert.ok(Math.abs(b3000 / N - 0.16) < 0.015, `3000: ${b3000 / N}`);
  assert.ok(Math.abs(sc / N - 0.51) < 0.015, `SC: ${sc / N}`);
  assert.ok(Math.abs(scSum / sc - 9860) < 300, `SC平均: ${scSum / sc}`);
});

// ---- 獣王RUSH ----

test('createRushState', () => {
  assert.deepEqual(L.createRushState(), { stRemaining: 100, chainCount: 0 });
});

test('applyRushSpin: はずれでST減少', () => {
  const r = L.applyRushSpin({ stRemaining: 100, chainCount: 0 }, seq([0.5]));
  assert.equal(r.outcome, 'miss');
  assert.equal(r.rushState.stRemaining, 99);
});

test('applyRushSpin: 最後の1回を外すとst_end', () => {
  const r = L.applyRushSpin({ stRemaining: 1, chainCount: 3 }, seq([0.5]));
  assert.equal(r.outcome, 'st_end');
  assert.equal(r.rushState.stRemaining, 0);
});

test('applyRushSpin: 当たりでST100にリセット・連チャン+1', () => {
  const r = L.applyRushSpin({ stRemaining: 5, chainCount: 2 }, seq([0]));
  assert.equal(r.outcome, 'hit');
  assert.deepEqual(r.rushState, { stRemaining: 100, chainCount: 3 });
});

test('rollRushEntry', () => {
  assert.equal(L.rollRushEntry(seq([0.49])), true);
  assert.equal(L.rollRushEntry(seq([0.5])), false);
});

// ---- judgment ----

test('planCharge: 保留全ハズレは1500で終わり、表記は or 1500', () => {
  let s = L.createChargeState();
  // 当該1回転目で当たり、保留4個すべてハズレ
  s = L.applyChargeStep(s, seq([H, M, M, M, M])).state;
  const plan = L.planCharge(s, seq([]));
  assert.equal(plan.kind, 'b1500');
  assert.equal(plan.final.nominal, 1500);
  assert.equal(plan.steps.length, 4);
  assert.equal(L.rollJudgeLabel(plan.kind, seq([])), L.JUDGE_LABEL_1500);
});

test('planCharge: 3000BONUSの表記は必ず or 3000', () => {
  let s = L.createChargeState();
  s = L.applyChargeStep(s, seq([H, H, M, M, M])).state;
  const plan = L.planCharge(s, seq([0.99])); // 保留1で当たり、再チャージ失敗
  assert.equal(plan.kind, 'b3000');
  assert.equal(L.rollJudgeLabel('b3000', seq([])), L.JUDGE_LABEL_3000);
});

test('rollJudgeLabel: サバンナチャンスは34.3%で or 3000', () => {
  assert.equal(L.rollJudgeLabel('savanna', seq([0.3])), L.JUDGE_LABEL_3000);
  assert.equal(L.rollJudgeLabel('savanna', seq([0.5])), L.JUDGE_LABEL_1500);
});

test('表記の割合: or 3000 が約1/3', () => {
  let n3000 = 0; const N = 50000;
  for (let i = 0; i < N; i++) {
    const s = L.applyChargeStep(L.createChargeState()).state;
    const plan = L.planCharge(s);
    if (L.rollJudgeLabel(plan.kind) === L.JUDGE_LABEL_3000) n3000++;
  }
  const r = n3000 / N;
  assert.ok(r > 0.31 && r < 0.36, String(r));
});
