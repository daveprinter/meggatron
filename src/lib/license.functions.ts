import { createServerFn } from "@tanstack/react-start";
import { useSession } from "@tanstack/react-start/server";

type LicenseSession = { key?: string };

function cfg() {
  return {
    password: process.env["SESSION_SECRET"]!,
    name: "megatron-license",
    maxAge: 60 * 60 * 24 * 365,
    cookie: { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" },
  };
}

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Fingerprint of the current code: changing the code logs every device out. */
async function currentKey() {
  const code = process.env["LICENSE_CODE"];
  if (!code) throw new Error("License code is not configured");
  return sha(`license:${code}`);
}

export const checkLicense = createServerFn({ method: "GET" }).handler(async () => {
  const session = await useSession<LicenseSession>(cfg());
  const ok = !!session.data.key && same(session.data.key, await currentKey());
  if (!ok && session.data.key) await session.clear();
  return { ok };
});

export const enterLicense = createServerFn({ method: "POST" })
  .inputValidator((d: { code: string }) => ({ code: String(d?.code ?? "").slice(0, 200) }))
  .handler(async ({ data }) => {
    const expected = await currentKey();
    if (!same(await sha(`license:${data.code.trim()}`), expected)) return { ok: false as const };
    const session = await useSession<LicenseSession>(cfg());
    await session.update({ key: expected });
    return { ok: true as const };
  });

export const lockLicense = createServerFn({ method: "POST" }).handler(async () => {
  const session = await useSession<LicenseSession>(cfg());
  await session.clear();
  return { ok: true as const };
});
