import { useEffect, useState, type ReactNode } from "react";
import { checkLicense, enterLicense } from "@/lib/license.functions";

type Phase = "checking" | "locked" | "ok";

export function LicenseGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const run = () =>
      checkLicense()
        .then((r) => alive && setPhase((p) => (r.ok ? "ok" : p === "ok" ? (location.reload(), "locked") : "locked")))
        .catch(() => alive && setPhase((p) => (p === "ok" ? "ok" : "locked")));
    run();
    const i = setInterval(run, 5 * 60 * 1000); // re-check so a changed code logs devices out
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);

  if (phase === "ok") return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="panel w-full max-w-sm text-center">
        <div className="font-display text-2xl font-bold tracking-wider glow-text">MEGATRON AI</div>
        {phase === "checking" ? (
          <p className="mt-4 animate-pulse text-sm text-muted-foreground">Checking the license code…</p>
        ) : (
          <form
            className="mt-4 space-y-3 text-left"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr("");
              try {
                const r = await enterLicense({ data: { code } });
                if (r.ok) setPhase("ok");
                else setErr("Incorrect license code");
              } catch {
                setErr("Could not check the code. Try again.");
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="block">
              <span className="field-label">Enter license code</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
            </label>
            {err && <p className="text-sm text-destructive">{err}</p>}
            <button className="btn-primary w-full" disabled={busy || !code}>
              {busy ? "Checking…" : "Unlock"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
