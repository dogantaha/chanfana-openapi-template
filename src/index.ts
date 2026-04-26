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

export default {
	async fetch(request, env, ctx) {
	  try {
		return await route(request, env);
	  } catch (err) {
		console.error("Unhandled error:", err);
		return jsonError("Internal server error", 500);
	  }
	},
  
	// Cron tetikleyici — wrangler.toml'da tanımlanacak
	// [triggers] crons = ["0 6 * * 1-5"]   (hafta içi 06:00 UTC)
	async scheduled(event, env, ctx) {
	  ctx.waitUntil(syncAll(env));
	}
  };
  
  async function route(request, env) {
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
  
  const PROVIDERS = {
  
	// ── TCMB: Döviz ──────────────────────────────────────────────────────────
	tcmb_currency: {
	  meta: () => ({
		id: "tcmb_currency",
		name: "TCMB Döviz Kurları",
		assetTypes: ["currency"],
		url: "https://www.tcmb.gov.tr/kurlar/today.xml"
	  }),
  
	  fetch: async (env) => {
		const res = await fetchUrl("https://www.tcmb.gov.tr/kurlar/today.xml");
		const xml = await res.text();
  
		const priceDate = extractAttr(xml, "Tarih_Date", "Tarih")
		  || extractAttr(xml, "Tarih_Date", "Date")
		  || todayISO();
  
		const blocks = [...xml.matchAll(/<Currency\b[^>]*>[\s\S]*?<\/Currency>/g)]
		  .map(m => m[0]);
  
		return blocks.map(block => {
		  const code = extractAttrFromTag(block, "Kod");
		  if (!code) return null;
  
		  return {
			assetType: "currency",
			source: "tcmb_currency",
			code,
			name: tag(block, "Isim"),
			priceDate,
			// Para birimi için standart alan: orta kur (alış+satış / 2)
			// Tüm ham veriler extra'da saklanır
			price: midpoint(tag(block, "ForexBuying"), tag(block, "ForexSelling")),
			extra: {
			  unit:             toNum(tag(block, "Unit")),
			  forex_buying:     toNum(tag(block, "ForexBuying")),
			  forex_selling:    toNum(tag(block, "ForexSelling")),
			  banknote_buying:  toNum(tag(block, "BanknoteBuying")),
			  banknote_selling: toNum(tag(block, "BanknoteSelling"))
			}
		  };
		}).filter(Boolean);
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

	  fetch: async (env) => {
		const res = await fetchUrl("https://static.altinkaynak.com/public/Gold");
		const items = await res.json();
		const priceDate = todayISO();

		return items.map(item => {
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
  
  async function syncAll(env) {
	await ensureTables(env);
	const results = {};
  
	for (const [id, provider] of Object.entries(PROVIDERS)) {
	  try {
		results[id] = await runProvider(env, provider);
	  } catch (err) {
		results[id] = { success: false, error: err.message };
	  }
	}
  
	return { success: true, results };
  }
  
  async function syncOne(env, type) {
	await ensureTables(env);
  
	// type → "tcmb_currency" gibi bir source ID olabilir,
	//        ya da "currency" gibi bir asset type olabilir
	const byId   = PROVIDERS[type];
	const byType = Object.values(PROVIDERS).filter(p => p.meta().assetTypes.includes(type));
  
	if (byId) {
	  return { success: true, results: { [type]: await runProvider(env, byId) } };
	}
  
	if (byType.length) {
	  const results = {};
	  for (const p of byType) {
		results[p.meta().id] = await runProvider(env, p);
	  }
	  return { success: true, results };
	}
  
	return jsonError(`Unknown type or source: ${type}`, 400);
  }
  
  async function runProvider(env, provider) {
	const records = await provider.fetch(env);
	let saved = 0, skipped = 0;
  
	for (const r of records) {
	  if (!r.price && r.price !== 0) { skipped++; continue; }
  
	  await env.DB.prepare(`
		INSERT INTO asset_prices (asset_type, source, code, name, price, price_date, extra)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(asset_type, source, code, price_date)
		DO UPDATE SET
		  name       = excluded.name,
		  price      = excluded.price,
		  extra      = excluded.extra,
		  updated_at = CURRENT_TIMESTAMP
	  `).bind(
		r.assetType, r.source, r.code, r.name,
		r.price, r.priceDate, JSON.stringify(r.extra ?? {})
	  ).run();
  
	  saved++;
	}
  
	return { success: true, saved, skipped, total: records.length };
  }
  
  // ─── Sorgular ────────────────────────────────────────────────────────────────
  
  async function getAssets(env, type, url) {
	const source = url.searchParams.get("source"); // opsiyonel filtre

	// İstek geldiğinde önce kaynaktan çekip DB'yi güncelle (read-through cache).
	// - source verilirse sadece o provider refresh edilir
	// - source yoksa bu assetType'ı üreten tüm provider'lar refresh edilir
	await refreshBeforeRead(env, type, source);

	// Bir önceki price_date'e ait fiyatı LEFT JOIN ile çekerek değişim % hesaplanır.
	let query = `
	  SELECT a.*, prev.price AS prev_price, prev.extra AS prev_extra
	  FROM asset_prices a
	  INNER JOIN (
		SELECT code, source, MAX(price_date) AS max_date
		FROM asset_prices
		WHERE asset_type = ?
		GROUP BY code, source
	  ) latest ON a.code = latest.code
			 AND a.source = latest.source
			 AND a.price_date = latest.max_date
	  LEFT JOIN asset_prices prev
		ON  prev.asset_type = a.asset_type
		AND prev.code       = a.code
		AND prev.source     = a.source
		AND prev.price_date = (
		  SELECT MAX(price_date)
		  FROM   asset_prices
		  WHERE  asset_type = a.asset_type
		  AND    code       = a.code
		  AND    source     = a.source
		  AND    price_date < latest.max_date
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
	  assets: result.results.map(row => {
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
  
  async function getAsset(env, type, code) {
	// Tek varlık isteklerinde de önce refresh et (tüm ilgili provider'lar).
	await refreshBeforeRead(env, type, null);

	const rows = await env.DB.prepare(`
	  SELECT *
	  FROM asset_prices
	  WHERE asset_type = ? AND code = ?
	  ORDER BY price_date DESC, updated_at DESC
	  LIMIT 10
	`).bind(type, code).all();
  
	if (!rows.results.length) {
	  return jsonError(`${type}/${code} not found`, 404);
	}
  
	// Her kaynak için en güncel kaydı döner
	const bySource = {};
	for (const row of rows.results) {
	  if (!bySource[row.source]) bySource[row.source] = parseExtra(row);
	}
  
	return {
	  success: true,
	  assetType: type,
	  code,
	  quotes: Object.values(bySource)
	};
  }
  
  async function getHistory(env, type, code, url) {
	const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "30"), 365);
	const source = url.searchParams.get("source");
  
	// History çağrılarında da güncel veriyi önce çek.
	await refreshBeforeRead(env, type, source);

	let query = `
	  SELECT * FROM asset_prices
	  WHERE asset_type = ? AND code = ?
	`;
	const params = [type, code];
  
	if (source) { query += " AND source = ?"; params.push(source); }
  
	query += ` ORDER BY price_date DESC LIMIT ?`;
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
  
  async function refreshBeforeRead(env, assetType, sourceId) {
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
  
  async function ensureTables(env) {
	await env.DB.prepare(`
	  CREATE TABLE IF NOT EXISTS asset_prices (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		asset_type TEXT NOT NULL,  -- currency | gold | silver | stock_tr | stock_us | crypto | fund
		source     TEXT NOT NULL,  -- tcmb_currency | bist | coingecko | ...
		code       TEXT NOT NULL,  -- USD | XAU_GRAM | THYAO | BTC | ...
		name       TEXT,
		price      REAL,           -- Standart fiyat (TRY cinsinden veya kaynağın birimi)
		price_date TEXT NOT NULL,  -- YYYY-MM-DD
		extra      TEXT,           -- JSON: kaynağa özgü ek alanlar
		updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(asset_type, source, code, price_date)
	  )
	`).run();
  
	// Sık sorgulanan sütunlara index
	await env.DB.prepare(`
	  CREATE INDEX IF NOT EXISTS idx_asset_type_code
	  ON asset_prices(asset_type, code, price_date DESC)
	`).run();
  }
  
  // ─── Yardımcı Fonksiyonlar ───────────────────────────────────────────────────
  
  async function fetchUrl(url) {
	const res = await fetch(url, { headers: { "User-Agent": "InvestmentTracker/2.0" } });
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
	return res;
  }
  
  function extractAttr(xml, tagName, attrName) {
	const m = xml.match(new RegExp(`<${tagName}\\b([^>]*)>`, "i"));
	if (!m) return null;
	const a = m[1].match(new RegExp(`${attrName}="([^"]*)"`, "i"));
	return a ? decodeXml(a[1]) : null;
  }
  
  function extractAttrFromTag(block, attrName) {
	const m = block.match(/<Currency\b([^>]*)>/i);
	if (!m) return null;
	const a = m[1].match(new RegExp(`${attrName}="([^"]*)"`, "i"));
	return a ? decodeXml(a[1]) : null;
  }
  
  function tag(block, tagName) {
	const m = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
	return m ? decodeXml(m[1].trim()) : null;
  }
  
  function toNum(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(String(v).replace(",", "."));
	return Number.isFinite(n) ? n : null;
  }

  // Türkçe sayı formatını parse eder: "6.756,47" → 6756.47
  function parseTurkishNum(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(String(v).replace(/\./g, "").replace(",", "."));
	return Number.isFinite(n) ? n : null;
  }
  
  function midpoint(a, b) {
	const na = toNum(a), nb = toNum(b);
	if (na !== null && nb !== null) return (na + nb) / 2;
	return na ?? nb ?? null;
  }
  
  function decodeXml(v) {
	return String(v)
	  .replaceAll("&amp;", "&").replaceAll("&lt;", "<")
	  .replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");
  }
  
  function parseExtra(row) {
	try { row.extra = JSON.parse(row.extra ?? "{}"); } catch { row.extra = {}; }
	return row;
  }
  
  function todayISO() {
	return new Date().toISOString().slice(0, 10);
  }
  
  function json(data, status = 200) {
	return Response.json(data, { status });
  }
  
  function jsonError(message, status = 400) {
	return Response.json({ success: false, error: message }, { status });
  }
  
  // ─── Endpoint Dokümantasyonu ─────────────────────────────────────────────────
  
  const ENDPOINT_DOCS = [
	"GET /sync/all                          → Tüm kaynakları güncelle",
	"GET /sync/{source|type}               → Tek kaynak/tip güncelle (örn: tcmb_currency, gold, altinkaynak_gold)",
	"GET /assets/{type}                    → En güncel fiyatlar + değişim % (currency|gold|silver|stock_tr|stock_us|crypto|fund)",
	"GET /assets/gold                      → Altın fiyatları: kod, ad, alış, satış, değişim % (kaynak: altinkaynak_gold)",
	"GET /assets/{type}?source={source}    → Kaynağa göre filtrele",
	"GET /assets/{type}/{code}             → Tek varlık (tüm kaynaklar)",
	"GET /assets/{type}/{code}/history     → Geçmiş fiyatlar (?limit=30)",
	"GET /sources                          → Kayıtlı veri kaynakları"
  ];