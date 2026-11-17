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
const ENZOKU_CONFIDENCE = 40; // 先咆哮の信頼度(%)

function falseEnzokuProbability() {
  return P_HIT * ((100 - ENZOKU_CONFIDENCE) / ENZOKU_CONFIDENCE);
}

// 当たり(P_HIT)と、外れなのに先咆哮が出る偽陽性の合算が先咆哮の発生率。
// その中で本物が占める割合が信頼度(40%)になる。
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SPIN_RATE_OPTIONS, DEFAULT_SPIN_RATE, calcSpinCost,
    P_HIT, ENZOKU_CONFIDENCE, falseEnzokuProbability, spinNormal,
    FIRST_HIT_NOMINAL, FIRST_HIT_ACTUAL, P_RUSH_ENTRY, rollRushEntry,
    P_RUSH, RUSH_ST_COUNT, createRushState, applyRushSpin,
    P_CHARGE, P_RECHARGE, HOLD_MAX, CHARGE_HIT_NOMINAL, CHARGE_HIT_ACTUAL, SAVANNA_THRESHOLD,
    rollUntilHit, fillHolds, classifyCharge, createChargeState, applyChargeStep,
    P_SC_LABEL_3000, JUDGE_LABEL_1500, JUDGE_LABEL_3000, planCharge, rollJudgeLabel,
  };
}
