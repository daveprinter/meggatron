// Machine learning memory: learns from every settled trade across sessions
// (persisted in the store) and feeds a score back into the engine's picks.
import { type ContractKey, getState, marketName, setState, type Trade } from "./store";

export interface Stat {
  n: number;
  w: number;
  pnl: number;
  stake: number;
  last: number;
}
export interface LearnState {
  combos: Record<string, Stat>; // symbol|type|pred
  markets: Record<string, Stat>;
  types: Record<string, Stat>;
  hours: Record<string, Stat>; // EAT hour of day 0-23
  afterLoss: Record<string, Stat>; // type taken as recovery
  insights: { t: number; msg: string; kind: "avoid" | "favor" | "info" }[];
  sessions: number;
}
export const emptyLearn = (): LearnState => ({
  combos: {}, markets: {}, types: {}, hours: {}, afterLoss: {}, insights: [], sessions: 0,
});

const MIN_N = 8;
export const comboKey = (s: string, t: ContractKey, p?: number) => `${s}|${t}|${p ?? "-"}`;
const eatHour = (ms: number) => String(new Date(ms + 3 * 3600_000).getUTCHours());

function bump(map: Record<string, Stat>, k: string, tr: Trade) {
  const o = map[k] ?? { n: 0, w: 0, pnl: 0, stake: 0, last: 0 };
  return { ...map, [k]: { n: o.n + 1, w: o.w + (tr.profit >= 0 ? 1 : 0), pnl: +(o.pnl + tr.profit).toFixed(2), stake: +(o.stake + tr.stake).toFixed(2), last: tr.time } };
}

export const winRate = (s?: Stat) => (s && s.n ? s.w / s.n : 0);
export const roi = (s?: Stat) => (s && s.stake ? s.pnl / s.stake : 0);

export function learn(tr: Trade) {
  setState((st) => {
    const L = st.learn ?? emptyLearn();
    const ck = comboKey(tr.symbol, tr.type, tr.pred);
    const next: LearnState = {
      ...L,
      combos: bump(L.combos, ck, tr),
      markets: bump(L.markets, tr.symbol, tr),
      types: bump(L.types, tr.type, tr),
      hours: bump(L.hours, eatHour(tr.time), tr),
      afterLoss: tr.recovery ? bump(L.afterLoss, tr.type, tr) : L.afterLoss,
    };
    const c = next.combos[ck]!;
    const name = `${tr.type}${tr.pred !== undefined ? " " + tr.pred : ""} on ${marketName(tr.symbol)}`;
    const ins: LearnState["insights"] = [];
    if (c.n >= MIN_N && c.n % 4 === 0) {
      if (roi(c) < -0.05) ins.push({ t: Date.now(), kind: "avoid", msg: `${name} is losing money (win ${(winRate(c) * 100).toFixed(0)}%, ROI ${(roi(c) * 100).toFixed(0)}% over ${c.n} trades) — will be avoided.` });
      else if (roi(c) > 0.05) ins.push({ t: Date.now(), kind: "favor", msg: `${name} is profitable (win ${(winRate(c) * 100).toFixed(0)}%, ROI +${(roi(c) * 100).toFixed(0)}% over ${c.n} trades) — will be preferred.` });
    }
    if (tr.recovery) {
      const r = next.afterLoss[tr.type]!;
      if (r.n >= 5 && r.n % 5 === 0)
        ins.push({ t: Date.now(), kind: winRate(r) >= 0.6 ? "favor" : "avoid", msg: `As a recovery trade, ${tr.type} wins ${(winRate(r) * 100).toFixed(0)}% of the time (${r.n} recoveries).` });
    }
    const h = next.hours[eatHour(tr.time)]!;
    if (h.n >= 10 && h.n % 10 === 0)
      ins.push({ t: Date.now(), kind: h.pnl >= 0 ? "favor" : "avoid", msg: `Trading around ${eatHour(tr.time)}:00 EAT: ${h.pnl >= 0 ? "+" : ""}${h.pnl.toFixed(2)} over ${h.n} trades.` });
    return { learn: { ...next, insights: [...ins, ...next.insights].slice(0, 300) } };
  });
}

export function note(msg: string, kind: "avoid" | "favor" | "info" = "info") {
  setState((st) => {
    const L = st.learn ?? emptyLearn();
    return { learn: { ...L, insights: [{ t: Date.now(), msg, kind }, ...L.insights].slice(0, 300) } };
  });
}

/** Multiplier (~0.3 – 1.5) for a candidate based on what was learnt. */
export function learnedScore(symbol: string, type: ContractKey, pred?: number, recovery = false) {
  const L = getState().learn;
  if (!L) return 1;
  let m = 1;
  const c = L.combos[comboKey(symbol, type, pred)];
  if (c && c.n >= MIN_N) m *= Math.min(1.5, Math.max(0.3, 1 + roi(c) * 2));
  const mk = L.markets[symbol];
  if (mk && mk.n >= 20) m *= Math.min(1.2, Math.max(0.7, 1 + roi(mk)));
  if (recovery) {
    const r = L.afterLoss[type];
    if (r && r.n >= 5) m *= 0.6 + winRate(r) * 0.8;
  }
  return m;
}

/** True when this combo has clearly proven to lose money. */
export function learnedAvoid(symbol: string, type: ContractKey, pred?: number) {
  const c = getState().learn?.combos[comboKey(symbol, type, pred)];
  return !!c && c.n >= MIN_N * 2 && roi(c) < -0.15;
}

export function resetLearning() {
  setState(() => ({ learn: emptyLearn() }));
}
