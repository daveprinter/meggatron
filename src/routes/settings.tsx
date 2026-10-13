import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NumField, Panel, Segmented, Stat, Toggle } from "@/components/kit";
import { stopEngine } from "@/lib/engine";
import { cn } from "@/lib/utils";
import { addLog, nairobiTime, setState, updateSettings, useApp } from "@/lib/store";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings · Megatron AI" },
      { name: "description", content: "Session, hourly profit target, martingale and recovery settings." },
      { property: "og:title", content: "Megatron AI — Settings" },
      { property: "og:description", content: "Configure sessions, martingale and recovery for Megatron AI." },
    ],
  }),
  component: SettingsPage,
});

function fmtDur(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
}

function SettingsPage() {
  const s = useApp((x) => x.settings);
  const session = useApp((x) => x.session);
  const nav = useNavigate();
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  return (
    <>
      <Panel title="Session">
        <div className="mb-4 text-center">
          <div className="text-xs text-muted-foreground">Nairobi time</div>
          <div className="num text-3xl font-bold glow-text">{now ? nairobiTime(new Date(now)) : "--"}</div>
        </div>
        {session.startedAt ? (
          <>
            <div className="mb-3 rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
              <div className="font-semibold text-success">● LIVE SESSION</div>
              <div className="text-muted-foreground">
                Started {nairobiTime(new Date(session.startedAt))} · running{" "}
                <span className="num text-foreground">{fmtDur(Math.max(0, now - session.startedAt))}</span>
              </div>
            </div>
            <HourStats now={now} />
            <div className="grid grid-cols-2 gap-2">
              <button
                className="btn-danger"
                onClick={() => {
                  stopEngine();
                  setState(() => ({ session: { startedAt: null, launched: false } }));
                  addLog("Session ended");
                }}
              >
                End Session
              </button>
              <button className="btn-primary" onClick={() => nav({ to: "/" })}>Launch →</button>
            </div>
          </>
        ) : (
          <button
            className="btn-primary w-full"
            onClick={() => {
              setState(() => ({ session: { startedAt: Date.now(), launched: false } }));
              addLog(`Session started at ${nairobiTime()} EAT`);
            }}
          >
            Start Session
          </button>
        )}
      </Panel>

      <Panel title="Trade Speed">
        <Segmented
          value={s.tradeSpeed}
          options={[
            { value: "normal", label: "Normal Speed" },
            { value: "tick", label: "Every Tick Speed" },
          ]}
          onChange={(v) => updateSettings({ tradeSpeed: v })}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          {s.tradeSpeed === "normal"
            ? "Waits for each contract to settle on Deriv before sending the next."
            : "Trades on every tick: each 1-tick contract is settled on the next tick and the next trade (with martingale applied instantly) goes out on that same tick."}
        </p>
      </Panel>

      <Panel title="Targets">
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Profit per period ($)" value={s.hourlyTarget} step={0.1} onChange={(n) => updateSettings({ hourlyTarget: n })} />
          <NumField label="Trading period (minutes)" value={s.periodMinutes} min={1} onChange={(n) => updateSettings({ periodMinutes: Math.max(1, Math.min(1440, Math.round(n))) })} />
          <NumField label="Hours per 24h day" value={s.hoursPerDay} min={1} onChange={(n) => updateSettings({ hoursPerDay: Math.max(1, Math.min(24, n)) })} />
          <NumField label="Session stop loss ($)" value={s.stopLoss} step={0.5} onChange={(n) => updateSettings({ stopLoss: n })} />
        </div>
      </Panel>

      <Panel title="Martingale">
        <Toggle label="Enable martingale" checked={s.mgEnabled} onChange={(b) => updateSettings({ mgEnabled: b })} />
        {s.mgEnabled && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <NumField label="Multiplier" value={s.mgMultiplier} step={0.1} min={1} onChange={(n) => updateSettings({ mgMultiplier: n })} />
            <NumField label="Max multiplier allowed" value={s.mgMaxMultiplier} step={0.1} min={1} onChange={(n) => updateSettings({ mgMaxMultiplier: n })} />
            <NumField label="Max martingale steps" value={s.mgMaxSteps} min={1} onChange={(n) => updateSettings({ mgMaxSteps: Math.max(1, n) })} />
            <p className="col-span-2 text-xs text-muted-foreground">
              Stakes always rounded to 2 decimals. Multiplier never exceeds {Math.min(s.mgMultiplier, s.mgMaxMultiplier)}×. After {s.mgMaxSteps} steps the stake resets.
            </p>
          </div>
        )}
      </Panel>

      <Panel title="Recovery mode">
        <Segmented
          value={s.recoveryMode}
          options={[
            { value: "same", label: "Same type" },
            { value: "different", label: "Different" },
            { value: "auto", label: "AI decides" },
          ]}
          onChange={(v) => updateSettings({ recoveryMode: v })}
        />
        <div className="mt-3">
          <NumField
            label="Minimum loss coverage (%)"
            value={s.recoveryCoverage}
            min={50}
            onChange={(n) => updateSettings({ recoveryCoverage: Math.max(50, Math.min(150, n)) })}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Before recovering, the AI checks the expected payout and only picks contracts that cover at least this share of the loss.
          </p>
        </div>
      </Panel>
    </>
  );
}

function HourStats({ now }: { now: number }) {
  const session = useApp((x) => x.session);
  const trades = useApp((x) => x.trades);
  const P = Math.max(1, useApp((x) => x.settings.periodMinutes) || 60) * 60000;
  const start = session.hourStart ?? session.startedAt ?? 0;
  const inSession = trades.filter((t) => session.startedAt && t.time >= session.startedAt);
  const wins = inSession.filter((t) => t.profit >= 0).length;
  const losses = inSession.length - wins;
  const net = inSession.reduce((a, t) => a + t.profit, 0);
  const cur = start && now >= start ? Math.floor((now - start) / P) : 0;
  const hours = Array.from({ length: cur + 1 }, (_, i) => {
    const from = start + i * P;
    const ts = inSession.filter((t) => t.time >= from && t.time < from + P);
    const w = ts.filter((t) => t.profit >= 0).length;
    return { i, from, n: ts.length, w, l: ts.length - w, pnl: ts.reduce((a, t) => a + t.profit, 0) };
  }).reverse();
  return (
    <div className="mb-3 space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Wins" value={wins} tone="up" />
        <Stat label="Losses" value={losses} tone="down" />
        <Stat label="Net P/L" value={`${net >= 0 ? "+" : ""}${net.toFixed(2)}`} tone={net >= 0 ? "up" : "down"} />
      </div>
      {start > 0 && (
        <div className="space-y-2">
          {hours.map((h) => (
            <div key={h.i} className={cn("rounded-lg border p-3 text-sm", h.i === cur ? "border-primary bg-primary/10" : "bg-secondary/50")}>
              <div className="flex justify-between font-semibold">
                <span>Period {h.i + 1} {h.i === cur ? "· running" : "· done"}</span>
                <span className={cn("num", h.pnl >= 0 ? "text-success" : "text-destructive")}>
                  {h.pnl >= 0 ? "+" : ""}{h.pnl.toFixed(2)}
                </span>
              </div>
              <div className="num text-xs text-muted-foreground">
                Started {nairobiTime(new Date(h.from))} · {h.n} trades · {h.w} wins · {h.l} losses
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
