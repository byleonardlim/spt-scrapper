# SPT Apify Actor — Design & Requirements

## Overview

Custom Apify actor to scrape Magic: The Gathering card market data from TCGPlayer.
Targets: sales volume, listing inventory, and price analytics for specific MTG sets.

---

## Requirements (agreed 2026-04-19)

### 1. Target Sets

- **Edge of Eternities** — Scryfall set code: `eoe`
- **TMNT (Universes Beyond: Teenage Mutant Ninja Turtles)** — Scryfall set code: `tmnt` (released March 6, 2026)
- **Cards per set:** first 50 cards ordered by collector number (`unique=prints`)

### 2. URL Resolution Strategy

- **Source:** Scryfall public API (`https://api.scryfall.com`)
- **Endpoint:** `GET /cards/search?q=set:{code}&order=collector_number&unique=prints`
- **Key field:** each Scryfall card object returns `tcgplayer_id` which is exactly TCGPlayer's `productId`
- **TCGPlayer URL constructed as:** `https://www.tcgplayer.com/product/{tcgplayer_id}/`
- **No TCGPlayer search needed** — Scryfall resolves product URLs directly
- Scryfall rate limit: 100ms between calls
- `tcgplayer_etched_id` (if present on a card) is treated as a separate product URL / separate output record

### 3. Variant Handling (agreed 2026-04-19)

- Each Scryfall print (`unique=prints`) is a **separate output record**
- Multiple prints of the same card name (nonfoil, foil, etched, showcase, borderless, japan showcase, serialized, etc.) each have their own `tcgplayer_id` and appear as individual records grouped under the same card name
- Variant classification uses the SPT `TcgVariantAttributes` system (ported from `~/Code/spt/src/lib/tcg-variant.ts` and `~/Code/spt/src/lib/types/market.ts`):
  - `frameStyle`: `standard` | `showcase` | `borderless` | `extended-art` | `retro-frame` | `full-art` | `textless`
  - `artStyle`: `standard` | `alternate-art` | `anime` | `japan-showcase`
  - `foilStyle`: `standard` | `surge` | `fractal` | `galaxy` | `rainbow` | `wave` | `step-and-compleat` | `halo` | `gilded` | `confetti` | `raised`
  - `rarityStyle`: `standard` | `serialized` | `stamped` | `promo`
  - `finish`: `nonfoil` | `foil` | `etched` | `glossy` | `textured`
- Variant signals come from Scryfall fields: `finishes[]`, `promo_types[]`, `frame_effects[]`, `security_stamp`, `lang`

### 4. Scryfall Pricing Exclusion (agreed 2026-04-19)

- Scryfall is used **only** for:
  - TCGPlayer URL resolution (`tcgplayer_id`)
  - Card identity fields (`name`, `set_name`, `collector_number`, `rarity`)
  - Variant classification (`finishes[]`, `promo_types[]`, `frame_effects[]`, `security_stamp`, `lang`)
- Scryfall `prices` fields (`usd`, `usd_foil`, `usd_etched`, etc.) are **never read and never stored**
- All pricing (`tcg_market_price`, `tcg_median_price`) comes exclusively from TCGPlayer

### 5. Sales History Window (agreed 2026-04-19)

- Configurable input parameter: `salesWindowDays`
- Supported values: `30` or `90`
- Aggregated **across all card conditions** (Near Mint, Lightly Played, etc.)

### 6. Top Listings (agreed 2026-04-19)

- `top_listings`: top **10** listings sorted by `price_landed` ascending (cheapest first)

### 7. `spt_id` Format (agreed 2026-04-19)

- Format: `{setCode}-{collectorNumber}` (e.g. `eoe-001`, `tmnt-042`, `eoe-★123`)
- Matches the SPT cardKey convention used in `~/Code/spt`

### 8. Output Delivery Strategy (agreed 2026-04-19)

- **Primary:** Webhook push — actor POSTs scraped records directly to the SPT backend REST API, which writes to the existing MongoDB
- **Rationale:** Most cost-efficient — bypasses Apify Dataset storage billing entirely; leverages existing MongoDB infrastructure that is already scaled for the SPT system
- **Fallback:** If `webhookUrl` input is not provided, actor writes to Apify Dataset as a safe default
- **Delivery modes:**
  - `per-record` — actor POSTs each card record immediately after scraping (lower memory, real-time ingest)
  - `batch` — actor collects all records and POSTs once at the end (fewer HTTP calls, default)
- **Security:** `webhookAuthToken` input param sent as `Authorization: Bearer {token}` header on every POST
- **SPT ingest endpoint** (to be built on the SPT backend):
  - `POST /ingest/tcgplayer/batch` — accepts array of scraped records
  - `POST /ingest/tcgplayer` — accepts single record (per-record mode)
- **MongoDB target collections** (existing SPT schema):
  - `mtg_cards` — upsert on `tcgplayer_product_id` for product metadata + variant attributes
  - `mtg_market_data` — insert time-series market data points per run

---

## Anti-Bot Strategy

TCGPlayer uses **DataDome** for bot protection (not Cloudflare).

### Mitigation Stack (in priority order)

| Layer | Tool / Technique |
|---|---|
| Browser | `playwright-extra` + `puppeteer-extra-plugin-stealth` (patches 200+ headless leaks) |
| Proxy | Apify Residential Proxy (US) — DataDome trusts residential IPs |
| Session Pool | Crawlee `SessionPool` — auto-retires sessions on DataDome challenge detection |
| Delay | 1.5–3.5s random jitter between requests |
| Fingerprint | Realistic Chrome UA, `Accept-Language: en-US,en`, viewport 1366×768 |
| Challenge detection | HTTP 403 with `datadome` cookie → retire session, re-queue URL (max 3 retries) |

### Extraction Strategy (waterfall fallbacks per product URL)

1. **API Interception** — Playwright intercepts XHR to `mpapi.tcgplayer.com` during page load; captures listings + sales history JSON in-flight
2. **Request Replay** — Replays the intercepted API URL with session cookies; paginates for all listings and sales history window
3. **SSR State Extraction** — Parses `<script id="__NEXT_DATA__">` from page HTML for product metadata
4. **DOM Scraping** — Last resort; parses rendered HTML listing cards and sales table

Each strategy's output is compared; the most complete dataset wins.

---

## Output Schema

One JSON record per print variant (per `tcgplayer_id`).

```typescript
{
  // Identity
  spt_id: string,                    // "{setCode}-{collectorNumber}" e.g. "eoe-042"
  tcgplayer_product_id: number,      // Scryfall tcgplayer_id = TCGPlayer productId

  // Variant classification (mirrors SPT TcgVariantAttributes)
  finish: string,                    // "nonfoil" | "foil" | "etched" | ...
  variant_label: string,             // human-readable e.g. "Japan Showcase Foil"
  variant_attributes: {
    frameStyle: string,
    artStyle: string,
    foilStyle: string | null,
    rarityStyle: string,
    isSerialized: boolean,
    serialNumber: number | null,
    serialTotal: number | null
  },

  product_metadata: {
    spt_id: string,
    name: string,
    set_name: string,
    rarity_tier: string,             // "common" | "uncommon" | "rare" | "mythic"
    tcg_market_price: number,        // from TCGPlayer only
    tcg_median_price: number         // from TCGPlayer only
  },

  inventory_snapshot: {
    timestamp: string,               // ISO-8601
    total_active_listings: number,
    total_units_available: number,   // sum of quantity across all listings
    top_listings: [                  // top 10 sorted by price_landed ASC
      {
        listing_id: string,
        seller_name: string,
        seller_type: string,         // "gold" | "direct" | "verified" | "standard"
        seller_rating: number,
        seller_sales_count: number,
        condition: string,
        printing: string,
        quantity_available: number,
        price_base: number,
        price_shipping: number,
        price_landed: number         // price_base + price_shipping
      }
    ]
  },

  sales_pulse: {
    latest_sales_count: 50,          // fixed: last 50 individual sale events
    sales_history: [                 // last 30 or 90 days, all conditions aggregated
      {
        sale_date: string,
        condition: string,
        printing: string,
        quantity_sold: number,
        sale_price_landed: number
      }
    ]
  },

  spt_analytics_preview: {
    wall_depth_10pct: number,        // count of listings within 10% of lowest price_landed
    sales_velocity_24h: number,      // total_quantity_sold / salesWindowDays
    liquidity_gap_ratio: number      // (listings[1].price_landed - listings[0].price_landed) / listings[0].price_landed
  }
}
```

### `seller_type` Derivation Logic
```
goldSeller = true    → "gold"
directSeller = true  → "direct"
verifiedSeller = true → "verified"
else                 → "standard"
```

---

## Configurable Input Schema

```typescript
{
  // Scraping targets
  sets: string[],                    // default: ["eoe", "tmnt"]
  cardsPerSet: number,               // default: 50
  salesWindowDays: 30 | 90,         // default: 30
  topListingsCount: number,          // default: 10

  // Output delivery (agreed 2026-04-19)
  webhookUrl: string | null,         // default: null → fallback to Apify Dataset
  webhookAuthToken: string | null,   // default: null → sent as Authorization: Bearer {token}
  webhookDeliveryMode: "batch" | "per-record", // default: "batch"

  // Crawler tuning
  maxConcurrency: number,            // default: 3
  delayBetweenRequestsMs: number,    // default: 1500
  maxRetries: number,                // default: 3
  proxyConfiguration: {
    useApifyProxy: boolean,
    apifyProxyGroups: string[],      // ["RESIDENTIAL"]
    apifyProxyCountry: string        // "US"
  }
}
```

---

## Tech Stack

| Package | Role |
|---|---|
| `apify/actor-node-playwright-chrome` | Base Docker image (Chromium bundled) |
| `crawlee` | RequestQueue, SessionPool, PlaywrightCrawler, retry logic |
| `playwright-extra` | Stealth Playwright wrapper |
| `puppeteer-extra-plugin-stealth` | 200+ headless leak patches |
| `got-scraping` | Hardened HTTP for Scryfall calls and webhook POSTs (no browser needed) |
| `TypeScript` | Type safety, mirrors SPT variant types |

---

## Actor Flow

```
ACTOR START
│
├─ PHASE 1: Scryfall Seed (plain HTTPS fetch, ~100ms delay, no proxy)
│   ├─ GET /cards/search?q=set:eoe&unique=prints&order=collector_number → first 50
│   ├─ GET /cards/search?q=set:tmnt&unique=prints&order=collector_number → first 50
│   ├─ Derive variant_attributes from Scryfall signals (tcg-variant logic port)
│   ├─ Build variant_label from variant_attributes
│   └─ Enqueue TCGPlayer URLs into RequestQueue (tcgplayer_id + tcgplayer_etched_id)
│
├─ PHASE 2: Crawlee PlaywrightCrawler (stealth, Apify Residential Proxy US)
│   ├─ maxConcurrency: 3
│   ├─ Random jitter 1.5–3.5s between requests
│   ├─ Per URL: API Interception → Request Replay → SSR Parse → DOM Scrape
│   ├─ DataDome 403 detected → retire session, re-queue (max 3 retries)
│   └─ Merge TCGPlayer data with Scryfall metadata payload
│
├─ PHASE 3: Analytics (in-memory computation, no network)
│   ├─ wall_depth_10pct  = listings.filter(l => l.price_landed <= min * 1.1).length
│   ├─ sales_velocity_24h = totalSold / salesWindowDays
│   └─ liquidity_gap_ratio = (listings[1].price_landed - listings[0].price_landed) / listings[0].price_landed
│
├─ PHASE 4: Output Delivery (agreed 2026-04-19)
│   ├─ If webhookUrl provided:
│   │   ├─ batch mode   → POST /ingest/tcgplayer/batch  [ ...all records ]
│   │   └─ per-record   → POST /ingest/tcgplayer  { ...single record }  (per card)
│   │   Authorization: Bearer {webhookAuthToken}
│   └─ If no webhookUrl → write to Apify Dataset (fallback)
│
└─ OUTPUT: MongoDB (via SPT webhook) or Apify Dataset (fallback)
```

---

## References

- SPT variant system: `~/Code/spt/src/lib/tcg-variant.ts`
- SPT type definitions: `~/Code/spt/src/lib/types/market.ts`
- SPT schema design: `~/Code/spt/documentation/tcg-schema-design.md`
- TCGPlayer API docs: `https://docs.tcgplayer.com`
- Scryfall API docs: `https://scryfall.com/docs/api`
