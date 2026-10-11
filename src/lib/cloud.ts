// Syncs settings and trade history to the app's own Lovable Cloud backend.
import { supabase } from "@/integrations/supabase/client";
import { getState, setState, subscribeStore, type Trade } from "./store";

let userId: string | null = null;
let stop: (() => void) | null = null;

export async function startCloudSync(uid: string) {
  if (userId === uid) return;
  stopCloudSync();
  userId = uid;

  const { data: row } = await supabase.from("user_settings").select("settings").eq("user_id", uid).maybeSingle();
  if (row?.settings && Object.keys(row.settings as object).length) {
    const remote = row.settings as any;
    setState((s) => ({
      settings: { ...s.settings, ...remote, contracts: { ...s.settings.contracts, ...remote.contracts } },
    }));
  }
  const { data: rows } = await supabase
    .from("trades").select("*").eq("user_id", uid).order("time", { ascending: false }).limit(2000);
  if (rows?.length) {
    const remote: Trade[] = rows.map((r) => ({
      id: r.id, time: new Date(r.time).getTime(), type: r.type as Trade["type"],
      pred: r.pred ?? undefined, symbol: r.symbol, stake: Number(r.stake),
      profit: Number(r.profit), recovery: r.recovery,
    }));
    const ids = new Set(remote.map((t) => t.id));
    setState((s) => ({
      trades: [...s.trades.filter((t) => !ids.has(t.id)), ...remote].sort((a, b) => b.time - a.time).slice(0, 2000),
    }));
  }

  const synced = new Set(getState().trades.map((t) => t.id));
  // push local-only trades
  const localOnly = getState().trades.filter((t) => !rows?.some((r) => r.id === t.id));
  if (localOnly.length) await pushTrades(localOnly);

  let lastSettings = JSON.stringify(getState().settings);
  let timer: ReturnType<typeof setTimeout> | null = null;
  stop = subscribeStore(() => {
    const s = getState();
    const fresh = s.trades.filter((t) => !synced.has(t.id));
    if (fresh.length) {
      fresh.forEach((t) => synced.add(t.id));
      pushTrades(fresh);
    }
    const cur = JSON.stringify(s.settings);
    if (cur !== lastSettings) {
      lastSettings = cur;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!userId) return;
        supabase.from("user_settings").upsert({
          user_id: userId, settings: JSON.parse(cur), updated_at: new Date().toISOString(),
        }).then(() => {});
      }, 1000);
    }
  });
}

async function pushTrades(list: Trade[]) {
  if (!userId) return;
  await supabase.from("trades").upsert(
    list.map((t) => ({
      id: t.id, user_id: userId!, time: new Date(t.time).toISOString(), type: t.type,
      pred: t.pred ?? null, symbol: t.symbol, stake: t.stake, profit: t.profit, recovery: t.recovery,
    })),
    { onConflict: "user_id,id", ignoreDuplicates: true },
  );
}

export function stopCloudSync() {
  stop?.();
  stop = null;
  userId = null;
}
