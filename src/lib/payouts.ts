// Live Deriv payout table. Asks Deriv for price proposals (no purchase) across
// markets, contract types, barriers and durations, and learns from real trades.
import { deriv } from "./deriv";
import { CONTRACTS, type ContractKey, DERIV_TYPE, getState, HAS_PREDICTION, setState } from "./store";

export interface PayoutQuote {
  ratio: number; // profit / stake when the contract wins
  payout: number;
  stake: number;
  t: number;
  src: "deriv" | "trade";
}

export const payoutKey = (symbol: string, type: ContractKey, pred: number | undefined, ticks: number) =>
  `${symbol}|${type}|${pred ?? "-"}|${ticks}`;

export function predsFor(type: ContractKey): (number | undefined)[] {
  if (!HAS_PREDICTION.includes(type)) return [undefined];
  if (type === "OVER") return [0, 1, 2, 3, 4, 5, 6, 7, 8];
  if (type === "UNDER") return [1, 2, 3, 4, 5, 6, 7, 8, 9];
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
}

/** Best known profit ratio for this exact contract; falls back to nearest duration. */
export function payoutRatio(symbol: string, type: ContractKey, pred: number | undefined, ticks: number): number | null {
  const p = getState().payouts;
  const exact = p[payoutKey(symbol, type, pred, ticks)];
  if (exact) return exact.ratio;
  for (let d = 1; d <= 10; d++) {
    const q = p[payoutKey(symbol, type, pred, d)];
    if (q) return q.ratio;
  }
  return null;
}

function save(key: string, q: PayoutQuote) {
  setState((s) => ({ payouts: { ...s.payouts, [key]: q } }));
}

/** Learn from a settled real trade. */
export function learnFromTrade(symbol: string, type: ContractKey, pred: number | undefined, ticks: number, stake: number, payout: number) {
  if (!(payout > 0) || !(stake > 0)) return;
  save(payoutKey(symbol, type, pred, ticks), { ratio: payout / stake - 1, payout, stake, t: Date.now(), src: "trade" });
}

export async function quote(symbol: string, type: ContractKey, pred: number | undefined, ticks: number, stake = 1) {
  const s = getState();
  const params: Record<string, any> = {
    proposal: 1,
    amount: stake,
    basis: "stake",
    contract_type: DERIV_TYPE[type],
    currency: s.currency || "USD",
    duration: ticks,
    duration_unit: "t",
  };
  if (pred !== undefined) params["barrier"] = String(pred);
  if (deriv.mode === "pat") params["underlying_symbol"] = symbol;
  else params["symbol"] = symbol;
  const r = await deriv.send(params);
  const payout = Number(r?.proposal?.payout);
  if (!(payout > 0)) throw new Error(r?.error?.message ?? "No payout");
  const q: PayoutQuote = { ratio: payout / stake - 1, payout, stake, t: Date.now(), src: "deriv" };
  save(payoutKey(symbol, type, pred, ticks), q);
  return q;
}

// ---------- background scanner ----------
let timer: ReturnType<typeof setTimeout> | null = null;
let focus: string | null = null;
export function setPayoutFocus(symbol: string | null) {
  focus = symbol;
}

function jobs() {
  const s = getState();
  const st = s.settings;
  const markets = new Set<string>();
  if (focus) markets.add(focus);
  markets.add(s.engine.market);
  markets.add(st.market);
  if (st.multiMarket) st.markets.forEach((m) => markets.add(m));
  const out: [string, ContractKey, number | undefined, number][] = [];
  for (const m of markets)
    for (const k of CONTRACTS) {
      const durs = new Set([1, st.contracts[k].ticks, 5]);
      for (const d of durs) for (const p of predsFor(k)) out.push([m, k, p, d]);
    }
  return out;
}

let queue: ReturnType<typeof jobs> = [];
export function startPayoutScanner() {
  if (timer || typeof window === "undefined") return;
  const step = async () => {
    try {
      if (getState().conn.status === "connected") {
        if (!queue.length) {
          // refresh oldest first
          const p = getState().payouts;
          queue = jobs().sort(
            (a, b) => (p[payoutKey(...a)]?.t ?? 0) - (p[payoutKey(...b)]?.t ?? 0),
          );
        }
        const j = queue.shift();
        const age = j ? Date.now() - (getState().payouts[payoutKey(...j)]?.t ?? 0) : 0;
        if (j && age > 60_000) await quote(...j).catch(() => {});
      }
    } finally {
      timer = setTimeout(step, 400);
    }
  };
  timer = setTimeout(step, 1000);
}
