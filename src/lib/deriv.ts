// Deriv connection client supporting both legacy API tokens and PAT tokens.
// PAT flow (user-supplied): REST /accounts -> POST /accounts/:id/otp -> connect
// to the returned authenticated WebSocket URL.
type Msg = any;
type Listener = (m: Msg) => void;

// PAT tokens use Deriv's new PAT-format App ID.
export const DERIV_NEW_APP_ID = "34DWL0183Hjp3s2BF8ROk";

const DERIV_REST_BASE = "https://api.derivws.com/trading/v1/options";

export type TokenMode = "legacy" | "pat";

export interface DerivAuthResult {
  balance: number;
  currency: string;
  loginid: string;
  mode: TokenMode;
}

function extractDerivRestError(body: any, fallback: string): string {
  return (
    body?.error?.message ||
    body?.message ||
    body?.error ||
    fallback
  );
}

async function derivRest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${DERIV_REST_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": DERIV_NEW_APP_ID,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
  } catch (error: any) {
    throw new Error(error?.message || "Could not reach Deriv PAT API");
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(extractDerivRestError(body, `Deriv PAT API failed (${response.status})`));
  }
  return body as T;
}

export class DerivClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, { res: (m: Msg) => void; rej: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  mode: TokenMode = "pat";
  private lastMsgAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  onMessage(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private ensureSocket(url: string): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      const openTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.onclose = null;
        try { ws.close(); } catch {}
        if (this.ws === ws) this.ws = null;
        reject(new Error("Deriv connection timed out"));
      }, 12000);
      ws.onopen = () => {
        settled = true;
        clearTimeout(openTimer);
        this.lastMsgAt = Date.now();
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.watchdog) clearInterval(this.watchdog);
        this.pingTimer = setInterval(() => this.send({ ping: 1 }).catch(() => {}), 20000);
        // silent/dead socket detection: no message for 60s -> force close so we reconnect
        this.watchdog = setInterval(() => {
          if (this.ws === ws && Date.now() - this.lastMsgAt > 60000) ws.close();
        }, 10000);
        resolve();
        this.listeners.forEach((l) => l({ msg_type: "__open" }));
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        reject(new Error("Connection to Deriv failed"));
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.watchdog) clearInterval(this.watchdog);
        this.pingTimer = this.watchdog = null;
        this.ws = null;
        this.pending.forEach((p) => p.rej(new Error("Connection closed")));
        this.pending.clear();
        this.listeners.forEach((l) => l({ msg_type: "__closed" }));
      };
      ws.onmessage = (ev) => {
        this.lastMsgAt = Date.now();
        const m: Msg = JSON.parse(ev.data);
        const p = m.req_id ? this.pending.get(m.req_id) : undefined;
        if (p) {
          this.pending.delete(m.req_id);
          m.error ? p.rej(new Error(m.error.message)) : p.res(m);
        }
        this.listeners.forEach((l) => l(m));
      };
    });
  }

  async send(req: Msg): Promise<Msg> {
    // Never silently open an unauthenticated socket; the account must reconnect first.
    if (!this.open) throw new Error("Not connected");
    const req_id = this.reqId++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        if (this.pending.delete(req_id)) rej(new Error("Deriv did not respond in time"));
      }, 20000);
      this.pending.set(req_id, {
        res: (m) => { clearTimeout(t); res(m); },
        rej: (e) => { clearTimeout(t); rej(e); },
      });
      this.ws!.send(JSON.stringify({ ...req, req_id }));
    });
  }

  // PAT: REST accounts -> OTP websocket URL -> connect directly.
  private async connectPat(token: string): Promise<DerivAuthResult> {
    this.mode = "pat";

    // Step 1: accounts list via REST
    const accountsResponse = await derivRest<{ data?: any[] | any }>("/accounts", token, {
      method: "GET",
    });
    const accounts = Array.isArray(accountsResponse.data)
      ? accountsResponse.data
      : accountsResponse.data
        ? [accountsResponse.data]
        : [];
    const account = accounts.find((a) => a?.status === "active") || accounts[0];
    const accountId = String(account?.account_id || account?.id || account?.loginid || "");
    if (!accountId) {
      throw new Error("No Deriv options account found for this PAT token");
    }

    // Step 2: OTP to get an authenticated WebSocket URL
    const otpResponse = await derivRest<{ data?: { url?: string; websocket_url?: string } }>(
      `/accounts/${encodeURIComponent(accountId)}/otp`,
      token,
      { method: "POST" },
    );
    const websocketUrl = String(otpResponse.data?.url || otpResponse.data?.websocket_url || "");
    if (!websocketUrl) {
      throw new Error("Deriv PAT API did not return a WebSocket URL");
    }

    // Step 3: connect directly using the authenticated URL
    await this.ensureSocket(websocketUrl);
    await this.send({ balance: 1, subscribe: 1 }).catch(() => {});

    return {
      balance: Number(account?.balance ?? 0),
      currency: String(account?.currency ?? "USD"),
      loginid: accountId,
      mode: "pat",
    };
  }

  async connect(rawToken: string): Promise<DerivAuthResult> {
    const token = rawToken.trim();
    if (!token) throw new Error("Empty token");
    // Single authenticated API connection only (no public/1089 socket).
    return await this.connectPat(token);
  }

  disconnect() {
    const ws = this.ws;
    this.ws = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.pingTimer = this.watchdog = null;
    this.pending.forEach((p) => p.rej(new Error("Disconnected")));
    this.pending.clear();
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }
}

export const deriv = new DerivClient();

export function lastDigit(price: number, pip: number) {
  const s = price.toFixed(pip);
  return Number(s[s.length - 1]);
}
