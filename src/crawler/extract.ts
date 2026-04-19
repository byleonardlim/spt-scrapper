import { log } from 'apify';
import type { Page } from 'playwright-core';
import type { TcgInterceptedData, TcgListing, TcgSalesBucket, TcgProductDetails } from './tcgplayer-types.js';

const safeNum = (v: unknown): number | null => {
    const n = Number(v);
    return isNaN(n) ? null : n;
};

const safeInt = (v: unknown): number => {
    const n = parseInt(String(v), 10);
    return isNaN(n) ? 0 : n;
};

const normalizeListing = (raw: Record<string, unknown>): TcgListing | null => {
    const price = safeNum(raw.price);
    if (price === null) return null;
    return {
        listingId: String(raw.listingId ?? raw.listing_id ?? ''),
        price,
        shippingPrice: safeNum(raw.shippingPrice ?? raw.shipping_price) ?? 0,
        condition: String(raw.condition ?? 'Unknown'),
        printing: String(raw.printing ?? raw.printing_name ?? 'Normal'),
        quantity: safeInt(raw.quantity),
        sellerName: String(raw.sellerName ?? raw.seller_name ?? ''),
        goldSeller: Boolean(raw.goldSeller ?? raw.gold_seller ?? false),
        directSeller: Boolean(raw.directSeller ?? raw.direct_seller ?? false),
        verifiedSeller: Boolean(raw.verifiedSeller ?? raw.verified_seller ?? false),
        sellerRating: safeNum(raw.sellerRating ?? raw.seller_rating) ?? 0,
        sellerSales: String(raw.sellerSales ?? raw.seller_sales ?? '0'),
    };
};

const normalizeBucket = (raw: Record<string, unknown>): TcgSalesBucket | null => {
    const marketPrice = safeNum(raw.marketPrice ?? raw.market_price);
    const quantitySold = safeInt(raw.quantitySold ?? raw.quantity_sold);
    const bucketStartDate = String(raw.bucketStartDate ?? raw.bucket_start_date ?? raw.date ?? '');
    if (!bucketStartDate || marketPrice === null) return null;
    return {
        bucketStartDate,
        quantitySold,
        marketPrice,
        condition: raw.condition ? String(raw.condition) : undefined,
        printing: raw.printing ? String(raw.printing) : undefined,
    };
};

const parseListingsArray = (raw: unknown): TcgListing[] => {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((item) => normalizeListing(item as Record<string, unknown>))
        .filter((l): l is TcgListing => l !== null);
};

const parseSalesBuckets = (raw: unknown): TcgSalesBucket[] => {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((item) => normalizeBucket(item as Record<string, unknown>))
        .filter((b): b is TcgSalesBucket => b !== null);
};

export const extractFromSsrState = async (page: Page): Promise<TcgInterceptedData | null> => {
    try {
        const data = await page.evaluate(() => {
            const el = document.getElementById('__NEXT_DATA__');
            if (!el?.textContent) return null;
            try { return JSON.parse(el.textContent); } catch { return null; }
        });

        if (!data) return null;

        const props = data?.props?.pageProps ?? data?.props ?? {};
        const product = props?.product ?? props?.productDetails ?? props?.cardDetails ?? null;
        const listingsRaw = props?.listings ?? props?.productListings ?? product?.listings ?? [];
        const salesRaw = props?.salesHistory ?? props?.sales_history ?? product?.salesHistory ?? [];

        const listings = parseListingsArray(listingsRaw);
        const salesBuckets = parseSalesBuckets(salesRaw?.buckets ?? salesRaw);
        const productDetails: TcgProductDetails | null = product ? {
            marketPrice: safeNum(product.marketPrice ?? product.market_price),
            medianPrice: safeNum(product.medianPrice ?? product.median_price),
            totalListings: safeInt(product.totalListings ?? product.total_listings ?? listings.length),
        } : null;

        if (listings.length === 0 && salesBuckets.length === 0 && !productDetails) return null;

        log.debug('SSR extraction succeeded', { listings: listings.length, buckets: salesBuckets.length });
        return { listings, salesBuckets, productDetails };
    } catch (err) {
        log.debug('SSR extraction failed', { error: String(err) });
        return null;
    }
};

export const extractFromDom = async (page: Page): Promise<TcgInterceptedData | null> => {
    try {
        const result = await page.evaluate(() => {
            const listings: Record<string, unknown>[] = [];
            const listingCards = document.querySelectorAll('[data-testid="listing-item"], .listing-item, .product-listing');

            listingCards.forEach((card) => {
                const priceEl = card.querySelector('[data-testid="listing-price"], .price, .listing-price');
                const priceText = priceEl?.textContent?.replace(/[^0-9.]/g, '') ?? '';
                const price = parseFloat(priceText);
                if (isNaN(price)) return;

                const shippingEl = card.querySelector('[data-testid="shipping-price"], .shipping, .listing-shipping');
                const shippingText = shippingEl?.textContent?.replace(/[^0-9.]/g, '') ?? '0';

                const sellerEl = card.querySelector('[data-testid="seller-name"], .seller-name');
                const conditionEl = card.querySelector('[data-testid="condition"], .condition');
                const qtyEl = card.querySelector('[data-testid="quantity"], .quantity');

                listings.push({
                    listingId: card.getAttribute('data-listing-id') ?? String(Math.random()),
                    price,
                    shippingPrice: parseFloat(shippingText) || 0,
                    condition: conditionEl?.textContent?.trim() ?? 'Unknown',
                    printing: 'Normal',
                    quantity: parseInt(qtyEl?.textContent ?? '1', 10) || 1,
                    sellerName: sellerEl?.textContent?.trim() ?? '',
                    goldSeller: card.querySelector('.gold-seller, [data-gold="true"]') !== null,
                    directSeller: card.querySelector('.direct-seller, [data-direct="true"]') !== null,
                    verifiedSeller: card.querySelector('.verified-seller, [data-verified="true"]') !== null,
                    sellerRating: 0,
                    sellerSales: 0,
                });
            });

            const marketPriceEl = document.querySelector('[data-testid="market-price"], .market-price');
            const marketPriceText = marketPriceEl?.textContent?.replace(/[^0-9.]/g, '') ?? '';

            return { listings, marketPrice: parseFloat(marketPriceText) || null };
        });

        if (!result || result.listings.length === 0) return null;

        const listings = parseListingsArray(result.listings);
        log.debug('DOM extraction succeeded', { listings: listings.length });

        return {
            listings,
            salesBuckets: [],
            productDetails: result.marketPrice ? {
                marketPrice: result.marketPrice,
                medianPrice: null,
                totalListings: listings.length,
            } : null,
        };
    } catch (err) {
        log.debug('DOM extraction failed', { error: String(err) });
        return null;
    }
};

export const mergeInterceptedData = (
    intercepted: TcgInterceptedData | null,
    ssr: TcgInterceptedData | null,
    dom: TcgInterceptedData | null,
): TcgInterceptedData => {
    const candidates = [intercepted, ssr, dom].filter((c): c is TcgInterceptedData => c !== null);

    if (candidates.length === 0) {
        return { listings: [], salesBuckets: [], productDetails: null };
    }

    const best = candidates.reduce((prev, curr) => {
        const prevScore = (prev.listings.length * 2) + prev.salesBuckets.length;
        const currScore = (curr.listings.length * 2) + curr.salesBuckets.length;
        return currScore > prevScore ? curr : prev;
    });

    const productDetails =
        intercepted?.productDetails ??
        ssr?.productDetails ??
        dom?.productDetails ??
        null;

    return { ...best, productDetails };
};
