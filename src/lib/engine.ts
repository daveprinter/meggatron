import { deriv } from "./deriv";
import { feed } from "./feed";
import { startKeepAlive, stopKeepAlive } from "./keepalive";
import { coverage, estProfitRatio, martingaleStake, MIN_STAKE, round2 } from "./martingale";
import { learnFromTrade, payoutRatio } from "./payouts";
import { analyse, type Signal } from "./signals";
import { learn, learnedAvoid, learnedScore, note } from "./learning";
import {
  addError,
  addLog,
  CONTRACTS,
  type ContractKey,
  DERIV_TYPE,
  getState,
  HAS_PREDICTION,
  marketName,
  setState,
  subscribeStore,
  type Trade,
} from "./store";

const HOUR = 3600_000;
const periodMs = (st: { periodMinutes?: number }) => Math.max(1, st.periodMinutes || 60) * 60_000;
const st0 = () => getState().settings;
const LOSS_COOLDOWN_AFTER = 3; // consecutive losses
const LOSS_COOLDOWN_MS = 3 * 60_000;
const ERROR_COOLDOWN_AFTER = 3; // consecutive errors
const ERROR_COOLDOWN_MS = 2 * 60_000;

// ---------- live market data ----------
const priceBuf: Record<string, { prices: number[]; digits: number[] }> = {};
const lastPrice: Record<string, number> = {};
type TickInfo = { price: number; digit: number };
let tickWaiters: { symbol: string; resolve: (t: TickInfo) => void }[] = [];
let feedWired = false;
let accountWired = false;

function waitNextTick(symbol: string) {
  return new Promise<TickInfo>((resolve, reject) => {
    const w = { symbol, resolve: (t: TickInfo) => { clearTimeout(to); resolve(t); } };
    const to = setTimeout(() => {
      tickWaiters = tickWaiters.filter((x) => x !== w);
      reject(new Error("No tick received (connection interrupted)"));
    }, 30_000);
    tickWaiters.push(w);
  });
}

function wireFeed() {
  if (feedWired) return;
  feedWired = true;
  feed.onHistory = (sym, prices, pip) => {
    const digits = prices.map((p) => Number(p.toFixed(pip).slice(-1)));
    priceBuf[sym] = { prices: prices.slice(-200), digits: digits.slice(-200) };
    const p = prices[prices.length - 1];
    if (p !== undefined) {
      lastPrice[sym] = p;
      setState((s) => ({ ticks: { ...s.ticks, [sym]: { symbol: sym, price: p, pip, digit: digits[digits.length - 1]! } } }));
    }
  };
  feed.onTick = ({ symbol: sym, price, digit, pip }) => {
    const b = (priceBuf[sym] ??= { prices: [], digits: [] });
    b.prices.push(price);
    b.digits.push(digit);
    if (b.prices.length > 200) {
      b.prices.shift();
      b.digits.shift();
    }
    const prev = lastPrice[sym];
    lastPrice[sym] = price;
    setState((s) => ({ ticks: { ...s.ticks, [sym]: { symbol: sym, price, pip, digit, prev } } }));
    const ready = tickWaiters.filter((w) => w.symbol === sym);
    tickWaiters = tickWaiters.filter((w) => w.symbol !== sym);
    ready.forEach((w) => w.resolve({ price, digit }));
    // analysis runs on every incoming tick while launched
    if (loop) queueMicrotask(() => void tickLoop());
  };
  feed.onError = (msg) => addError(msg);
  // re-sync the live feed whenever the selected market(s) change
  let lastKey = "";
  subscribeStore(() => {
    const st = getState();
    const key = [st.settings.market, st.engine.market, st.settings.multiMarket, st.settings.markets.join(",")].join("|");
    if (key !== lastKey) {
      lastKey = key;
      syncFeed();
    }
  });
}

/** Start streaming live prices as soon as the app opens (no token needed). */
export function startFeed() {
  syncFeed();
}

/** Keep the live feed subscribed to every market the UI or the AI needs. */
export function syncFeed() {
  if (typeof window === "undefined") return;
  wireFeed();
  const st = getState().settings;
  const syms = new Set<string>([st.market, getState().engine.market]);
  if (st.multiMarket) st.markets.forEach((m) => syms.add(m));
  feed.setSymbols([...syms]);
}

/** Kept for existing callers: switching market just re-syncs the live feed. */
export async function watchMarket(_symbol?: string) {
  setTimeout(syncFeed, 0);
}

function wireAccount() {
  if (accountWired) return;
  accountWired = true;
  deriv.onMessage((m) => {
    if (m.msg_type === "balance" && m.balance) {
      setState(() => ({ balance: m.balance.balance, currency: m.balance.currency }));
    }
    if (m.msg_type === "__closed") {
      setState(() => ({ conn: { status: "connecting", loginid: getState().conn.loginid } }));
      addLog("Deriv connection dropped — reconnecting…");
      scheduleReconnect();
    }
    if (m.error && m.msg_type !== "ping") addError(`Deriv API: ${m.error.message}`);
  });
}

let manualDisconnect = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let connecting = false;
let watchersWired = false;

function scheduleReconnect() {
  if (manualDisconnect || !getState().settings.token || reconnectTimer) return;
  const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!deriv.open) void connectAccount();
  }, delay);
}

function wireConnectionWatchers() {
  if (watchersWired || typeof window === "undefined") return;
  watchersWired = true;
  const kick = () => {
    if (manualDisconnect || !getState().settings.token || deriv.open || connecting) return;
    reconnectAttempt = 0;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    void connectAccount();
  };
  window.addEventListener("online", kick);
  window.addEventListener("focus", kick);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && kick());
  // periodic health check (also runs while minimised, throttled by the browser)
  setInterval(kick, 15000);
}

export async function connectAccount() {
  manualDisconnect = false;
  wireAccount();
  wireConnectionWatchers();
  if (connecting) return;
  if (deriv.open && getState().conn.status === "connected") return;
  syncFeed();
  const token = getState().settings.token;
  if (!token) return;
  setState(() => ({ conn: { status: "connecting" } }));
  connecting = true;
  try {
    deriv.disconnect();
    const a = await deriv.connect(token);
    reconnectAttempt = 0;
    setState(() => ({
      conn: { status: "connected", loginid: a.loginid },
      balance: a.balance,
      currency: a.currency,
    }));
    addLog(`Connected to ${a.loginid} (${a.mode.toUpperCase()})`);
    syncFeed();
    // internet/account back: continue the previous session automatically
    resumeIfLaunched();
  } catch (e: any) {
    setState(() => ({ conn: { status: "error", error: `${e.message} — retrying…` } }));
    addError(`Connect failed: ${e.message}`);
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

export function disconnectAccount() {
  manualDisconnect = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopEngine();
  deriv.disconnect();
  setState(() => ({ conn: { status: "idle" }, balance: null }));
}

// ---------- engine state ----------
let loop: ReturnType<typeof setInterval> | null = null;
let busy = false;
let curHour = -1;
let hourStart = 0;
let nextAllowed = 0;
let hourProfit = 0;
let targetLogged = false;
let hourTypeTrades: Partial<Record<ContractKey, number>> = {};
let hourTypeLosses: Partial<Record<ContractKey, number>> = {};
let bannedTypes = new Set<ContractKey>();
let mgStep = 0;
let lossAccum = 0;
let lastStake = 0;
let lastType: ContractKey | null = null;
let marketStartedAt = Date.now();
let marketTrades = 0;
let consecLosses = 0;
let consecErrors = 0;
let cooldownUntil = 0;
let lastScanLog = 0;

const eng = (patch: Partial<ReturnType<typeof getState>["engine"]>) =>
  setState((s) => ({ engine: { ...s.engine, ...patch } }));

function saveRuntime() {
  setState(() => ({
    runtime: {
      hourStart, curHour, hourProfit, targetLogged, hourTypeTrades, hourTypeLosses,
      bannedTypes: [...bannedTypes], mgStep, lossAccum, lastStake, lastType,
      marketStartedAt, marketTrades, consecLosses, cooldownUntil, savedAt: Date.now(),
    },
  }));
}

function restoreRuntime() {
  const r = getState().runtime;
  if (!r || !r["hourStart"]) return false;
  hourStart = r["hourStart"]; curHour = r["curHour"] ?? -1; hourProfit = r["hourProfit"] ?? 0;
  targetLogged = !!r["targetLogged"]; hourTypeTrades = r["hourTypeTrades"] ?? {}; hourTypeLosses = r["hourTypeLosses"] ?? {};
  bannedTypes = new Set(r["bannedTypes"] ?? []); mgStep = r["mgStep"] ?? 0; lossAccum = r["lossAccum"] ?? 0;
  lastStake = r["lastStake"] ?? 0; lastType = r["lastType"] ?? null; marketStartedAt = r["marketStartedAt"] ?? Date.now();
  marketTrades = r["marketTrades"] ?? 0; consecLosses = r["consecLosses"] ?? 0; cooldownUntil = r["cooldownUntil"] ?? 0;
  eng({ hourProfit, cooldownUntil: cooldownUntil || null });
  return true;
}

export function launchEngine(resume = false) {
  const s = getState();
  if (resume && s.session.launched && restoreRuntime()) {
    if (loop) clearInterval(loop);
    loop = setInterval(tickLoop, 1000);
    busy = false;
    nextAllowed = 0;
    consecErrors = 0;
    syncFeed();
    addLog(`Session resumed where it left off — hour P/L ${hourProfit.toFixed(2)}${mgStep ? `, recovery step ${mgStep} (loss ${lossAccum.toFixed(2)})` : ""}${cooldownUntil > Date.now() ? ", cooldown still running" : ""}`);
    startKeepAlive(() => {
      syncFeed();
      if (getState().conn.status !== "connected" && getState().settings.token) void connectAccount();
    });
    return;
  }
  if (s.conn.status !== "connected") return addLog("Connect your Deriv account first", "warn");
  if (!CONTRACTS.some((k) => s.settings.contracts[k].enabled))
    return addLog("Select at least one contract type", "warn");
  const markets = activeMarkets();
  marketStartedAt = Date.now();
  marketTrades = 0;
  consecErrors = 0;
  cooldownUntil = 0;
  nextAllowed = 0;
  eng({ market: markets[0]!, status: "Scanning markets", cooldownUntil: null });
  const launchedAt = Date.now();
  setState((st) => ({ session: { startedAt: st.session.startedAt ?? launchedAt, launched: true, hourStart: launchedAt } }));
  hourStart = launchedAt;
  syncFeed();
  addLog(
    s.settings.analysis
      ? `Megatron AI launched — analysing ${markets.map(marketName).join(", ")}`
      : `Megatron AI launched — No Analysis mode, trading ${markets.map(marketName).join(", ")} immediately`,
  );
  curHour = -1;
  mgStep = 0; lossAccum = 0; consecLosses = 0; hourProfit = 0;
  setState((st) => ({ learn: st.learn ? { ...st.learn, sessions: st.learn.sessions + 1 } : st.learn }));
  note(`Session #${(getState().learn?.sessions ?? 0) || 1} started — using lessons from ${getState().trades.length} past trades.`);
  saveRuntime();
  if (loop) clearInterval(loop);
  loop = setInterval(tickLoop, 1000);
  // stay awake on screen + keep running when minimised; on return, resync feed
  startKeepAlive(() => {
    syncFeed();
    if (getState().conn.status !== "connected" && getState().settings.token) void connectAccount();
  });
}

export function stopEngine() {
  if (loop) clearInterval(loop);
  loop = null;
  stopKeepAlive();
  setState((st) => ({ session: { ...st.session, launched: false } }));
  eng({ status: "Stopped", nextAt: null, cooldownUntil: null, signal: "" });
}

export function resumeIfLaunched() {
  const s = getState();
  if (s.session.launched && s.conn.status === "connected" && !loop) launchEngine(true);
}

function activeMarkets() {
  const s = getState().settings;
  return s.multiMarket && s.markets.length ? s.markets : [s.market];
}

function startCooldown(ms: number, why: string) {
  cooldownUntil = Date.now() + ms;
  eng({ cooldownUntil, status: `Cooldown (${why})` });
  note(`Cooldown triggered: ${why} on ${marketName(getState().engine.market)}.`, "avoid");
  addLog(`Cooldown ${Math.round(ms / 60000)} min — ${why}. Recovery resumes after.`, "warn");
}

async function tickLoop() {
  if (busy || !loop) return;
  const s = getState();
  const st = s.settings;
  const now = Date.now();
  if (s.conn.status !== "connected" || !deriv.open) {
    if (s.engine.status !== "Waiting for connection…") eng({ status: "Waiting for connection…" });
    return;
  }

  const sessionPnl = s.trades
    .filter((t) => s.session.startedAt && t.time >= s.session.startedAt)
    .reduce((a, t) => a + t.profit, 0);
  if (st.stopLoss > 0 && sessionPnl <= -st.stopLoss) {
    addLog(`Stop loss hit (${sessionPnl.toFixed(2)}). Engine stopped.`, "loss");
    return stopEngine();
  }

  if (!hourStart) hourStart = now;
  const hk = Math.floor((now - hourStart) / periodMs(st0()));
  if (hk !== curHour) {
    if (curHour !== -1) addLog("New hour — hourly target reset");
    curHour = hk;
    hourProfit = 0;
    targetLogged = false;
    bannedTypes = new Set(
      (Object.keys(hourTypeLosses) as ContractKey[]).filter(
        (k) => st.tradeMode === "manual" && (hourTypeLosses[k] ?? 0) >= st.typeMaxLosses,
      ),
    );
    hourTypeTrades = {};
    hourTypeLosses = {};
    eng({ hourProfit: 0, nextAt: null });
    saveRuntime();
  }

  const elapsed = (now - (s.session.startedAt ?? now)) % (24 * HOUR);
  if (elapsed >= st.hoursPerDay * HOUR) return eng({ status: "Resting (daily hours done)" });
  if (hourProfit >= st.hourlyTarget) {
    if (!targetLogged) {
      targetLogged = true;
      addLog(`Hourly target $${st.hourlyTarget} reached — resting until next hour`, "win");
    }
    return eng({ status: "Target reached · resting", nextAt: hourStart + (hk + 1) * periodMs(st0()) });
  }
  if (now < cooldownUntil) return;
  if (cooldownUntil) {
    cooldownUntil = 0;
    consecLosses = 0;
    consecErrors = 0;
    eng({ cooldownUntil: null });
    addLog("Cooldown over — trading continues");
    saveRuntime();
  }
  if (now < nextAllowed) return;

  maybeSwitchMarket();
  const pickRes = findSignal();
  if (!pickRes) {
    if (now - lastScanLog > 1000) {
      lastScanLog = now;
      const m = getState().engine.market;
      const ready = st.analysis ? (priceBuf[m]?.digits.length ?? 0) >= 50 : lastPrice[m] !== undefined;
      eng({
        status: !ready ? `Loading data for ${marketName(m)}` : st.analysis ? "Analysing · waiting for entry" : "Waiting for eligible contract",
        signal: "",
      });
    }
    return;
  }

  busy = true;
  try {
    await runTrade(pickRes.symbol, pickRes.cands);
    consecErrors = 0;
  } catch (e: any) {
    consecErrors++;
    addError(`Trade error: ${e.message}`);
    addLog(`Trade error: ${e.message}`, "warn");
    nextAllowed = Date.now() + 5000;
    if (consecErrors >= ERROR_COOLDOWN_AFTER) startCooldown(ERROR_COOLDOWN_MS, `${consecErrors} errors in a row`);
  } finally {
    busy = false;
  }
  if (getState().settings.tradeSpeed !== "tick") nextAllowed = Math.max(nextAllowed, Date.now() + 1500);
  if (consecLosses >= LOSS_COOLDOWN_AFTER && !cooldownUntil)
    startCooldown(LOSS_COOLDOWN_MS, `${consecLosses} losses in a row`);
  saveRuntime();
}

/** Scan active markets and return the best one with live entry signals. */
function findSignal(): { symbol: string; cands: Signal[] } | null {
  const st = getState().settings;
  if (!st.analysis) {
    const m = getState().engine.market;
    if (lastPrice[m] === undefined) return null;
    const cands = noAnalysisSignals().filter(eligible);
    return cands.length ? { symbol: m, cands } : null;
  }
  const auto = st.multiMarket && st.marketMode === "auto";
  const markets = auto ? activeMarkets() : [getState().engine.market];
  let best: { symbol: string; cands: Signal[]; edge: number } | null = null;
  for (const m of markets) {
    const b = priceBuf[m];
    if (!b || b.digits.length < 50) continue;
    const cands = analyse(b.digits, b.prices, st.contracts).filter(eligible);
    if (!cands.length) continue;
    const edge = Math.max(...cands.map((c) => c.edge));
    if (!best || edge > best.edge) best = { symbol: m, cands, edge };
  }
  if (best && auto && best.symbol !== getState().engine.market) {
    addLog(`Market fit: ${marketName(best.symbol)} shows the strongest setup`);
    eng({ market: best.symbol });
    marketStartedAt = Date.now();
    marketTrades = 0;
  }
  return best;
}

/** No-analysis mode: every enabled contract is an immediate candidate. */
function noAnalysisSignals(): Signal[] {
  const c = getState().settings.contracts;
  const out: Signal[] = [];
  for (const k of CONTRACTS) {
    if (!c[k].enabled) continue;
    if (HAS_PREDICTION.includes(k)) {
      const preds = c[k].predMode === "single" ? c[k].preds.slice(0, 1) : c[k].preds;
      for (const d of preds) {
        if ((k === "OVER" && d >= 9) || (k === "UNDER" && d <= 0)) continue;
        const prob = k === "OVER" ? (9 - d) / 10 : k === "UNDER" ? d / 10 : 0.9;
        out.push({ type: k, pred: d, prob, edge: 0.01, reason: "no analysis — direct entry" });
      }
    } else out.push({ type: k, prob: 0.5, edge: 0.01, reason: "no analysis — direct entry" });
  }
  return out;
}

function eligible(c: Signal) {
  const st = getState().settings;
  if (learnedAvoid(getState().engine.market, c.type, c.pred)) return false;
  if (st.tradeMode !== "manual") return true;
  if ((hourTypeTrades[c.type] ?? 0) >= st.typeMaxTrades) return false;
  if ((hourTypeLosses[c.type] ?? 0) >= st.typeMaxLosses) return false;
  return !bannedTypes.has(c.type);
}

function maybeSwitchMarket() {
  const st = getState().settings;
  const markets = activeMarkets();
  const cur = getState().engine.market;
  if (markets.length < 2) {
    if (cur !== markets[0]) eng({ market: markets[0]! });
    return;
  }
  if (st.marketMode !== "manual") {
    if (!markets.includes(cur)) eng({ market: markets[0]! });
    return;
  }
  let reason = "";
  if (marketTrades >= st.marketMaxTrades) reason = `max ${st.marketMaxTrades} trades reached`;
  else if (Date.now() - marketStartedAt >= st.marketMaxHours * HOUR) reason = `max ${st.marketMaxHours}h runtime reached`;
  if (reason || !markets.includes(cur)) {
    const next = markets[(markets.indexOf(cur) + 1) % markets.length]!;
    marketStartedAt = Date.now();
    marketTrades = 0;
    eng({ market: next });
    if (reason) addLog(`Switching ${marketName(cur)} → ${marketName(next)} (${reason})`);
  }
}

function typePerf(k: ContractKey) {
  const recent = getState().trades.filter((t) => t.type === k).slice(0, 6);
  const losses = recent.filter((t) => t.profit < 0).length;
  return Math.pow(0.85, losses);
}

function baseStake(c: Signal) {
  const max = getState().settings.contracts[c.type].maxStake;
  const conf = Math.min(1, Math.max(0, (c.prob - 0.35) / 0.6));
  return Math.min(max, Math.max(MIN_STAKE, round2(MIN_STAKE + (max - MIN_STAKE) * conf * typePerf(c.type))));
}

function pick(cands: Signal[], symbol: string): Signal {
  const sc = (c: Signal) => c.edge * typePerf(c.type) * (c.type === lastType ? 0.9 : 1) * learnedScore(symbol, c.type, c.pred);
  return [...cands].sort((a, b) => sc(b) - sc(a))[0]!;
}

async function runTrade(symbol: string, candsIn: Signal[]) {
  const s = getState();
  const st = s.settings;
  const tickMode = st.tradeSpeed === "tick";
  let cands = candsIn;

  let chosen: Signal;
  let stake: number;
  const recovering = st.mgEnabled && lossAccum > 0 && mgStep > 0 && mgStep < st.mgMaxSteps;

  if (recovering) {
    stake = martingaleStake(lastStake / Math.pow(Math.min(st.mgMultiplier, st.mgMaxMultiplier), mgStep - 1), st.mgMultiplier, mgStep, st.mgMaxSteps, st.mgMaxMultiplier);
    if (st.recoveryMode === "same" && lastType && cands.some((c) => c.type === lastType)) cands = cands.filter((c) => c.type === lastType);
    if (st.recoveryMode === "different" && lastType && cands.some((c) => c.type !== lastType)) cands = cands.filter((c) => c.type !== lastType);
    const need = st.recoveryCoverage / 100;
    const scored = cands
      .map((c) => {
        const ratio = payoutRatio(symbol, c.type, c.pred, tickMode ? 1 : st.contracts[c.type].ticks) ?? estProfitRatio(c.prob);
        // expected value per $ staked using the real Deriv payout
        const ls = learnedScore(symbol, c.type, c.pred, true);
        return { c, ratio, ls, cov: coverage(stake, ratio, lossAccum), ev: c.prob * ratio - (1 - c.prob) };
      })
      .sort((a, b) => b.c.prob * b.ls - a.c.prob * a.ls || b.ev - a.ev);
    const ok = scored.filter((x) => x.cov >= need);
    const best = ok[0] ?? scored.sort((a, b) => b.cov - a.cov)[0]!;
    chosen = best.c;
    // if even the best pick can't cover the target, raise stake (within max stake) so it does
    if (!ok.length && best.ratio > 0) {
      const needed = round2((lossAccum * need) / best.ratio);
      const cap = st.contracts[chosen.type].maxStake * Math.pow(Math.min(st.mgMultiplier, st.mgMaxMultiplier), st.mgMaxSteps);
      if (needed > stake) stake = Math.min(needed, cap);
      best.cov = coverage(stake, best.ratio, lossAccum);
    }
    addLog(
      `Recovery step ${mgStep}: ${label(chosen)} payout ${(best.ratio * 100).toFixed(1)}% · stake ${stake.toFixed(2)} covers ${(best.cov * 100).toFixed(0)}% of loss ${lossAccum.toFixed(2)}${ok.length ? "" : " (below target — best available)"}`,
      ok.length ? "info" : "warn",
    );
  } else {
    chosen = pick(cands.map((c) => {
      // weight edge by real payout: same win chance with a higher payout is better
      const r = payoutRatio(symbol, c.type, c.pred, tickMode ? 1 : st.contracts[c.type].ticks);
      return r ? { ...c, edge: c.edge * (1 + (c.prob * r - (1 - c.prob))) } : c;
    }), symbol);
    stake = baseStake(chosen);
  }
  stake = Math.max(MIN_STAKE, round2(stake));
  eng({ signal: `${label(chosen)} · ${chosen.reason}` });
  addLog(`Entry signal on ${marketName(symbol)}: ${label(chosen)} — ${chosen.reason}`);

  const cfg = st.contracts[chosen.type];
  const contractParams: Record<string, any> = {
    amount: stake,
    basis: "stake",
    contract_type: DERIV_TYPE[chosen.type],
    currency: s.currency,
    duration: tickMode ? 1 : cfg.ticks,
    duration_unit: "t",
  };
  if (chosen.pred !== undefined) contractParams["barrier"] = String(chosen.pred);
  eng({ status: `Buying ${label(chosen)}` });

  const symField = deriv.mode === "pat" ? "underlying_symbol" : "symbol";
  const fullParams = { ...contractParams, [symField]: symbol };
  const isUnknown = (e: any) => /unknown contract proposal|proposal.*(expired|not found)|invalid.*proposal/i.test(String(e?.message ?? e));
  const checkCov = (p: number) => {
    if (recovering && lossAccum > 0) {
      const cov = (p - stake) / lossAccum;
      addLog(`Pre-buy check: live payout ${p.toFixed(2)} → covers ${(cov * 100).toFixed(0)}% of loss`, cov >= st.recoveryCoverage / 100 ? "info" : "warn");
    }
  };
  // 1) Fresh proposal -> immediate buy at its ask_price (never cached).
  const freshBuy = async () => {
    const prop = await deriv.send({ proposal: 1, ...fullParams });
    const pr = prop?.proposal;
    if (!pr?.id) throw new Error("Deriv did not return a proposal ID");
    checkCov(Number(pr.payout));
    const b = await deriv.send({ buy: pr.id, price: Number(pr.ask_price ?? stake) });
    return { cid: b.buy.contract_id as number, payout: Number(b.buy.payout ?? pr.payout) };
  };
  // 2) Subscribed proposal -> buy -> forget subscription.
  const subBuy = async () => {
    const prop = await deriv.send({ proposal: 1, subscribe: 1, ...fullParams });
    const pr = prop?.proposal;
    const subId = prop?.subscription?.id;
    try {
      if (!pr?.id) throw new Error("Deriv did not return a proposal ID");
      const b = await deriv.send({ buy: pr.id, price: Number(pr.ask_price ?? stake) });
      return { cid: b.buy.contract_id as number, payout: Number(b.buy.payout ?? pr.payout) };
    } finally {
      if (subId) deriv.send({ forget: subId }).catch(() => {});
    }
  };
  // 3) Last resort: one-step buy with full parameters.
  const oneStep = async () => {
    const b = await deriv.send({ buy: 1, price: stake, parameters: fullParams });
    return { cid: b.buy.contract_id as number, payout: Number(b.buy.payout ?? 0) };
  };
  let res: { cid: number; payout: number } | null = null;
  let lastErr: any;
  for (const [name, fn] of [["fresh", freshBuy], ["fresh", freshBuy], ["subscribed", subBuy], ["one-step", oneStep]] as const) {
    try { res = await fn(); break; } catch (e) {
      lastErr = e;
      if (!isUnknown(e)) throw e;
      addLog(`Proposal expired — retrying with ${name} proposal`, "warn");
    }
  }
  if (!res) throw lastErr;
  const cid = res.cid;
  const payout = res.payout;
  learnFromTrade(symbol, chosen.type, chosen.pred, contractParams["duration"], stake, payout);
  const entryPrice = lastPrice[symbol] ?? 0;
  addLog(`Bought ${label(chosen)} · stake ${stake.toFixed(2)} · payout ${payout.toFixed(2)}`);

  let profit: number;
  if (tickMode) {
    const next = await waitNextTick(symbol);
    const d = next.digit;
    const p = chosen.pred ?? 0;
    const win =
      chosen.type === "EVEN" ? d % 2 === 0 :
      chosen.type === "ODD" ? d % 2 === 1 :
      chosen.type === "OVER" ? d > p :
      chosen.type === "UNDER" ? d < p :
      chosen.type === "DIFFERS" ? d !== p :
      chosen.type === "RISE" ? next.price > entryPrice :
      next.price < entryPrice;
    profit = win ? payout - stake : -stake;
  } else {
    profit = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        off();
        reject(new Error("Contract result timed out"));
      }, 300_000);
      let off: () => unknown = deriv.onMessage((m) => {
        const poc = m.proposal_open_contract;
        if (m.msg_type !== "proposal_open_contract" || !poc || poc.contract_id !== cid) return;
        setState(() => ({ floating: poc.profit ?? 0 }));
        if (poc.is_sold) {
          clearTimeout(timeout);
          off();
          resolve(Number(poc.profit));
        }
      });
      const sub = () => deriv.send({ proposal_open_contract: 1, contract_id: cid, subscribe: 1 }).catch(() => {});
      // after an internet drop, re-subscribe to the open contract when the socket is back
      const offOpen = deriv.onMessage((m) => m.msg_type === "__open" && setTimeout(sub, 1500));
      const off0 = off;
      off = () => { off0(); offOpen(); };
      sub();
    });
  }
  setState(() => ({ floating: 0 }));

  const trade: Trade = {
    id: String(cid),
    time: Date.now(),
    type: chosen.type,
    pred: chosen.pred,
    symbol,
    stake,
    profit: round2(profit),
    recovery: recovering,
  };
  setState((st2) => ({ trades: [trade, ...st2.trades].slice(0, 2000) }));
  learn(trade);
  hourProfit = round2(hourProfit + profit);
  eng({ hourProfit });
  marketTrades++;
  hourTypeTrades[chosen.type] = (hourTypeTrades[chosen.type] ?? 0) + 1;
  lastType = chosen.type;
  lastStake = stake;

  if (profit >= 0) {
    addLog(`WIN +${profit.toFixed(2)} on ${label(chosen)}`, "win");
    consecLosses = 0;
    mgStep = 0;
    lossAccum = 0;
  } else {
    addLog(`LOSS ${profit.toFixed(2)} on ${label(chosen)}`, "loss");
    consecLosses++;
    hourTypeLosses[chosen.type] = (hourTypeLosses[chosen.type] ?? 0) + 1;
    if (st.mgEnabled) {
      lossAccum = round2(lossAccum - profit);
      mgStep++;
      if (mgStep >= st.mgMaxSteps) {
        addLog(`Max martingale steps (${st.mgMaxSteps}) reached — resetting to base stake`, "warn");
        mgStep = 0;
        lossAccum = 0;
      }
    }
  }
}

function label(c: Signal) {
  return c.pred !== undefined ? `${c.type} ${c.pred}` : c.type;
}
