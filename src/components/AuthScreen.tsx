import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";

export function AuthScreen() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const { data, error } =
      mode === "in"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
    setBusy(false);
    if (error) return setMsg(error.message);
    if (mode === "up" && !data.session) setMsg("Check your email to confirm your account.");
  }

  async function google() {
    const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin });
    if (r.error) setMsg(r.error.message ?? "Google sign-in failed");
  }

  const input = "w-full rounded-md border bg-background px-3 py-2 text-sm";
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6">
        <h1 className="text-center font-display text-2xl font-bold tracking-wider glow-text">MEGATRON AI</h1>
        <p className="text-center text-sm text-muted-foreground">
          {mode === "in" ? "Sign in to your account" : "Create your account"}
        </p>
        <button type="button" onClick={google} className="w-full rounded-md border py-2 text-sm font-semibold">
          Continue with Google
        </button>
        <form onSubmit={submit} className="space-y-3">
          <input className={input} type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className={input} type="password" required minLength={6} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button disabled={busy} className="btn-primary w-full">{mode === "in" ? "Sign in" : "Sign up"}</button>
        </form>
        {msg && <p className="text-center text-sm text-muted-foreground">{msg}</p>}
        <button type="button" onClick={() => setMode(mode === "in" ? "up" : "in")} className="w-full text-xs text-muted-foreground underline">
          {mode === "in" ? "No account? Sign up" : "Have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
