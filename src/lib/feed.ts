// Public market-data feed: its own unauthenticated Deriv socket (new Options API
// public endpoint) that streams ticks for many symbols at once. Independent of
// the account socket so live prices work before connecting and across markets.
import { lastDigit } from "./deriv";

const FEED_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
const SUB_GAP_MS = 400; // Deriv rate-limits bursts of ticks_history requests
const SYMBOL_STALE_MS = 15_000;

export interface FeedTick {
  symbol: string;
  price: number;
  digit: number;
  pip: number;
}

type TickCb = (t: FeedTick) => void;
type HistCb = (symbol: string, prices: number[], pip: number) => void;
type ErrCb = (msg: string) => void;

class MarketFeed {
  private ws: WebSocket | null = null;
  private want = new Set<string>();
  private subs = new Map<string, string>(); // symbol -> subscription id | "pending"
  private lastTick = new Map<string, number>();
  private pip: Record<string, number> = {};
  private reqId = 1;
  private reqSym = new Map<number, string>();
  private queue: string[] = [];
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private lastMsg = 0;
  onTick: TickCb = () => {};
  onHistory: HistCb = () => {};
  onError: ErrCb = () => {};

  setSymbols(list: string[]) {
    if (typeof window === "undefined") return;
    const next = new Set(list.filter(Boolean));
    for (const s of [...this.want]) if (!next.has(s)) this.unsub(s);
    this.want = next;
    if (!this.ws || this.ws.readyState > 1) return this.connect();
    if (this.ws.readyState === 1) for (const s of next) if (!this.subs.has(s)) this.enqueue(s);
  }

  private connect() {
    if (this.retry) clearTimeout(this.retry);
    const ws = new WebSocket(FEED_WS);
    this.ws = ws;
    this.subs.clear();
    this.queue = [];
    ws.onopen = () => {
      this.lastMsg = Date.now();
      for (const s of this.want) this.enqueue(s);
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify({ ping: 1 }));
        // whole-socket watchdog
        if (Date.now() - this.lastMsg > 20_000) return ws.close();
        // per-symbol watchdog: a market that stopped ticking gets resubscribed
        const now = Date.now();
        for (const s of this.want) {
          const t = this.lastTick.get(s) ?? 0;
          if (this.subs.get(s) !== "pending" && now - t > SYMBOL_STALE_MS) {
            this.unsub(s);
            this.enqueue(s);
          }
        }
      }, 5_000);
    };
    ws.onerror = () => this.onError("Market data connection error");
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      if (this.ws !== ws) return;
      this.subs.clear();
      this.onError("Market data disconnected — reconnecting");
      this.retry = setTimeout(() => this.connect(), 2000);
    };
    ws.onmessage = (ev) => {
      this.lastMsg = Date.now();
      let m: any;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const reqSym = m.req_id ? this.reqSym.get(m.req_id) : undefined;
      if (m.error) {
        if (reqSym) {
          this.reqSym.delete(m.req_id);
          if (m.error.code === "AlreadySubscribed") return;
          this.subs.delete(reqSym);
          // rate limited or transient: retry this symbol shortly
          if (this.want.has(reqSym)) setTimeout(() => this.want.has(reqSym) && !this.subs.has(reqSym) && this.enqueue(reqSym), 3000);
        }
        if (m.error.code !== "AlreadySubscribed" && !/rate limit/i.test(m.error.message ?? ""))
          this.onError(`Market data ${reqSym ?? ""}: ${m.error.message}`);
        return;
      }
      if (m.msg_type === "history" && reqSym) {
        this.reqSym.delete(m.req_id);
        const pip = Number(m.pip_size ?? this.pip[reqSym] ?? 2);
        this.pip[reqSym] = pip;
        this.subs.set(reqSym, m.subscription?.id ?? "live");
        this.lastTick.set(reqSym, Date.now());
        this.onHistory(reqSym, (m.history?.prices ?? []).map(Number), pip);
      }
      if (m.msg_type === "tick" && m.tick) {
        const sym: string = m.tick.symbol;
        if (!this.want.has(sym)) {
          if (m.subscription?.id) ws.send(JSON.stringify({ forget: m.subscription.id }));
          return;
        }
        const pip = Number(m.tick.pip_size ?? this.pip[sym] ?? 2);
        this.pip[sym] = pip;
        if (m.subscription?.id) this.subs.set(sym, m.subscription.id);
        this.lastTick.set(sym, Date.now());
        const price = Number(m.tick.quote);
        this.onTick({ symbol: sym, price, pip, digit: lastDigit(price, pip) });
      }
    };
  }

  private enqueue(symbol: string) {
    if (this.queue.includes(symbol)) return;
    this.subs.set(symbol, "pending");
    this.queue.push(symbol);
    this.drain();
  }

  private drain() {
    if (this.queueTimer) return;
    const next = this.queue.shift();
    if (!next) return;
    if (this.want.has(next) && this.ws?.readyState === 1) {
      const req_id = this.reqId++;
      this.reqSym.set(req_id, next);
      this.ws.send(
        JSON.stringify({ ticks_history: next, count: 200, end: "latest", style: "ticks", subscribe: 1, req_id }),
      );
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
    if (id && id !== "pending" && id !== "live" && this.ws?.readyState === 1)
      this.ws.send(JSON.stringify({ forget: id }));
  }
}

export const feed = new MarketFeed();
