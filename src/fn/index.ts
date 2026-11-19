// Stuiver – bankkoppeling via Enable Banking (alleen lezen, PSD2)
import { createClient } from "npm:@supabase/supabase-js@2";

const EB = "https://api.enablebanking.com";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const FN_URL = SB_URL + "/functions/v1/bank";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const text = (t: string, s = 200) => new Response(t, { status: s, headers: { "Content-Type": "text/plain; charset=utf-8" } });

// ---------- JWT voor Enable Banking ----------
const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function derLen(n: number) { if (n < 128) return [n]; const o: number[] = []; while (n > 0) { o.unshift(n & 255); n >>= 8; } return [0x80 | o.length, ...o]; }
function pkcs1to8(p1: Uint8Array) {
  const alg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const oct = [0x04, ...derLen(p1.length), ...p1];
  const body = [0x02, 0x01, 0x00, ...alg, ...oct];
  return new Uint8Array([0x30, ...derLen(body.length), ...body]);
}
let keyP: Promise<CryptoKey> | null = null;
function signingKey() {
  if (keyP) return keyP;
  const pem = (Deno.env.get("EB_PRIVATE_KEY") || "").replace(/\\n/g, "\n");
  if (!pem.includes("PRIVATE KEY")) throw new Error("EB_PRIVATE_KEY ontbreekt");
  const isP1 = pem.includes("RSA PRIVATE KEY");
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  let der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (isP1) der = pkcs1to8(der);
  keyP = crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return keyP;
}
async function ebJwt() {
  const appId = Deno.env.get("EB_APP_ID");
  if (!appId) throw new Error("EB_APP_ID ontbreekt");
  const iat = Math.floor(Date.now() / 1000);
  const h = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId.trim() })));
  const p = b64url(enc.encode(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + 3600 })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(), enc.encode(h + "." + p));
  return h + "." + p + "." + b64url(sig);
}
async function eb(path: string, init: RequestInit = {}) {
  const r = await fetch(EB + path, { ...init, headers: { Authorization: "Bearer " + (await ebJwt()), "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await r.text();
  let d: any = null; try { d = t ? JSON.parse(t) : null; } catch { d = { raw: t }; }
  if (!r.ok) { const e: any = new Error((d && (d.message || d.error)) || ("HTTP " + r.status)); e.status = r.status; e.body = d; throw e; }
  return d;
}

// ---------- ophalen ----------
const iso = (d: Date) => d.toISOString().slice(0, 10);
async function syncHousehold(hid: string, fromOverride?: string) {
  const { data: links } = await admin.from("bank_links").select("*").eq("household_id", hid).eq("status", "actief");
  let added = 0; const errors: string[] = [];
  for (const l of links || []) {
    if (l.valid_until && new Date(l.valid_until) < new Date()) { await admin.from("bank_links").update({ status: "verlopen" }).eq("session_id", l.session_id); continue; }
    const { data: accts } = await admin.from("bank_accounts").select("*").eq("session_id", l.session_id);
    for (const a of accts || []) {
      try {
        const from = fromOverride ? fromOverride : a.last_sync ? iso(new Date(new Date(a.last_sync).getTime() - 10 * 864e5)) : (l.date_from || iso(new Date(Date.now() - 90 * 864e5)));
        let ck: string | null = null; const rows: any[] = []; let guard = 0;
        do {
          const q = new URLSearchParams({ date_from: from }); if (ck) q.set("continuation_key", ck);
          const d = await eb(`/accounts/${encodeURIComponent(a.uid)}/transactions?` + q.toString());
          for (const t of d.transactions || []) {
            if (t.status && t.status !== "BOOK") continue;
            const sign = t.credit_debit_indicator === "DBIT" ? -1 : 1;
            const amt = sign * Math.abs(Number(t.transaction_amount?.amount || 0));
            const date = t.booking_date || t.value_date || t.transaction_date;
            if (!date || !amt) continue;
            const party = sign < 0 ? t.creditor?.name : t.debtor?.name;
            const note = (t.remittance_information || []).join(" ").slice(0, 300);
            const descr = (party || note || "Banktransactie").slice(0, 120);
            const entry = t.entry_reference || t.transaction_id || `${date}|${amt}|${descr}|${rows.length}`;
            rows.push({ household_id: hid, account_uid: a.uid, entry_id: String(entry).slice(0, 200), date, amount: amt, descr, note });
          }
          ck = d.continuation_key || null; guard++;
        } while (ck && guard < 40);
        if (rows.length) {
          const { data: ins, error } = await admin.from("bank_tx").upsert(rows, { onConflict: "household_id,account_uid,entry_id", ignoreDuplicates: true }).select("id");
          if (error) throw error; added += ins?.length || 0;
        }
        let bal: any = null, bdate: string | null = null;
        try {
          const b = await eb(`/accounts/${encodeURIComponent(a.uid)}/balances`);
          const pref = ["CLBD", "ITBD", "XPCD", "ITAV", "CLAV", "OPBD"];
          const list = b.balances || [];
          const pick = pref.map((p) => list.find((x: any) => x.balance_type === p)).find(Boolean) || list[0];
          if (pick) { bal = Number(pick.balance_amount?.amount); if (pick.credit_debit_indicator === "DBIT") bal = -Math.abs(bal); bdate = pick.reference_date || iso(new Date()); }
        } catch (_) { /* saldo is optioneel */ }
        await admin.from("bank_accounts").update({ last_sync: new Date().toISOString(), last_error: null, ...(bal != null && !isNaN(bal) ? { balance: bal, balance_date: bdate } : {}) }).eq("uid", a.uid);
      } catch (e: any) {
        const msg = String(e.message || e).slice(0, 300); errors.push(msg);
        await admin.from("bank_accounts").update({ last_error: msg }).eq("uid", a.uid);
        if (e.status === 401 || e.status === 403 || /expired|revoked|not authori/i.test(msg)) await admin.from("bank_links").update({ status: "verlopen" }).eq("session_id", l.session_id);
      }
    }
  }
  return { added, errors };
}
async function status(hid: string) {
  const { data: links } = await admin.from("bank_links").select("aspsp,valid_until,status,created_at,session_id").eq("household_id", hid);
  const { data: accts } = await admin.from("bank_accounts").select("uid,session_id,iban,name,balance,balance_date,last_sync,last_error").eq("household_id", hid);
  return { configured: !!(Deno.env.get("EB_APP_ID") && Deno.env.get("EB_PRIVATE_KEY")),
    links: (links || []).map((l) => ({ id: l.session_id.slice(0, 8), bank: l.aspsp?.name, valid_until: l.valid_until, status: l.status, created_at: l.created_at,
      accounts: (accts || []).filter((a) => a.session_id === l.session_id).map((a) => ({ uid: a.uid, iban: a.iban ? a.iban.replace(/^(.{4}).*(.{4})$/, "$1 •••• $2") : null, name: a.name, balance: a.balance, balance_date: a.balance_date, last_sync: a.last_sync, last_error: a.last_error })) })) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  // ---------- terugkomst van de bank ----------
  if (req.method === "GET") {
    const state = url.searchParams.get("state"), code = url.searchParams.get("code"), err = url.searchParams.get("error");
    if (!state) return text("Stuiver bankkoppeling.");
    const { data: a } = await admin.from("bank_auth").select("*").eq("state", state).maybeSingle();
    if (!a) return text("Deze koppeling is verlopen of al gebruikt. Start het koppelen opnieuw in Stuiver.", 400);
    await admin.from("bank_auth").delete().eq("state", state);
    if (err || !code) return text("Het koppelen is niet gelukt of geannuleerd. Je kunt dit venster sluiten en het opnieuw proberen in Stuiver.", 400);
    if (Date.now() - new Date(a.created_at).getTime() > 30 * 60e3) return text("Deze koppeling is verlopen. Start het koppelen opnieuw in Stuiver.", 400);
    try {
      const s = await eb("/sessions", { method: "POST", body: JSON.stringify({ code }) });
      await admin.from("bank_links").insert({ session_id: s.session_id, household_id: a.household_id, aspsp: a.aspsp, valid_until: s.access?.valid_until || null, created_by: a.user_id, date_from: a.date_from });
      const accts = (s.accounts || []).map((x: any) => ({ uid: x.uid, household_id: a.household_id, session_id: s.session_id, iban: x.account_id?.iban || null, name: x.name || x.product || null, last_sync: null, last_error: null }));
      if (accts.length) await admin.from("bank_accounts").upsert(accts, { onConflict: "uid" });
      const { data: old } = await admin.from("bank_links").select("session_id").eq("household_id", a.household_id).neq("session_id", s.session_id);
      for (const o of old || []) { try { await eb("/sessions/" + o.session_id, { method: "DELETE" }); } catch (_) { /* al verlopen */ } await admin.from("bank_links").delete().eq("session_id", o.session_id); }
      const r = await syncHousehold(a.household_id, a.date_from || undefined);
      return text(`Gelukt! ${a.aspsp?.name || "Je bank"} is gekoppeld aan Stuiver.\n\n${accts.length} rekening(en) gekoppeld en ${r.added} transacties opgehaald.\n\nJe kunt dit venster sluiten en teruggaan naar Stuiver.`);
    } catch (e: any) {
      return text("Het koppelen is niet gelukt: " + String(e.message || e).slice(0, 200) + "\n\nProbeer het opnieuw in Stuiver.", 500);
    }
  }

  let body: any = {}; try { body = await req.json(); } catch { /* leeg */ }

  // ---------- geplande ophaalactie ----------
  const cronTok = req.headers.get("x-cron");
  if (cronTok) {
    const { data: ok } = await admin.rpc("cron_token_ok", { t: cronTok });
    if (!ok) return json({ error: "geen toegang" }, 403);
    const { data: hs } = await admin.from("bank_links").select("household_id").eq("status", "actief");
    const ids = [...new Set((hs || []).map((h) => h.household_id))]; const out: any[] = [];
    for (const h of ids) out.push(await syncHousehold(h));
    return json({ ok: true, households: ids.length, results: out });
  }

  // ---------- acties vanuit de app (ingelogd lid) ----------
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(token);
  if (!u?.user) return json({ error: "niet ingelogd" }, 401);
  const hid = body.hid;
  const { data: mem } = await admin.from("members").select("user_id").eq("household_id", hid).eq("user_id", u.user.id).maybeSingle();
  if (!mem) return json({ error: "geen lid van dit huishouden" }, 403);

  try {
    switch (body.action) {
      case "status": return json(await status(hid));
      case "banks": {
        const d = await eb("/aspsps?country=NL&psu_type=personal");
        return json({ banks: (d.aspsps || []).map((x: any) => ({ name: x.name, country: x.country, max: x.maximum_consent_validity || null, logo: x.logo || null })) });
      }
      case "start": {
        const bank = String(body.bank || ""); if (!bank) return json({ error: "kies een bank" }, 400);
        const maxS = Number(body.max) || 90 * 86400;
        const validUntil = new Date(Date.now() + Math.min(maxS, 180 * 86400) * 1000 - 3600e3).toISOString();
        const aspsp = { name: bank, country: "NL" };
        const { data: st, error } = await admin.from("bank_auth").insert({ household_id: hid, user_id: u.user.id, aspsp, date_from: body.date_from || null }).select("state").single();
        if (error) throw error;
        const d = await eb("/auth", { method: "POST", body: JSON.stringify({ access: { valid_until: validUntil }, aspsp, state: st.state, redirect_url: FN_URL, psu_type: "personal" }) });
        return json({ url: d.url });
      }
      case "sync": {
        if (!body.force) {
          const { data: ac } = await admin.from("bank_accounts").select("last_sync").eq("household_id", hid);
          const last = Math.max(0, ...(ac || []).map((a) => (a.last_sync ? new Date(a.last_sync).getTime() : 0)));
          if (Date.now() - last < 6 * 3600e3) return json({ skipped: true });
        }
        const df = typeof body.date_from === "string" && /^\d{4}-\d\d-\d\d$/.test(body.date_from) ? body.date_from : undefined;
        return json(await syncHousehold(hid, df));
      }
      case "disconnect": {
        const { data: links } = await admin.from("bank_links").select("session_id").eq("household_id", hid);
        for (const l of links || []) { if (!body.id || l.session_id.startsWith(body.id)) { try { await eb("/sessions/" + l.session_id, { method: "DELETE" }); } catch (_) { /* al verlopen */ } await admin.from("bank_links").delete().eq("session_id", l.session_id); } }
        return json({ ok: true });
      }
      default: return json({ error: "onbekende actie" }, 400);
    }
  } catch (e: any) {
    return json({ error: String(e.message || e).slice(0, 300) }, e.status && e.status < 500 ? 400 : 500);
  }
});
