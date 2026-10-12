import { createFileRoute } from "@tanstack/react-router";
import { Panel } from "@/components/kit";
import { resetLearning, roi, type Stat, winRate } from "@/lib/learning";
import { marketName, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/learning")({
  head: () => ({
    meta: [
      { title: "Machine Learning · Megatron AI" },
      { name: "description", content: "Everything Megatron AI has learnt from past sessions to cut losses and grow profits." },
      { property: "og:title", content: "Megatron AI — Machine Learning" },
      { property: "og:description", content: "Lessons learnt from past Deriv sessions: what to avoid and what to favour." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LearningPage,
});

function Rows({ data, name }: { data: Record<string, Stat>; name: (k: string) => string }) {
  const rows = Object.entries(data).sort((a, b) => b[1].n - a[1].n).slice(0, 30);
  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing learnt yet.</p>;
  return (
    <div className="space-y-1">
      {rows.map(([k, s]) => (
        <div key={k} className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-xs">
          <span className="truncate font-semibold">{name(k)}</span>
          <span className="num shrink-0 text-muted-foreground">
            {s.n} trades · win {(winRate(s) * 100).toFixed(0)}% ·{" "}
            <span className={s.pnl >= 0 ? "text-success" : "text-destructive"}>
              {s.pnl >= 0 ? "+" : ""}
              {s.pnl.toFixed(2)} ({(roi(s) * 100).toFixed(0)}%)
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function LearningPage() {
  const L = useApp((s) => s.learn);
  const total = Object.values(L?.markets ?? {}).reduce((a, s) => a + s.n, 0);
  return (
    <>
      <Panel title="Machine Learning">
        <p className="text-sm text-muted-foreground">
          The AI remembers every trade across sessions. Combos that lose money are avoided, profitable ones are
          preferred, and recovery picks use what has worked after a loss.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center text-sm">
          <div className="rounded border p-2"><div className="num text-lg font-bold">{L?.sessions ?? 0}</div>sessions</div>
          <div className="rounded border p-2"><div className="num text-lg font-bold">{total}</div>trades learnt</div>
        </div>
      </Panel>
      <Panel title="Lessons learnt">
        {!L?.insights.length ? (
          <p className="text-sm text-muted-foreground">Lessons appear here as trades settle.</p>
        ) : (
          <ul className="max-h-96 space-y-1.5 overflow-auto">
            {L.insights.map((i, n) => (
              <li key={n} className={cn("rounded border-l-2 px-2 py-1 text-xs", i.kind === "avoid" ? "border-destructive" : i.kind === "favor" ? "border-success" : "border-primary")}>
                <span className="num text-muted-foreground">{new Date(i.t).toLocaleString()}</span> — {i.msg}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Contract + market"><Rows data={L?.combos ?? {}} name={(k) => { const [s, t, p] = k.split("|"); return `${t}${p !== "-" ? " " + p : ""} · ${marketName(s!)}`; }} /></Panel>
      <Panel title="Markets"><Rows data={L?.markets ?? {}} name={marketName} /></Panel>
      <Panel title="As recovery trade"><Rows data={L?.afterLoss ?? {}} name={(k) => k} /></Panel>
      <Panel title="Hour of day (EAT)"><Rows data={L?.hours ?? {}} name={(k) => `${k.padStart(2, "0")}:00`} /></Panel>
      <button className="btn-primary w-full" onClick={() => confirm("Forget everything the AI has learnt?") && resetLearning()}>
        Reset learning
      </button>
    </>
  );
}
