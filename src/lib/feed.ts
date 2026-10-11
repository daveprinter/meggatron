// Market-data feed over the single authenticated Deriv API connection (deriv.ts).
// No separate public socket: prices only stream once the API token is connected.
import { deriv, lastDigit } from "./deriv";

const SUB_GAP_MS = 400; // Deriv rate-limits bursts of ticks_history requests
const SYMBOL_STALE_MS = 15_000;

export interface FeedTick {
  symbol: string;
  price: number;
  digit: number;
  pip: number;
}

class MarketFeed {
  private want = new Set<string>();
  private subs = new Map<string, string>(); // symbol -> subscription id | "pending"
  private lastTick = new Map<string, number>();
  private pip: Record<string, number> = {};
  private queue: string[] = [];
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private wired = false;
  onTick: (t: FeedTick) => void = () => {};
  onHistory: (symbol: string, prices: number[], pip: number) => void = () => {};
  onError: (msg: string) => void = () => {};

  private wire() {
    if (this.wired) return;
    this.wired = true;
    deriv.onMessage((m) => {
      if (m.msg_type === "__open") {
        this.subs.clear();
        this.queue = [];
        for (const s of this.want) this.enqueue(s);
        return;
      }
      if (m.msg_type === "__closed") {
        this.subs.clear();
        this.queue = [];
        return;
      }
      if (m.msg_type === "tick" && m.tick) {
        const sym: string = m.tick.symbol;
        if (!this.want.has(sym)) {
          if (m.subscription?.id) deriv.send({ forget: m.subscription.id }).catch(() => {});
          return;
        }
        const pip = Number(m.tick.pip_size ?? this.pip[sym] ?? 2);
        this.pip[sym] = pip;
        if (m.subscription?.id) this.subs.set(sym, m.subscription.id);
        this.lastTick.set(sym, Date.now());
        const price = Number(m.tick.quote);
        this.onTick({ symbol: sym, price, pip, digit: lastDigit(price, pip) });
      }
    });
    this.watch = setInterval(() => {
      if (!deriv.open) return;
      const now = Date.now();
      for (const s of this.want) {
        if (this.subs.get(s) !== "pending" && now - (this.lastTick.get(s) ?? 0) > SYMBOL_STALE_MS) {
          this.unsub(s);
          this.enqueue(s);
        }
      }
    }, 5_000);
  }

  setSymbols(list: string[]) {
    if (typeof window === "undefined") return;
    this.wire();
    const next = new Set(list.filter(Boolean));
    for (const s of [...this.want]) if (!next.has(s)) this.unsub(s);
    this.want = next;
    if (deriv.open) for (const s of next) if (!this.subs.has(s)) this.enqueue(s);
  }

  private enqueue(symbol: string) {
    if (this.queue.includes(symbol)) return;
    this.subs.set(symbol, "pending");
    this.queue.push(symbol);
    this.drain();
  }

  private drain() {
    if (this.queueTimer) return;
    const sym = this.queue.shift();
    if (!sym) return;
    if (this.want.has(sym) && deriv.open) {
      deriv
        .send({ ticks_history: sym, count: 200, end: "latest", style: "ticks", subscribe: 1 })
        .then((m) => {
          const pip = Number(m.pip_size ?? this.pip[sym] ?? 2);
          this.pip[sym] = pip;
          this.subs.set(sym, m.subscription?.id ?? "live");
          this.lastTick.set(sym, Date.now());
          this.onHistory(sym, (m.history?.prices ?? []).map(Number), pip);
        })
        .catch((e: Error) => {
          if (/already subscribed/i.test(e.message)) return;
          this.subs.delete(sym);
          if (!/rate limit|not connected|closed|disconnected/i.test(e.message)) this.onError(`Market data ${sym}: ${e.message}`);
          setTimeout(() => this.want.has(sym) && !this.subs.has(sym) && deriv.open && this.enqueue(sym), 3000);
        });
    } else {
      this.subs.delete(sym);
    }
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      this.drain();
    }, SUB_GAP_MS);
  }

  private unsub(symbol: string) {
    const id = this.subs.get(symbol);
    this.subs.delete(symbol);
    this.queue = this.queue.filter((s) => s !== symbol);
    if (id && id !== "pending" && id !== "live" && deriv.open) deriv.send({ forget: id }).catch(() => {});
  }
}

export const feed = new MarketFeed();
