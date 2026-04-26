# Piyasa Worker Backend

Cloudflare Worker üzerinde çalışan basit bir “piyasa verisi” API’si. Döviz ve altın (şu an aktif iki varlık tipi) verisini dış kaynaktan çekip normalize eder, **D1** veritabanına yazar ve API üzerinden en güncel kaydı döner.

## API akışı (istek gelince ne oluyor?)

Uygulama girişi `src/index.ts` içindeki `fetch` fonksiyonudur.

### 1) Route çözümü

- `GET /assets/{type}` istekleri varlık liste endpoint’idir.
- `type` örnekleri: `currency`, `gold`

### 2) Okumadan önce “refresh” (read-through cache)

`/assets/...` isteklerinde önce `refreshBeforeRead(...)` çalışır:

- **`source` query parametresi varsa** sadece o provider güncellenir  
  Örn: `GET /assets/currency?source=altinkaynak_currency`
- **`source` yoksa** bu `assetType`’ı üreten tüm provider’lar güncellenir  
  Örn: `GET /assets/currency` → `currency` üreten provider(lar) çalışır

Refresh başarısız olursa istek yine cevaplanır (varsa D1’deki mevcut veriler döner).

### 3) Provider dış kaynaktan çeker ve normalize eder

Provider’lar `PROVIDERS` objesinde tanımlıdır ve her biri:

- `meta()` → provider bilgisi (id, isim, url, ürettiği assetTypes)
- `fetch(env)` → normalize edilmiş kayıt listesi döner

Aktif kaynaklar:

- **Döviz (currency)**: `altinkaynak_currency`  
  Kaynak: `https://static.altinkaynak.com/public/Currency`
- **Altın (gold)**: `altinkaynak_gold`  
  Kaynak: `https://static.altinkaynak.com/public/Gold`

Normalize edilen standart alanlar:

- `assetType`: `currency` / `gold`
- `source`: provider id (örn. `altinkaynak_currency`)
- `code`: (örn. `USD`)
- `name`: açıklama
- `priceDate`: `YYYY-MM-DD`
- `price`: **alış/satış orta değeri** (midpoint)
- `extra`: ham alanlar (`buy`, `sell`, `updated_at` vb.)

### 4) D1’e yazma (upsert)

Provider çıktısı `runProvider(...)` ile `asset_prices` tablosuna yazılır:

- Unique: `(asset_type, source, code, price_date)`
- Aynı gün/varlık gelirse **update** edilir.

### 5) API cevabı D1’den okunur

`getAssets(...)` sonrasında:

- Her `code+source` için en güncel `price_date` seçilir
- Bir önceki kaydı da join’leyip değişim % hesaplanır
- JSON olarak döndürülür

## Endpoint’ler

- `GET /assets/currency` → tüm döviz kurları (en güncel)
- `GET /assets/gold` → tüm altın fiyatları (en güncel)
- `GET /assets/{type}?source={sourceId}` → kaynağa göre filtre
- `GET /assets/{type}/{code}` → tek varlık (örn. `USD`)
- `GET /assets/{type}/{code}/history?limit=30` → geçmiş kayıtlar
- `GET /sync/all` → tüm provider’ları çalıştırır (D1’i günceller)
- `GET /sync/{source|type}` → tek provider veya tek varlık tipi güncelleme  
  Örn: `GET /sync/altinkaynak_currency` veya `GET /sync/currency`
- `GET /sources` → provider listesini döner

## Hızlı deneme (örnek istekler)

```bash
curl -s "http://localhost:8787/assets/currency" | jq .
curl -s "http://localhost:8787/assets/gold" | jq .
curl -s "http://localhost:8787/assets/currency?source=altinkaynak_currency" | jq .
curl -s "http://localhost:8787/sync/altinkaynak_currency" | jq .
```

> Lokal port `wrangler dev` konfigürasyonuna göre değişebilir.
