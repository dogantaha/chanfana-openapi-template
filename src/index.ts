/**
 * Investment Tracker — Cloudflare Worker giriş dosyası (wrangler `main` → bu modül).
 *
 * `export default` iki yüzey sunar:
 *   - `fetch`     → HTTP yönlendirme (`route`), JSON API.
 *   - `scheduled` → Cron ile toplu senkron (`syncAll`); tetikleyici wrangler’da `triggers.crons` ile tanımlanır.
 *
 * Veri katmanı: D1 bağlamı `env.DB`. Ham kaynaklar `PROVIDERS` içinde toplanır, normalize fiyatlar
 * `asset_prices` tablosuna yazılır (şema: `ensureTables`).
 *
 * Varlık türleri (asset_type):
 *   currency  — Döviz (ör. TCMB `today.xml`); gold, silver; stock_tr, stock_us; crypto; fund.
 *
 * HTTP özeti (ayrıntılı liste `ENDPOINT_DOCS`):
 *   GET /  ·  /sync/all | /sync/{kaynak|tip}  ·  /assets/{tip}/…  ·  /sources
 */

// ─── Router ─────────────────────────────────────────────────────────────────

type Env = {
  DB: any;
};

type ProviderRecord = {
  assetType: string;
  source: string;
  code: string;
  name?: string;
  price: number | null;
  priceDate?: string;
  extra?: unknown;
};

type Provider = {
  meta: () => { id: string; name: string; assetTypes: string[]; url: string };
  fetch: (env: Env) => Promise<ProviderRecord[]>;
};

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
	  try {
		return await route(request, env);
	  } catch (err) {
		console.error("Unhandled error:", err);
		return jsonError("Internal server error", 500);
	  }
	},
  
	// Cron tetikleyici — wrangler.jsonc içinde `triggers.crons` ile tanımlı
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
	  ctx.waitUntil(syncAll(env));
	}
  };
  
  async function route(request: Request, env: Env) {
	const url  = new URL(request.url);
	const path = url.pathname.replace(/\/$/, "") || "/";
	const segments = path.split("/").filter(Boolean); // ["assets","currency","USD"]
  
	// GET /
	if (path === "/") {
	  return json({
		service: "Investment Tracker API",
		version: "2.0.0",
		endpoints: ENDPOINT_DOCS
	  });
	}
  
	// GET /sync/all  veya  /sync/{type}
	if (segments[0] === "sync") {
	  const type = segments[1];
	  if (!type || type === "all") return json(await syncAll(env));
	  return json(await syncOne(env, type));
	}
  
	// GET /sources
	if (path === "/sources") {
	  return json({ sources: Object.keys(PROVIDERS).map(k => PROVIDERS[k].meta()) });
	}
  
	// GET /assets/{type}[/{code}[/history]]
	if (segments[0] === "assets") {
	  const [, type, code, sub] = segments;
  
	  if (!type) return jsonError("Asset type required. See / for available types.", 400);
  
	  await ensureTables(env);
  
	  if (!code) return json(await getAssets(env, type, url));
	  if (!sub)  return json(await getAsset(env, type, code.toUpperCase()));
	  if (sub === "history") return json(await getHistory(env, type, code.toUpperCase(), url));
	}
  
	return jsonError("Not found", 404);
  }
  
  // ─── Veri Kaynakları (Provider Pattern) ─────────────────────────────────────
  //
  // Her provider şu interface'i karşılamalı:
  //   meta()    → { id, name, assetTypes[], url }
  //   fetch(env) → [{ assetType, code, name, price, priceDate, extra:{} }]
  //
  // Yeni bir kaynak eklemek için sadece buraya yeni bir obje ekleyin.
  
  const PROVIDERS: Record<string, Provider> = {

	// ── Altınkaynak: Döviz Kurları ───────────────────────────────────────────
	//
	// Herkese açık statik JSON servisi: https://static.altinkaynak.com/public/Currency
	// Alanlar: Kod, Aciklama, Alis, Satis, GuncellenmeZamani
	altinkaynak_currency: {
	  meta: () => ({
		id: "altinkaynak_currency",
		name: "Altınkaynak Döviz Kurları",
		assetTypes: ["currency"],
		url: "https://static.altinkaynak.com/public/Currency"
	  }),

	  fetch: async (env: Env) => {
		const res = await fetchUrl("https://static.altinkaynak.com/public/Currency");
		const items = (await res.json()) as any[];

		return items.map((item: any) => {
		  const buy  = parseTurkishNum(item.Alis);
		  const sell = parseTurkishNum(item.Satis);
		  const priceDate = item.GuncellenmeZamani
			? normalizeAltinkaynakDateTime(item.GuncellenmeZamani)
			: todayISO();

		  return {
			assetType: "currency",
			source:    "altinkaynak_currency",
			code:      String(item.Kod ?? "").toUpperCase(),
			name:      item.Aciklama,
			priceDate,
			price: midpoint(buy, sell),
			extra: {
			  buy,
			  sell,
			  updated_at: item.GuncellenmeZamani
			}
		  };
		}).filter(r => r.code && r.price !== null);
	  }
	},
  
	// ── Altınkaynak: Altın Fiyatları ─────────────────────────────────────────
	//
	// Herkese açık statik JSON servisi: https://static.altinkaynak.com/public/Gold
	// Alanlar: Kod, Aciklama, Alis, Satis, GuncellenmeZamani
	altinkaynak_gold: {
	  meta: () => ({
		id: "altinkaynak_gold",
		name: "Altınkaynak Altın Fiyatları",
		assetTypes: ["gold"],
		url: "https://static.altinkaynak.com/public/Gold"
	  }),

	  fetch: async (env: Env) => {
		const res = await fetchUrl("https://static.altinkaynak.com/public/Gold");
		const items = (await res.json()) as any[];
		const priceDate = todayISO();

		return items.map((item: any) => {
		  const buy  = parseTurkishNum(item.Alis);
		  const sell = parseTurkishNum(item.Satis);
		  return {
			assetType: "gold",
			source:    "altinkaynak_gold",
			code:      item.Kod,
			name:      item.Aciklama,
			priceDate,
			price: midpoint(buy, sell),
			extra: {
			  buy,
			  sell,
			  updated_at: item.GuncellenmeZamani
			}
		  };
		}).filter(r => r.price !== null);
	  }
	},
  
	// ── Yer Tutucu: Diğer Banka Döviz Kurları ────────────────────────────────
	// Yapı hazır; API URL ve parse mantığı bankaya göre doldurulacak.
	//
	// bank_isbank: {
	//   meta: () => ({ id: "bank_isbank", name: "İş Bankası", assetTypes: ["currency"], url: "..." }),
	//   fetch: async (env) => { /* ... */ }
	// },
  
	// ── Yer Tutucu: BIST ─────────────────────────────────────────────────────
	// bist: {
	//   meta: () => ({ id: "bist", name: "Borsa İstanbul", assetTypes: ["stock_tr"], url: "..." }),
	//   fetch: async (env) => { /* ... */ }
	// },
  
	// ── Yer Tutucu: Amerikan Hisseleri ───────────────────────────────────────
	// us_stocks: {
	//   meta: () => ({ id: "us_stocks", name: "Yahoo Finance / Polygon.io", assetTypes: ["stock_us"], url: "..." }),
	//   fetch: async (env) => { /* ... */ }
	// },
  
	// ── Yer Tutucu: Kripto ───────────────────────────────────────────────────
	// crypto_coingecko: {
	//   meta: () => ({ id: "crypto_coingecko", name: "CoinGecko", assetTypes: ["crypto"], url: "..." }),
	//   fetch: async (env) => { /* ... */ }
	// },
  
	// ── Yer Tutucu: Fon ──────────────────────────────────────────────────────
	// tefas: {
	//   meta: () => ({ id: "tefas", name: "TEFAS", assetTypes: ["fund"], url: "..." }),
	//   fetch: async (env) => { /* ... */ }
	// }
  };
  
  // ─── Sync İşlemleri ──────────────────────────────────────────────────────────
  
  async function syncAll(env: Env) {
	await ensureTables(env);
	const results: Record<string, any> = {};
  
	for (const [id, provider] of Object.entries(PROVIDERS)) {
	  try {
		results[id] = await runProvider(env, provider);
	  } catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		results[id] = { success: false, error: msg };
	  }
	}
  
	return { success: true, results };
  }
  
  async function syncOne(env: Env, type: string) {
	await ensureTables(env);
  
	// type → "altinkaynak_currency" gibi bir source ID olabilir,
	//        ya da "currency" gibi bir asset type olabilir
	const byId   = PROVIDERS[type];
	const byType = Object.values(PROVIDERS).filter(p => p.meta().assetTypes.includes(type));
  
	if (byId) {
	  return { success: true, results: { [type]: await runProvider(env, byId) } };
	}
  
	if (byType.length) {
	  const results: Record<string, any> = {};
	  for (const p of byType) {
		results[p.meta().id] = await runProvider(env, p);
	  }
	  return { success: true, results };
	}
  
	return jsonError(`Unknown type or source: ${type}`, 400);
  }
  
  async function runProvider(env: Env, provider: Provider) {
	const records = await provider.fetch(env);
	let saved = 0, skipped = 0;
	const priceTs = nowIsoHour();
	const priceDate = priceTs.slice(0, 10);
  
	for (const r of records) {
	  if (!r.price && r.price !== 0) { skipped++; continue; }
  
	  await env.DB.prepare(`
		INSERT INTO asset_prices_hourly (asset_type, source, code, name, price, price_date, price_ts, extra)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(asset_type, source, code, price_ts)
		DO UPDATE SET
		  name       = excluded.name,
		  price      = excluded.price,
		  price_date = excluded.price_date,
		  extra      = excluded.extra,
		  updated_at = CURRENT_TIMESTAMP
	  `).bind(
		r.assetType, r.source, r.code, r.name,
		r.price, priceDate, priceTs, JSON.stringify(r.extra ?? {})
	  ).run();
  
	  saved++;
	}
  
	return { success: true, saved, skipped, total: records.length };
  }
  
  // ─── Sorgular ────────────────────────────────────────────────────────────────
  
  async function getAssets(env: Env, type: string, url: URL) {
	const source = url.searchParams.get("source"); // opsiyonel filtre

	// DB'deki en güncel (saatlik) kaydı döndürür.
	// Not: Otomatik güncelleme cron ile yapılır; okuma path'i external kaynağa gitmez.
	let query = `
	  SELECT a.*, prev.price AS prev_price, prev.extra AS prev_extra
	  FROM asset_prices_hourly a
	  INNER JOIN (
		SELECT code, source, MAX(price_ts) AS max_ts
		FROM asset_prices_hourly
		WHERE asset_type = ?
		GROUP BY code, source
	  ) latest ON a.code = latest.code
			 AND a.source = latest.source
			 AND a.price_ts = latest.max_ts
	  LEFT JOIN asset_prices_hourly prev
		ON  prev.asset_type = a.asset_type
		AND prev.code       = a.code
		AND prev.source     = a.source
		AND prev.price_ts = (
		  SELECT MAX(price_ts)
		  FROM   asset_prices_hourly
		  WHERE  asset_type = a.asset_type
		  AND    code       = a.code
		  AND    source     = a.source
		  AND    price_ts   < latest.max_ts
		)
	  WHERE a.asset_type = ?
	`;
	const params = [type, type];

	if (source) {
	  query += " AND a.source = ?";
	  params.push(source);
	}

	query += " ORDER BY a.code ASC";

	const result = await env.DB.prepare(query).bind(...params).all();
	return {
	  success: true,
	  assetType: type,
	  count: result.results.length,
	  assets: result.results.map((row: any) => {
		const { prev_price, prev_extra, ...rest } = row;
		const asset = parseExtra(rest);

		// Değişim %: altın için alış fiyatına göre hesaplanır (extra.buy).
		// Diğer varlıklarda da buy yoksa null döner.
		let prevBuy = null;
		try { prevBuy = JSON.parse(prev_extra ?? "{}")?.buy ?? null; } catch { prevBuy = null; }
		const currBuy = asset?.extra?.buy ?? null;

		const changePct = (prevBuy && currBuy)
		  ? Math.round((currBuy - prevBuy) / prevBuy * 10000) / 100
		  : null;
		return { ...asset, change_pct: changePct };
	  })
	};
  }
  
  async function getAsset(env: Env, type: string, code: string) {
	const rows = await env.DB.prepare(`
	  SELECT *
	  FROM asset_prices_hourly
	  WHERE asset_type = ? AND code = ?
	  ORDER BY price_ts DESC, updated_at DESC
	  LIMIT 10
	`).bind(type, code).all();
  
	if (!rows.results.length) {
	  return jsonError(`${type}/${code} not found`, 404);
	}
  
	// Her kaynak için en güncel kaydı döner
	const bySource: Record<string, any> = {};
	for (const row of rows.results as any[]) {
	  if (!bySource[(row as any).source]) bySource[(row as any).source] = parseExtra(row);
	}
  
	return {
	  success: true,
	  assetType: type,
	  code,
	  quotes: Object.values(bySource)
	};
  }
  
  async function getHistory(env: Env, type: string, code: string, url: URL) {
	const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "300"), 5000);
	const source = url.searchParams.get("source");
	const range = (url.searchParams.get("range") ?? "").toLowerCase(); // "1d" | "1w" | "30d" | "1y"
	const sinceTs = range ? isoSince(range) : null;

	let query = `
	  SELECT * FROM asset_prices_hourly
	  WHERE asset_type = ? AND code = ?
	`;
	const params: any[] = [type, code];
  
	if (source) { query += " AND source = ?"; params.push(source); }
	if (sinceTs) { query += " AND price_ts >= ?"; params.push(sinceTs); }
  
	query += ` ORDER BY price_ts DESC LIMIT ?`;
	params.push(limit);
  
	const result = await env.DB.prepare(query).bind(...params).all();
  
	return {
	  success: true,
	  assetType: type,
	  code,
	  count: result.results.length,
	  history: result.results.map(parseExtra)
	};
  }
  
  async function refreshBeforeRead(env: Env, assetType: string, sourceId: string | null) {
	// Bu fonksiyon, /assets isteklerinde DB'yi güncel tutmak için kullanılır.
	// Hata durumunda okuma yine de yapılır (mevcut DB verisi döner).
	try {
	  await ensureTables(env);

	  if (sourceId) {
		const provider = PROVIDERS[sourceId];
		if (provider && provider.meta().assetTypes.includes(assetType)) {
		  await runProvider(env, provider);
		}
		return;
	  }

	  const providers = Object.values(PROVIDERS)
		.filter(p => p.meta().assetTypes.includes(assetType));
	  for (const p of providers) {
		await runProvider(env, p);
	  }
	} catch (err) {
	  console.warn("Refresh before read failed:", err);
	}
  }

  // ─── Veritabanı ──────────────────────────────────────────────────────────────
  
  async function ensureTables(env: Env) {
	// Saatlik kayıt tutmak için yeni tablo (mevcut `asset_prices` gün bazlı kalabilir).
	await env.DB.prepare(`
	  CREATE TABLE IF NOT EXISTS asset_prices_hourly (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		asset_type TEXT NOT NULL,
		source     TEXT NOT NULL,
		code       TEXT NOT NULL,
		name       TEXT,
		price      REAL,
		price_date TEXT NOT NULL,  -- YYYY-MM-DD (kolay filtre için)
		price_ts   TEXT NOT NULL,  -- ISO timestamp (saatlik granüler)
		extra      TEXT,
		updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(asset_type, source, code, price_ts)
	  )
	`).run();

	await env.DB.prepare(`
	  CREATE INDEX IF NOT EXISTS idx_prices_hourly_lookup
	  ON asset_prices_hourly(asset_type, code, price_ts DESC)
	`).run();

	await env.DB.prepare(`
	  CREATE INDEX IF NOT EXISTS idx_prices_hourly_latest
	  ON asset_prices_hourly(asset_type, source, code, price_ts DESC)
	`).run();
  }
  
  // ─── Yardımcı Fonksiyonlar ───────────────────────────────────────────────────
  
  async function fetchUrl(url: string) {
	const res = await fetch(url, { headers: { "User-Agent": "InvestmentTracker/2.0" } });
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
	return res;
  }
  
  function extractAttr(xml: string, tagName: string, attrName: string) {
	const m = xml.match(new RegExp(`<${tagName}\\b([^>]*)>`, "i"));
	if (!m) return null;
	const a = m[1].match(new RegExp(`${attrName}="([^"]*)"`, "i"));
	return a ? decodeXml(a[1]) : null;
  }
  
  function extractAttrFromTag(block: string, attrName: string) {
	const m = block.match(/<Currency\b([^>]*)>/i);
	if (!m) return null;
	const a = m[1].match(new RegExp(`${attrName}="([^"]*)"`, "i"));
	return a ? decodeXml(a[1]) : null;
  }
  
  function tag(block: string, tagName: string) {
	const m = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
	return m ? decodeXml(m[1].trim()) : null;
  }
  
  function toNum(v: unknown) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(String(v).replace(",", "."));
	return Number.isFinite(n) ? n : null;
  }

  // Türkçe sayı formatını parse eder: "6.756,47" → 6756.47
  function parseTurkishNum(v: unknown) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(String(v).replace(/\./g, "").replace(",", "."));
	return Number.isFinite(n) ? n : null;
  }
  
  function midpoint(a: unknown, b: unknown) {
	const na = toNum(a), nb = toNum(b);
	if (na !== null && nb !== null) return (na + nb) / 2;
	return na ?? nb ?? null;
  }
  
  function decodeXml(v: unknown) {
	return String(v)
	  .replaceAll("&amp;", "&").replaceAll("&lt;", "<")
	  .replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");
  }
  
  function parseExtra(row: any) {
	try { row.extra = JSON.parse(row.extra ?? "{}"); } catch { row.extra = {}; }
	return row;
  }
  
  // Altınkaynak zaman formatı: "25.04.2026 23:31:33" → "2026-04-25"
  function normalizeAltinkaynakDateTime(v: unknown) {
	if (!v) return todayISO();
	const m = String(v).match(/^\s*(\d{2})\.(\d{2})\.(\d{4})(?:\s+|T|$)/);
	if (!m) return todayISO();
	const [, dd, mm, yyyy] = m;
	return `${yyyy}-${mm}-${dd}`;
  }

  function todayISO() {
	return new Date().toISOString().slice(0, 10);
  }

  function nowIsoHour() {
	const d = new Date();
	d.setMinutes(0, 0, 0);
	return d.toISOString(); // örn: 2026-04-26T12:00:00.000Z
  }

  function isoSince(range: string) {
	const d = new Date();
	if (range === "1d") d.setDate(d.getDate() - 1);
	else if (range === "1w" || range === "7d") d.setDate(d.getDate() - 7);
	else if (range === "30d") d.setDate(d.getDate() - 30);
	else if (range === "1y" || range === "365d") d.setFullYear(d.getFullYear() - 1);
	else return null;
	return d.toISOString();
  }
  
  function json(data: unknown, status = 200) {
	return Response.json(data, { status });
  }
  
  function jsonError(message: string, status = 400) {
	return Response.json({ success: false, error: message }, { status });
  }
  
  // ─── Endpoint Dokümantasyonu ─────────────────────────────────────────────────
  
  const ENDPOINT_DOCS = [
	"GET /sync/all                          → Tüm kaynakları güncelle",
	"GET /sync/{source|type}               → Tek kaynak/tip güncelle (örn: altinkaynak_currency, gold, altinkaynak_gold)",
	"GET /assets/{type}                    → En güncel fiyatlar + değişim % (currency|gold|silver|stock_tr|stock_us|crypto|fund)",
	"GET /assets/gold                      → Altın fiyatları: kod, ad, alış, satış, değişim % (kaynak: altinkaynak_gold)",
	"GET /assets/{type}?source={source}    → Kaynağa göre filtrele",
	"GET /assets/{type}/{code}             → Tek varlık (tüm kaynaklar)",
	"GET /assets/{type}/{code}/history     → Geçmiş fiyatlar (?limit=300&range=1d|1w|30d|1y)",
	"GET /sources                          → Kayıtlı veri kaynakları"
  ];