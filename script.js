'use strict';

const game = {
  state: 'normal_idle',
  mode: 'normal',            // 'normal' | 'rush'
  spinRate: DEFAULT_SPIN_RATE,
  mochiDama: 0,
  toushi: 0,
  totalSpins: 0,
  currentSpins: 0,
  lastHitSpins: 0,
  lastHitToushi: 0,
  normalHitCounts: { rushEntry: 0, single: 0 },
  totalRushHits: 0,
  allRushStats: newRushStats(),
  rush: null,                // { stRemaining, chainCount }
  session: null,             // 今回のRUSHの集計
  rushCycleSpins: 0,
  charge: null,              // チャージの状態(logic.js)
  chargeView: null,          // チャージ画面の表示用
  pending: {},
  eigyoAlertShown: false,
  log: [],
};

function newRushStats() {
  return { rushTotalSpins: 0, b1500: 0, b3000: 0, savanna: 0, scSum: 0, scMax: 0 };
}

function newSession() {
  return { nominal: FIRST_HIT_NOMINAL, actual: FIRST_HIT_ACTUAL, b1500: 0, b3000: 0, savanna: 0, scMax: 0 };
}

function addLog(text, type = '') {
  game.log.unshift({ text, type });
  if (game.log.length > 50) game.log.pop();
  renderLog();
}

// ---- 球数・投資 ----

function consumeSpinCost() {
  const cost = calcSpinCost(game.spinRate);
  if (game.mochiDama >= cost) {
    game.mochiDama -= cost;
  } else {
    const shortfall = cost - game.mochiDama;
    game.mochiDama = 0;
    const units = Math.ceil(shortfall / 250);
    game.toushi   += units * 1000;
    game.mochiDama = units * 250 - shortfall;
  }
}

function addBalls(n) {
  game.mochiDama += n;
}

function handleSpinRateChange(value) {
  game.spinRate = Number(value);
  render();
}

// ---- 通常時 ----

function checkEigyoAlert() {
  if (!game.eigyoAlertShown && game.totalSpins >= 2000) {
    game.eigyoAlertShown = true;
    setState('eigyo_alert');
    return true;
  }
  return false;
}

// 1回転処理。先咆哮が出たら true を返す
function runNormalSpin() {
  game.totalSpins++;
  game.currentSpins++;
  consumeSpinCost();
  const result = spinNormal();
  const interval = game.totalSpins - game.lastHitSpins;

  if (result === 'hit' || result === 'false_enzoku') {
    const spentSinceLastHit = game.toushi - game.lastHitToushi;
    game.pending = { type: result, interval, spentSinceLastHit };
    addLog(`${interval}回転で先咆哮発生！`);
    setState('enzoku');
    return true;
  }
  return false;
}

function handleStart() {
  if (checkEigyoAlert()) return;
  if (!runNormalSpin()) setState('lose_result');
}

function autoSpin(count) {
  for (let i = 0; i < count; i++) {
    if (checkEigyoAlert()) return;
    if (runNormalSpin()) return;
  }
  setState('normal_idle');
}

function handleEnzokuJudge() {
  if (game.pending.type === 'hit') {
    const interval = game.pending.interval;
    game.currentSpins = 0;
    game.lastHitSpins = game.totalSpins;
    game.lastHitToushi = game.toushi;
    addBalls(FIRST_HIT_ACTUAL);
    addLog(`${interval}回転で大当たり！ 獣王RUSHチャレンジ ＋${FIRST_HIT_ACTUAL}球`, 'win');
    setState('normal_hit_result');
  } else {
    addLog('はずれ');
    setState('lose_result');
  }
}

function backToNormal() {
  game.mode = 'normal';
  setState('normal_idle');
}

function handleNormalHitContinue() {
  setState('rush_entry_challenge');
}

function handleRushEntryJudge() {
  if (rollRushEntry()) {
    game.normalHitCounts.rushEntry++;
    game.mode = 'rush';
    game.rush = createRushState();
    game.session = newSession();
    game.rushCycleSpins = 0;
    addLog('獣王RUSH突入！', 'rush');
    setState('rush_entry_win');
  } else {
    game.normalHitCounts.single++;
    addLog('獣王RUSHチャレンジ失敗…');
    setState('rush_entry_lose');
  }
}

function handleAfterRushEntry() {
  setState(game.mode === 'rush' ? 'rush_idle' : 'normal_idle');
}

// ---- 獣王RUSH ----

// 1回転処理。画面遷移が起きたら true を返す
function runRushSpin(opts = {}) {
  game.allRushStats.rushTotalSpins++;
  game.rushCycleSpins++;
  const { rushState, outcome } = applyRushSpin(game.rush);
  game.rush = rushState;

  if (outcome === 'miss') {
    if (!opts.silent) {
      setState('rush_miss');
      return true;
    }
    return false;
  }

  if (outcome === 'st_end') {
    addLog('ST100回転終了 → RUSH終了');
    setState('rush_result');
    return true;
  }

  game.totalRushHits++;
  game.charge = createChargeState();
  game.chargeView = { spinsThisCycle: game.rushCycleSpins, message: '', history: [], plan: null, idx: 0, label: null, judged: false };
  game.rushCycleSpins = 0;
  addLog(`${game.chargeView.spinsThisCycle}回転で当選！ チャージ！`, 'rush');
  setState('charge');
  return true;
}

function handleRushSpin() {
  runRushSpin();
}

function handleRushSpin10() {
  for (let i = 0; i < 10; i++) {
    if (runRushSpin({ silent: true })) return;
  }
  setState('rush_idle');
}

// 当たりか、ST残り10回まで一気に回す
function handleRushSkip() {
  for (;;) {
    if (runRushSpin({ silent: true })) return;
    if (game.rush.stRemaining <= 10) {
      setState('rush_idle');
      return;
    }
  }
}

function handleRushMissContinue() {
  setState('rush_idle');
}

// ---- チャージ ----

function describeChargeEvent(event, state) {
  const total = `（累計${state.nominal.toLocaleString()}発）`;
  if (event.type === 'gai') {
    const head = event.initial ? '当該抽選' : '再チャージ当該';
    let text = `${head}：1/4.13を回して<b>${event.spins}回転目</b>で大当たり <span class="plus">＋1500</span>${total}`;
    if (!event.initial) {
      text += event.recharge
        ? ' <span class="ok">再チャージ成功！</span>'
        : ' <span class="ng">再チャージ失敗</span>';
    }
    return text;
  }
  if (!event.hit) return '× ハズレ';
  let text = `◎ 大当たり <span class="plus">＋1500</span>${total}`;
  text += event.rechargeResult
    ? ' <span class="ok">再チャージ成功！保留補充</span>'
    : ' <span class="ng">再チャージ失敗</span>';
  return text;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

// 1手進める。持ち球は当たりのたびにその場で加算する
// 保留チャージ後は、先に抽選済みの手順(plan)を1つずつ再生する
function stepCharge() {
  const before = game.charge;
  const v = game.chargeView;
  let step;
  if (v.plan) {
    if (v.idx >= v.plan.steps.length) return;
    step = v.plan.steps[v.idx++];
  } else {
    step = applyChargeStep(before);
  }
  const { state, event } = step;
  if (!event) return;
  addBalls(state.actual - before.actual);
  game.charge = state;
  const message = describeChargeEvent(event, state);
  v.message = message;
  v.history.unshift(stripTags(message));
}

// 初回の当該抽選。保留チャージの時点で最後まで抽選し、judgment前の表記を決める
function handleChargeStep() {
  const v = game.chargeView;
  stepCharge();
  if (!v.plan) {
    v.plan = planCharge(game.charge);
    v.label = rollJudgeLabel(v.plan.kind);
  }
  setState('charge');
}

function handleJudgment() {
  const v = game.chargeView;
  v.judged = true;
  if (v.plan.kind === 'savanna') {
    addLog('サバンナチャンス突入！', 'sc');
    setState('charge');
    return;
  }
  while (game.charge.phase !== 'done') stepCharge();
  handleChargeFinish();
}

function handleChargeSkip() {
  while (game.charge.phase !== 'done') stepCharge();
  setState('charge');
}

function handleChargeFinish() {
  const { nominal, actual } = game.charge;
  const kind = classifyCharge(nominal);
  const a = game.allRushStats;
  const s = game.session;
  a[kind]++;
  s[kind]++;
  s.nominal += nominal;
  s.actual += actual;
  if (kind === 'savanna') {
    a.scSum += nominal;
    a.scMax = Math.max(a.scMax, nominal);
    s.scMax = Math.max(s.scMax, nominal);
    addLog(`サバンナチャンス ${nominal.toLocaleString()}発 (${game.rush.chainCount}連)`, 'sc');
  } else {
    addLog(`${nominal}ボーナス (${game.rush.chainCount}連)`, 'rush');
  }
  game.pending = { kind, nominal, actual };
  setState('charge_result');
}

function handleChargeResultContinue() {
  game.charge = null;
  game.chargeView = null;
  setState('rush_idle');
}

function handleRushResultEnd() {
  addLog(`RUSH終了 ${game.rush.chainCount + 1}連 ${game.session.nominal.toLocaleString()}発 → 通常時へ`);
  game.mode = 'normal';
  game.rush = null;
  game.session = null;
  game.rushCycleSpins = 0;
  setState('normal_idle');
}

// ---- 営業終了・退店 ----

function resumeState() {
  if (game.mode !== 'rush') return 'normal_idle';
  return game.charge ? 'charge' : 'rush_idle';
}

function handleEigyoHai() {
  setState(resumeState());
}

function handleEigyoIie() {
  setState('taiten_result');
}

function handleTaiten() {
  setState('taiten_result');
}

function resetGame() {
  game.state           = 'normal_idle';
  game.mode            = 'normal';
  game.spinRate        = DEFAULT_SPIN_RATE;
  game.mochiDama       = 0;
  game.toushi          = 0;
  game.totalSpins      = 0;
  game.currentSpins    = 0;
  game.lastHitSpins    = 0;
  game.lastHitToushi   = 0;
  game.normalHitCounts = { rushEntry: 0, single: 0 };
  game.totalRushHits   = 0;
  game.allRushStats    = newRushStats();
  game.rush            = null;
  game.session         = null;
  game.rushCycleSpins  = 0;
  game.charge          = null;
  game.chargeView      = null;
  game.pending         = {};
  game.eigyoAlertShown = false;
  game.log             = [];
  renderLog();
  render();
}

// ---- 状態セット & レンダリング ----

function setState(state) {
  game.state = state;
  render();
}

function render() {
  renderHeader();
  renderModeBadge();
  renderMainScreen();
  renderRushStats();
}

function renderHeader() {
  const mochiInt = Math.floor(game.mochiDama);
  document.getElementById('mochi-dama').textContent   = mochiInt.toLocaleString();
  document.getElementById('toushi-value').textContent = game.toushi.toLocaleString();

  const shuushi   = mochiInt * 4 - game.toushi;
  const shuushiEl = document.getElementById('shuushi-value');
  shuushiEl.textContent = (shuushi >= 0 ? '+' : '') + shuushi.toLocaleString();
  shuushiEl.className   = 'money-value ' + (shuushi >= 0 ? 'green' : 'red');
  document.getElementById('current-spins').textContent    = game.currentSpins.toLocaleString();
  document.getElementById('total-spins-disp').textContent = game.totalSpins.toLocaleString();

  document.getElementById('rush-count').textContent =
    game.mode === 'rush' ? `${game.rush.stRemaining}回` : '－';

  const rushEntries = game.normalHitCounts.rushEntry;
  const singles     = game.normalHitCounts.single;
  const normalHits  = rushEntries + singles;

  document.getElementById('rush-entry-count').textContent = rushEntries + '回';
  document.getElementById('rush-entry-rate').textContent =
    normalHits > 0 ? `(突入率${Math.round((rushEntries / normalHits) * 100)}%)` : '(突入率―%)';
  document.getElementById('single-count').textContent = singles + '回';

  document.getElementById('total-hit-count').textContent = (normalHits + game.totalRushHits) + '回';
  document.getElementById('normal-first-hit').textContent = normalHits + '回';
  document.getElementById('normal-first-prob').textContent = normalHits > 0 && game.totalSpins > 0
    ? '1/' + Math.round(game.totalSpins / normalHits).toLocaleString()
    : '1/―';

  document.getElementById('fee-block').textContent = `${game.spinRate}回転/千円`;
}

function renderModeBadge() {
  const el = document.getElementById('mode-badge');
  if (game.charge && game.chargeView.judged && game.chargeView.plan.kind === 'savanna') {
    el.textContent = 'サバンナチャンス';
    el.className = 'savanna';
  } else if (game.charge) {
    el.textContent = 'チャージ';
    el.className = 'charge';
  } else if (game.mode === 'rush') {
    el.textContent = '獣王RUSH';
    el.className = 'rush';
  } else {
    el.textContent = '通常時';
    el.className = '';
  }
}

function renderMainScreen() {
  document.getElementById('main-screen').innerHTML = buildScreen(game.state);
}

function spinRateOptionsHtml() {
  return SPIN_RATE_OPTIONS.map(rate =>
    `<option value="${rate}" ${rate === game.spinRate ? 'selected' : ''}>${rate}回転</option>`
  ).join('');
}

function tenThousandYenSpins() {
  return Math.round(game.spinRate * 10);
}

function buildNormalIdleScreen() {
  return `<div class="screen">
    <button class="btn-start" onclick="handleStart()">START</button>
    <p class="prob-hint">大当たり確率 1/319.7</p>
    <div class="spin-rate-block">
      <span class="spin-rate-label">1000円あたりの回転数</span>
      <select class="spin-rate-select" onchange="handleSpinRateChange(this.value)">
        ${spinRateOptionsHtml()}
      </select>
    </div>
    <div class="auto-spin-btns">
      <div class="auto-spin-wrap">
        <button class="btn-auto" onclick="autoSpin(${tenThousandYenSpins()})">1万円分回す</button>
        <p class="spin-cost-hint">約${tenThousandYenSpins()}回転分</p>
      </div>
    </div>
    <button class="btn-taiten" onclick="handleTaiten()">退店する</button>
  </div>`;
}

function buildHoldsHtml(holds) {
  const slots = [];
  for (let i = 0; i < HOLD_MAX; i++) {
    if (i < holds.length) {
      // 当落は隠して全部○で表示する（消化したときに分かる）
      slots.push(`<div class="hold c${i}">○</div>`);
    } else {
      slots.push(`<div class="hold empty">・</div>`);
    }
  }
  return `<div class="holds">${slots.join('')}</div>`;
}

function buildChargeScreen() {
  const c = game.charge;
  const v = game.chargeView;
  const isSavanna = v.judged && v.plan.kind === 'savanna';
  const banner = isSavanna ? `<div class="savanna-banner">サバンナチャンス</div>` : '';

  // 保留チャージ直後：表記と judgment ボタン
  if (v.plan && !v.judged) {
    return `<div class="screen">
    <p class="charge-title">チャージ！</p>
    <p class="charge-total">累計 <span>${c.nominal.toLocaleString()}</span> 発</p>
    ${buildHoldsHtml(c.holds)}
    <p class="hold-caption">保留チャージ完了</p>
    <div class="charge-event">${v.message}</div>
    <p class="judge-label">${v.label}</p>
    <div class="charge-btns"><button class="btn-action btn-judge" onclick="handleJudgment()">judgment</button></div>
  </div>`;
  }

  let mainBtn;
  if (c.phase === 'gai_initial') mainBtn = `<button class="btn-action" onclick="handleChargeStep()">▶ 当該抽選</button>`;
  else if (c.phase === 'holds') mainBtn = `<button class="btn-action" onclick="handleChargeStep()">▶ 保留消化</button>`;
  else if (c.phase === 'gai_recharge') mainBtn = `<button class="btn-action" onclick="handleChargeStep()">▶ 再チャージ当該抽選</button>`;
  else mainBtn = `<button class="btn-action" onclick="handleChargeFinish()">▶ 結果へ</button>`;
  const skipBtn = c.phase === 'done'
    ? ''
    : `<button class="btn-sub" onclick="handleChargeSkip()">最後まで</button>`;

  let message = v.message;
  if (!message) message = `${v.spinsThisCycle}回転で当選！ チャージ！`;
  else if (c.phase === 'gai_recharge') message += '<br>保留切れ → 再チャージの当該へ';
  else if (c.phase === 'done') message += '<br>保留切れ → 終了';

  return `<div class="screen">
    ${banner}
    <p class="charge-title">チャージ！</p>
    <p class="charge-total">累計 <span>${c.nominal.toLocaleString()}</span> 発</p>
    <div class="charge-meta">
      <span>大当たり ${c.hits}回</span>
      <span class="right-badge ${c.recharge ? 'on' : ''}">再チャージ権利 ${c.recharge ? 'あり' : 'なし'}</span>
    </div>
    ${buildHoldsHtml(c.holds)}
    <p class="hold-caption">保留（左から消化）</p>
    <div class="charge-event">${message}</div>
    <div class="charge-btns">${mainBtn}${skipBtn}</div>
    <div class="charge-history">${v.history.map(h => `<div>${h}</div>`).join('')}</div>
  </div>`;
}

function resultRow(label, value, cls = '') {
  return `<div class="result-row"><span class="rr-label">${label}</span><span class="rr-val ${cls}">${value}</span></div>`;
}

function buildScreen(state) {
  switch (state) {

    case 'normal_idle':
      return buildNormalIdleScreen();

    case 'enzoku':
      return `<div class="screen">
        <p class="enzoku-label">${game.pending.interval}回転　先咆哮発生！</p>
        <p class="result-sub">前回大当たりから ${game.pending.spentSinceLastHit.toLocaleString()}円使用</p>
        <p class="shinraido">信頼度 ${ENZOKU_CONFIDENCE}%</p>
        <button class="btn-action" onclick="handleEnzokuJudge()">▶ 判定</button>
      </div>`;

    case 'lose_result':
      return `<div class="screen">
        <p class="result-main lose">はずれ</p>
        <button class="btn-sub" onclick="backToNormal()" style="margin-top:8px;">続ける</button>
      </div>`;

    case 'normal_hit_result':
      return `<div class="screen">
        <div class="vibun-box">
          <p class="bonus-main standard">大当たり！</p>
          <p class="bonus-sub">獣王RUSHチャレンジ（2R・${FIRST_HIT_NOMINAL}発）</p>
          <p class="bonus-sub">＋${FIRST_HIT_ACTUAL}球獲得</p>
        </div>
        <button class="btn-action" onclick="handleNormalHitContinue()">▶ チャレンジへ</button>
      </div>`;

    case 'rush_entry_challenge':
      return `<div class="screen">
        <p class="add-rush-title">獣王RUSHチャレンジ！</p>
        <p class="result-sub">成功率 ${Math.round(P_RUSH_ENTRY * 100)}%</p>
        <button class="btn-action" onclick="handleRushEntryJudge()">▶ チャレンジ</button>
      </div>`;

    case 'rush_entry_win':
      return `<div class="screen">
        <p class="add-rush-title">チャレンジ成功！</p>
        <div class="vibun-box rush-box">
          <p class="bonus-main premium">獣王RUSH突入</p>
          <p class="bonus-sub">ST${RUSH_ST_COUNT}回転・継続率約50%</p>
        </div>
        <button class="btn-action" onclick="handleAfterRushEntry()">▶ 獣王RUSHへ</button>
      </div>`;

    case 'rush_entry_lose':
      return `<div class="screen">
        <p class="result-main lose" style="font-size:26px;">チャレンジ失敗…</p>
        <button class="btn-sub" onclick="handleAfterRushEntry()" style="margin-top:12px;">続ける</button>
      </div>`;

    case 'rush_idle': {
      const skipDisabled = game.rush.stRemaining <= 10;
      return `<div class="screen">
        <p class="chain-label">${game.rush.chainCount + 1}連チャン中</p>
        <p class="rush-title">獣王RUSH</p>
        <p class="rush-sub">ST残り <span>${game.rush.stRemaining}</span> 回</p>
        <div class="rush-spin-btns">
          <button class="btn-rush-spin" onclick="handleRushSpin()">1回転</button>
          <button class="btn-rush-spin" onclick="handleRushSpin10()">10回転</button>
          <button class="btn-rush-spin skip" ${skipDisabled ? 'disabled' : 'onclick="handleRushSkip()"'}>スキップ</button>
        </div>
        <p class="prob-hint">大当たり確率 1/144.7</p>
        <button class="btn-taiten" onclick="handleTaiten()">退店する</button>
      </div>`;
    }

    case 'rush_miss':
      return `<div class="screen">
        <p class="result-main lose">外れ</p>
        <p style="color:#c8102e; font-size:18px; margin-top:4px;">ST残り ${game.rush.stRemaining}回</p>
        <button class="btn-sub" onclick="handleRushMissContinue()" style="margin-top:12px;">続ける</button>
      </div>`;

    case 'charge':
      return buildChargeScreen();

    case 'charge_result': {
      const { kind, nominal, actual } = game.pending;
      const title = kind === 'savanna' ? 'サバンナチャンス' : `${nominal}ボーナス`;
      const cls = kind === 'savanna' ? 'savanna' : kind === 'b3000' ? 'premium' : 'standard';
      return `<div class="screen">
        <p class="chain-label">${game.rush.chainCount + 1}連チャン</p>
        <div class="vibun-box rush-box">
          <p class="bonus-main ${cls}">${title}</p>
          <p class="bonus-sub" style="font-size:20px; font-weight:bold; color:#c9a227;">${nominal.toLocaleString()}発</p>
          <p class="bonus-sub">＋${actual.toLocaleString()}球獲得</p>
        </div>
        <button class="btn-action" onclick="handleChargeResultContinue()">▶ 獣王RUSHへ</button>
      </div>`;
    }

    case 'rush_result': {
      const s = game.session;
      const lines = [resultRow('初当たり（チャレンジ）', `${FIRST_HIT_NOMINAL}発`)];
      if (s.b1500)   lines.push(resultRow('1500ボーナス', `×${s.b1500}回`));
      if (s.b3000)   lines.push(resultRow('3000ボーナス', `×${s.b3000}回`));
      if (s.savanna) lines.push(resultRow('サバンナチャンス', `×${s.savanna}回（最高${s.scMax.toLocaleString()}発）`));
      return `<div class="screen">
        <p class="rush-result-title">獣王RUSH リザルト</p>
        <div class="rush-result-box">
          <div class="result-row highlight">
            <span class="rr-label">連チャン数</span>
            <span class="rr-val gold">${game.rush.chainCount + 1}連チャン</span>
          </div>
          ${resultRow('獲得出玉', `${s.actual.toLocaleString()}球`, 'gold')}
          ${resultRow('表示出玉', `${s.nominal.toLocaleString()}発`)}
          <hr class="result-hr">
          <p class="rr-section">ボーナス内訳</p>
          ${lines.join('')}
        </div>
        <button class="btn-action" onclick="handleRushResultEnd()" style="margin-top:16px;">▶ 通常へ戻る</button>
      </div>`;
    }

    case 'eigyo_alert':
      return `<div class="screen">
        <p style="font-size:22px; font-weight:bold; color:#c8102e; text-align:center; line-height:1.6;">
          営業時間終了になりました
        </p>
        <p style="font-size:16px; color:#666; text-align:center;">このまま居座り続けますか？</p>
        <div style="display:flex; gap:16px; margin-top:8px; width:100%; max-width:300px;">
          <button class="btn-action" style="flex:1;" onclick="handleEigyoHai()">はい</button>
          <button class="btn-action" style="flex:1; background:linear-gradient(135deg,#999,#666); border-color:#ccc;"
            onclick="handleEigyoIie()">いいえ</button>
        </div>
      </div>`;

    case 'taiten_result': {
      const mochi    = Math.floor(game.mochiDama);
      const mochiYen = mochi * 4;
      const shuushi  = mochiYen - game.toushi;
      const shuushiColor = shuushi >= 0 ? '#2e9e5b' : '#d24141';
      const shuushiSign  = shuushi >= 0 ? '＋' : '';
      const a = game.allRushStats;
      return `<div class="screen">
        <p style="font-size:24px; font-weight:bold; color:#666;">退店します</p>
        <div class="rush-result-box" style="max-width:320px;">
          <p class="rr-section" style="margin-bottom:8px;">収支発表</p>
          ${resultRow('総回転数', `${game.totalSpins.toLocaleString()}回`)}
          <div class="result-row">
            <span class="rr-label">投資金額</span>
            <span class="rr-val" style="color:#d24141;">${game.toushi.toLocaleString()}円</span>
          </div>
          ${resultRow('持ち球換算', `${mochiYen.toLocaleString()}円`)}
          <hr class="result-hr">
          <div class="result-row highlight">
            <span class="rr-label" style="font-weight:bold;">収支</span>
            <span class="rr-val" style="color:${shuushiColor}; font-size:22px;">
              ${shuushiSign}${shuushi.toLocaleString()}円
            </span>
          </div>
          <hr class="result-hr">
          ${resultRow('RUSH突入', `${game.normalHitCounts.rushEntry}回`)}
          ${resultRow('チャレンジ失敗', `${game.normalHitCounts.single}回`)}
          ${resultRow('RUSH大当たり', `${game.totalRushHits}回`)}
          ${resultRow('サバンナチャンス', `${a.savanna}回`)}
        </div>
        <button class="btn-action" onclick="resetGame()" style="margin-top:8px;">▶ 最初の画面に戻る</button>
      </div>`;
    }

    default:
      return `<div class="screen"><p>...</p></div>`;
  }
}

function renderRushStats() {
  const a     = game.allRushStats;
  const hits  = game.totalRushHits;
  const spins = a.rushTotalSpins;
  document.getElementById('rs-chain').textContent = hits + '回';
  document.getElementById('rs-prob').textContent  = hits > 0 && spins > 0 ? '1/' + (spins / hits).toFixed(1) : '1/―';
  document.getElementById('rs-spins').textContent = spins + '回';
  document.getElementById('rs-b1500').textContent   = a.b1500 + '回';
  document.getElementById('rs-b3000').textContent   = a.b3000 + '回';
  document.getElementById('rs-savanna').textContent = a.savanna + '回';
  document.getElementById('rs-sc-avg').textContent  = a.savanna > 0
    ? Math.round(a.scSum / a.savanna).toLocaleString() + '発' : '―';
  document.getElementById('rs-sc-max').textContent  = a.savanna > 0
    ? a.scMax.toLocaleString() + '発' : '―';
}

function renderLog() {
  const el = document.getElementById('log-list');
  el.innerHTML = game.log.map(item =>
    `<div class="log-item ${item.type}">${item.text}</div>`
  ).join('');
}

render();
