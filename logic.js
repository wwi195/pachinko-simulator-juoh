'use strict';

// e 獣王 獅子の一撃 — 確率・状態遷移ロジック（DOM非依存）
// 抽選関数はすべて rng（既定は Math.random）を受け取れるようにしてテストで差し替える。

const SPIN_RATE_OPTIONS = [22, 25, 26.3, 28, 31];
const DEFAULT_SPIN_RATE = 26.3;

function calcSpinCost(spinRate) {
  return 250 / spinRate;
}

// ---- 通常時 ----

const P_HIT = 1 / 319.7;
const ENZOKU_CONFIDENCE = 60; // 先咆哮の信頼度(%)

function falseEnzokuProbability() {
  return P_HIT * ((100 - ENZOKU_CONFIDENCE) / ENZOKU_CONFIDENCE);
}

// 当たり(P_HIT)と、外れなのに先咆哮が出る偽陽性の合算が先咆哮の発生率。
// その中で本物が占める割合が信頼度(60%)になる。
function spinNormal(rng = Math.random) {
  if (rng() < P_HIT) return 'hit';
  if (rng() < falseEnzokuProbability()) return 'false_enzoku';
  return 'miss';
}

// 初当たりは全部 2R(300発)の獣王RUSHチャレンジ。50%でRUSH突入。
const FIRST_HIT_NOMINAL = 300;
const FIRST_HIT_ACTUAL = 280;
const P_RUSH_ENTRY = 0.5;

function rollRushEntry(rng = Math.random) {
  return rng() < P_RUSH_ENTRY;
}

// ---- 獣王RUSH（ST100） ----

const P_RUSH = 1 / 144.7;
const RUSH_ST_COUNT = 100;

function createRushState() {
  return { stRemaining: RUSH_ST_COUNT, chainCount: 0 };
}

// ST消化と当選判定のみ。当たりの出玉はチャージ側で決まる。
function applyRushSpin(rushState, rng = Math.random) {
  if (rng() < P_RUSH) {
    return {
      rushState: { stRemaining: RUSH_ST_COUNT, chainCount: rushState.chainCount + 1 },
      outcome: 'hit',
    };
  }
  const stRemaining = rushState.stRemaining - 1;
  if (stRemaining <= 0) {
    return { rushState: { ...rushState, stRemaining: 0 }, outcome: 'st_end' };
  }
  return { rushState: { ...rushState, stRemaining }, outcome: 'miss' };
}

// ---- チャージ（RUSH中の当たり1回の中身） ----
// 当該抽選(1/4.13を当たるまで) → 保留4個(各1/4.13)を前から消化。
// 保留の当たりごとに、持っている権利を消費したうえで62%の再チャージ判定。
// 成功すると残りの保留を保持したまま4個まで補充し、権利を得る。
// 保留切れ時に権利があれば再チャージ当該へ（この当たりでも再チャージ判定）、なければ終了。

const P_CHARGE = 1 / 4.13;
const P_RECHARGE = 0.62;
const HOLD_MAX = 4;
const CHARGE_HIT_NOMINAL = 1500;
const CHARGE_HIT_ACTUAL = 1400;
const SAVANNA_THRESHOLD = 4500;

function rollUntilHit(rng = Math.random) {
  let spins = 1;
  while (!(rng() < P_CHARGE)) spins++;
  return spins;
}

function fillHolds(holds, rng = Math.random) {
  const next = holds.slice();
  while (next.length < HOLD_MAX) next.push(rng() < P_CHARGE);
  return next;
}

function classifyCharge(nominal) {
  if (nominal >= SAVANNA_THRESHOLD) return 'savanna';
  if (nominal >= 3000) return 'b3000';
  return 'b1500';
}

function createChargeState() {
  return { phase: 'gai_initial', holds: [], recharge: false, hits: 0, nominal: 0, actual: 0 };
}

function addHit(state) {
  return {
    ...state,
    hits: state.hits + 1,
    nominal: state.nominal + CHARGE_HIT_NOMINAL,
    actual: state.actual + CHARGE_HIT_ACTUAL,
  };
}

function applyChargeStep(state, rng = Math.random) {
  switch (state.phase) {
    case 'gai_initial': {
      const spins = rollUntilHit(rng);
      const holds = fillHolds([], rng);
      return {
        state: { ...addHit(state), phase: 'holds', holds },
        event: { type: 'gai', initial: true, spins, recharge: null },
      };
    }

    case 'holds': {
      const [hit, ...rest] = state.holds;
      let next = { ...state, holds: rest };
      let rechargeResult = null;
      let refilled = false;
      if (hit) {
        next = addHit(next);
        rechargeResult = rng() < P_RECHARGE;
        next.recharge = rechargeResult;
        if (rechargeResult) {
          next.holds = fillHolds(rest, rng);
          refilled = true;
        }
      }
      if (next.holds.length === 0) {
        next.phase = next.recharge ? 'gai_recharge' : 'done';
      }
      return { state: next, event: { type: 'hold', hit, rechargeResult, refilled } };
    }

    case 'gai_recharge': {
      const spins = rollUntilHit(rng);
      const recharge = rng() < P_RECHARGE;
      const holds = fillHolds([], rng);
      return {
        state: { ...addHit(state), phase: 'holds', holds, recharge },
        event: { type: 'gai', initial: false, spins, recharge },
      };
    }

    default:
      return { state, event: null };
  }
}

// ---- judgment（保留チャージ直後の告知） ----
// 保留チャージの時点でチャージの最後まで抽選を済ませ、結果に応じて judgment 前の表記を決める。
// 3000BONUSは必ず「or 3000」。サバンナチャンスは34.3%で「or 3000」（全体で約1/3が「or 3000」）。
// それ以外は「or 1500」。

const P_SC_LABEL_3000 = 0.343;
const JUDGE_LABEL_1500 = 'サバンナチャンス or 1500ボーナス';
const JUDGE_LABEL_3000 = 'サバンナチャンス or 3000ボーナス';

// 初回当該の直後(phase:'holds')の状態から 'done' までの手順をすべて先に抽選して返す
function planCharge(state, rng = Math.random) {
  const steps = [];
  let cur = state;
  while (cur.phase !== 'done') {
    const step = applyChargeStep(cur, rng);
    steps.push(step);
    cur = step.state;
  }
  return { steps, final: cur, kind: classifyCharge(cur.nominal) };
}

function rollJudgeLabel(kind, rng = Math.random) {
  if (kind === 'b3000') return JUDGE_LABEL_3000;
  if (kind === 'savanna' && rng() < P_SC_LABEL_3000) return JUDGE_LABEL_3000;
  return JUDGE_LABEL_1500;
}

// ---- 出現率の計算 ----

// 通常時：n回転目で当たった時の出現率
// atLeast: n回転以上かかる確率 = (1-p)^(n-1) ／ within: n回転以内に当たる確率 = 1-(1-p)^n
function hitIntervalProbability(n) {
  return {
    atLeast: Math.pow(1 - P_HIT, n - 1),
    within: 1 - Math.pow(1 - P_HIT, n),
  };
}

// ST100回転中に1回以上当たる確率（約50%）
const P_ST_HIT = 1 - Math.pow(1 - P_RUSH, RUSH_ST_COUNT);

// 単発：RUSHチャレンジ失敗 or RUSH突入後1連(ST中の当たりなし)で終了
const P_TANPATSU = (1 - P_RUSH_ENTRY) + P_RUSH_ENTRY * (1 - P_ST_HIT);
function tanpatsuStreakProbability(n) {
  return Math.pow(P_TANPATSU, n);
}

// チャージ1回の当たり数(hits)の確率分布を、状態(残り保留数・権利)の遷移から厳密に計算する。
// 保留の当否は1個ずつ独立なので、消化時に抽選しても分布は同じ。
const DIST_MAX_HITS = 600;
function computeChargeHitsDist() {
  const dist = new Float64Array(DIST_MAX_HITS + 1);
  let active = new Map([[`1,4,0`, 1]]);
  let guard = 0;
  while (active.size && guard++ < 100000) {
    const next = new Map();
    const add = (h, k, r, m) => {
      if (m < 1e-18) return;
      if (h > DIST_MAX_HITS) return;
      const key = `${h},${k},${r}`;
      next.set(key, (next.get(key) || 0) + m);
    };
    for (const [key, m] of active) {
      const [h, k, r] = key.split(',').map(Number);
      if (k === 0) {
        if (r) { add(h + 1, 4, 1, m * P_RECHARGE); add(h + 1, 4, 0, m * (1 - P_RECHARGE)); }
        else dist[h] += m;
        continue;
      }
      add(h + 1, 4, 1, m * P_CHARGE * P_RECHARGE);
      add(h + 1, k - 1, 0, m * P_CHARGE * (1 - P_RECHARGE));
      add(h, k - 1, r, m * (1 - P_CHARGE));
    }
    active = next;
  }
  return dist;
}

// RUSH1回(突入〜ST終了)の合計当たり数の分布。ST中の当たり回数Kは q^K(1-q)、各当たりがチャージ1回。
function computeRushHitsDist(chargeDist) {
  const N = DIST_MAX_HITS;
  const total = new Float64Array(N + 1);
  let conv = new Float64Array(N + 1);
  conv[0] = 1;
  let weight = 1 - P_ST_HIT;
  for (let k = 0; k < 200 && weight > 1e-18; k++) {
    for (let i = 0; i <= N; i++) total[i] += weight * conv[i];
    const nextConv = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) {
      if (conv[i] === 0) continue;
      for (let j = 1; i + j <= N; j++) nextConv[i + j] += conv[i] * chargeDist[j];
    }
    conv = nextConv;
    weight *= P_ST_HIT;
  }
  return total;
}

function tailFrom(dist) {
  const tail = new Float64Array(dist.length + 1);
  for (let i = dist.length - 1; i >= 0; i--) tail[i] = tail[i + 1] + dist[i];
  return tail;
}

let _chargeTail = null;
let _rushTail = null;
function ensureTails() {
  if (_chargeTail) return;
  const chargeDist = computeChargeHitsDist();
  _chargeTail = tailFrom(chargeDist);
  _rushTail = tailFrom(computeRushHitsDist(chargeDist));
}

// チャージ1回(RUSH中の当たり1回)で、表示出玉がnominal発以上になる確率
function chargeAtLeastProbability(nominal) {
  ensureTails();
  const hits = Math.ceil(nominal / CHARGE_HIT_NOMINAL);
  return hits >= _chargeTail.length ? 0 : _chargeTail[Math.max(0, hits)];
}

// RUSH1回(突入1回あたり)のST合計表示出玉(初当たり300発込み)がnominal発以上になる確率
function rushTotalAtLeastProbability(nominal) {
  ensureTails();
  const hits = Math.ceil((nominal - FIRST_HIT_NOMINAL) / CHARGE_HIT_NOMINAL);
  return hits >= _rushTail.length ? 0 : _rushTail[Math.max(0, hits)];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SPIN_RATE_OPTIONS, DEFAULT_SPIN_RATE, calcSpinCost,
    P_HIT, ENZOKU_CONFIDENCE, falseEnzokuProbability, spinNormal,
    FIRST_HIT_NOMINAL, FIRST_HIT_ACTUAL, P_RUSH_ENTRY, rollRushEntry,
    P_RUSH, RUSH_ST_COUNT, createRushState, applyRushSpin,
    P_CHARGE, P_RECHARGE, HOLD_MAX, CHARGE_HIT_NOMINAL, CHARGE_HIT_ACTUAL, SAVANNA_THRESHOLD,
    rollUntilHit, fillHolds, classifyCharge, createChargeState, applyChargeStep,
    P_SC_LABEL_3000, JUDGE_LABEL_1500, JUDGE_LABEL_3000, planCharge, rollJudgeLabel,
    hitIntervalProbability, P_ST_HIT, P_TANPATSU, tanpatsuStreakProbability,
    computeChargeHitsDist, computeRushHitsDist, chargeAtLeastProbability, rushTotalAtLeastProbability,
  };
}
