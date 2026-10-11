import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Panel, Segmented } from "@/components/kit";
import { payoutKey, predsFor, setPayoutFocus } from "@/lib/payouts";
import { CONTRACTS, MARKETS, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/payouts")({
  head: () => ({
    meta: [
      { title: "Payouts · Megatron AI" },
      { name: "description", content: "Live Deriv payouts by market, contract, prediction and duration." },
      { property: "og:title", content: "Megatron AI — Live Payouts" },
      { property: "og:description", content: "See how Deriv payouts change with market, barrier, ticks and stake." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PayoutsPage,
});

function PayoutsPage() {
  const settings = useApp((x) => x.settings);
  const conn = useApp((x) => x.conn.status);
  const payouts = useApp((x) => x.payouts);
  const [market, setMarket] = useState(settings.market);
  const [ticks, setTicks] = useState("1");
  const [stake, setStake] = useState(1);
  const [now, setNow] = useState(0);
  useEffect(() => {
    setPayoutFocus(market);
    return () => setPayoutFocus(null);
  }, [market]);
  useEffect(() => {
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(i);
  }, []);
  const d = Number(ticks);

  return (
    <>
      <Panel title="Live Deriv payouts">
        {conn !== "connected" && (
          <p className="mb-3 text-sm text-destructive">Connect your Deriv account on Home to load live payouts. Saved ones are shown below.</p>
        )}
        <select className="input" value={market} onChange={(e) => setMarket(e.target.value)}>
          {MARKETS.map((m) => (
            <option key={m.symbol} value={m.symbol}>{m.name}</option>
          ))}
        </select>
        <div className="mt-3">
          <span className="field-label">Duration</span>
          <Segmented value={ticks} options={[{ value: "1", label: "1 tick" }, { value: "5", label: "5 ticks" }]} onChange={setTicks} />
        </div>
        <div className="mt-3">
          <span className="field-label">Example stake ($)</span>
          <Segmented
            value={String(stake)}
            options={[1, 5, 10, 50].map((v) => ({ value: String(v), label: `$${v}` }))}
            onChange={(v) => setStake(Number(v))}
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Refreshes on its own about every minute. The AI uses these numbers to choose contracts and check that a recovery trade will cover the loss before buying.
        </p>
      </Panel>

      {CONTRACTS.map((k) => (
        <Panel key={k} title={k}>
          <div className="grid grid-cols-3 gap-2">
            {predsFor(k).map((p) => {
              const q = payouts[payoutKey(market, k, p, d)];
              const fresh = q && now - q.t < 120_000;
              return (
                <div key={String(p)} className={cn("rounded-lg border bg-secondary/50 p-2", fresh && "border-primary/50")}>
                  <div className="text-[11px] text-muted-foreground">{p === undefined ? k : `${k} ${p}`}</div>
                  {q ? (
                    <>
                      <div className="num text-sm font-bold text-success">+{(q.ratio * 100).toFixed(1)}%</div>
                      <div className="num text-[11px] text-muted-foreground">
                        ${stake} → ${(stake * (1 + q.ratio)).toFixed(2)}
                      </div>
                    </>
                  ) : (
                    <div className="num text-sm text-muted-foreground">—</div>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      ))}
    </>
  );
}
