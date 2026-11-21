// Stuiver – actuele koersen voor beleggingen (via Yahoo Finance, alleen lezen)
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept": "application/json" };

// cache binnen een draaiende instantie
const symCache = new Map<string, { sym: string; name: string; at: number }>();
const qCache = new Map<string, { d: any; at: number }>();

// voorkeur voor beurzen in euro's, anders de thuisbeurs
const PREF = [".AS", ".DE", ".F", ".PA", ".BR", ".MI", ".MC", ".VI", ".HE", ".LS", ".IR"];
async function findSymbol(isin: string, hint?: string) {
  const c = symCache.get(isin);
  if (c && Date.now() - c.at < 7 * 864e5) return c;
  const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=10&newsCount=0`, { headers: UA });
  if (!r.ok) throw new Error("zoeken mislukt " + r.status);
  const j = await r.json();
  const qs = (j.quotes || []).filter((q: any) => q.symbol && /EQUITY|ETF|MUTUALFUND/.test(q.quoteType || ""));
  if (!qs.length) return null;
  const land = isin.slice(0, 2);
  let pick = null as any;
  if (land === "US" || land === "CA") pick = qs.find((q: any) => !q.symbol.includes(".")) || null;
  if (!pick) for (const p of PREF) { pick = qs.find((q: any) => q.symbol.endsWith(p)); if (pick) break; }
  if (!pick) pick = qs[0];
  const o = { sym: pick.symbol, name: pick.shortname || pick.longname || hint || pick.symbol, at: Date.now() };
  symCache.set(isin, o);
  return o;
}
async function chart(sym: string) {
  const c = qCache.get(sym);
  if (c && Date.now() - c.at < 60e3) return c.d;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`, { headers: UA });
  if (!r.ok) throw new Error("koers mislukt " + r.status);
  const j = await r.json();
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || m.regularMarketPrice == null) throw new Error("geen koers");
  const d = {
    price: m.regularMarketPrice,
    prev: m.chartPreviousClose ?? m.previousClose ?? null,
    cur: m.currency || "EUR",
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now(),
    exch: m.exchangeName || m.fullExchangeName || "",
    state: m.marketState || "",
  };
  qCache.set(sym, { d, at: Date.now() });
  return d;
}
// koersen in pence/cent omrekenen
function norm(cur: string) {
  if (cur === "GBp" || cur === "GBX") return { cur: "GBP", div: 100 };
  if (cur === "ZAc") return { cur: "ZAR", div: 100 };
  if (cur === "ILA") return { cur: "ILS", div: 100 };
  return { cur: cur.toUpperCase(), div: 1 };
}
async function fx(cur: string) {
  if (cur === "EUR") return 1;
  const d = await chart(`EUR${cur}=X`);
  return d.price; // aantal {cur} per euro
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any = {}; try { body = await req.json(); } catch { /* leeg */ }

  const cronTok = req.headers.get("x-cron");
  if (cronTok) {
    const { data: ok } = await admin.rpc("cron_token_ok", { t: cronTok });
    if (!ok) return json({ error: "geen toegang" }, 403);
  } else {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "niet ingelogd" }, 401);
  }

  const items: { isin: string; name?: string; sym?: string }[] = (body.items || []).slice(0, 60);
  const out: Record<string, any> = {};
  const fxs: Record<string, number> = {};
  await Promise.all(items.map(async (it) => {
    try {
      const isin = String(it.isin || "").toUpperCase();
      let sym = it.sym ? { sym: String(it.sym), name: it.name || it.sym } : null;
      if (!sym && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) sym = await findSymbol(isin, it.name);
      if (!sym) { out[isin || it.sym!] = { error: "niet gevonden" }; return; }
      const d = await chart(sym.sym);
      const n = norm(d.cur);
      if (fxs[n.cur] == null) fxs[n.cur] = await fx(n.cur);
      const rate = fxs[n.cur] * n.div;
      out[isin || sym.sym] = {
        sym: sym.sym, name: sym.name, cur: n.cur, exch: d.exch, state: d.state, time: d.time,
        price: d.price / n.div, prev: d.prev != null ? d.prev / n.div : null,
        eur: d.price / rate, eurPrev: d.prev != null ? d.prev / rate : null,
      };
    } catch (e) {
      out[String(it.isin || it.sym)] = { error: String((e as Error).message || e) };
    }
  }));
  return json({ ok: true, at: Date.now(), quotes: out, fx: fxs });
});
