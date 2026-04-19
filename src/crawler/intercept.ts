import { log } from 'apify';
import type { Page, Response } from 'playwright-core';
import type { TcgInterceptedData, TcgListing, TcgSalesBucket, TcgProductDetails } from './tcgplayer-types.js';

const LISTINGS_PATTERN = /mpapi\.tcgplayer\.com.*\/listing/i;
const SALES_PATTERN = /mpapi\.tcgplayer\.com.*sales/i;
const PRODUCT_PATTERN = /mpapi\.tcgplayer\.com.*product.*details|api\.tcgplayer\.com.*pricing\/product/i;

const safeJson = async (response: Response): Promise<unknown> => {
    try {
        const text = await response.text();
        return JSON.parse(text);
    } catch {
        return null;
    }
};

const parseListingsResponse = (body: unknown): TcgListing[] => {
    if (!body || typeof body !== 'object') return [];
    const b = body as Record<string, unknown>;
    const results = (b.results ?? b.listings ?? b.data ?? []) as Record<string, unknown>[];
    if (!Array.isArray(results)) return [];

    return results.map((r): TcgListing => ({
        listingId: String(r.listingId ?? r.listing_id ?? ''),
        price: Number(r.price ?? 0),
        shippingPrice: Number(r.shippingPrice ?? r.shipping_price ?? 0),
        condition: String(r.condition ?? 'Unknown'),
        printing: String(r.printing ?? r.printing_name ?? 'Normal'),
        quantity: parseInt(String(r.quantity ?? 1), 10),
        sellerName: String(r.sellerName ?? r.seller_name ?? ''),
        goldSeller: Boolean(r.goldSeller ?? r.gold_seller ?? false),
        directSeller: Boolean(r.directSeller ?? r.direct_seller ?? false),
        verifiedSeller: Boolean(r.verifiedSeller ?? r.verified_seller ?? false),
        sellerRating: Number(r.sellerRating ?? r.seller_rating ?? 0),
        sellerSales: String(r.sellerSales ?? r.seller_sales ?? '0'),
    })).filter((l) => l.price > 0);
};

const parseSalesResponse = (body: unknown): TcgSalesBucket[] => {
    if (!body || typeof body !== 'object') return [];
    const b = body as Record<string, unknown>;

    const rawBuckets =
        (b.results as Record<string, unknown>[])?.[0]?.['buckets'] ??
        b.buckets ??
        b.data ??
        b.results ??
        [];

    if (!Array.isArray(rawBuckets)) return [];

    return rawBuckets
        .map((r: Record<string, unknown>): TcgSalesBucket | null => {
            const marketPrice = Number(r.marketPrice ?? r.market_price);
            const bucketStartDate = String(r.bucketStartDate ?? r.bucket_start_date ?? r.date ?? '');
            if (!bucketStartDate || isNaN(marketPrice)) return null;
            return {
                bucketStartDate,
                quantitySold: parseInt(String(r.quantitySold ?? r.quantity_sold ?? 0), 10),
                marketPrice,
                condition: r.condition ? String(r.condition) : undefined,
                printing: r.printing ? String(r.printing) : undefined,
            };
        })
        .filter((b): b is TcgSalesBucket => b !== null);
};

const parseProductResponse = (body: unknown): TcgProductDetails | null => {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    const results = Array.isArray(b.results) ? b.results[0] : b;
    if (!results) return null;
    const r = results as Record<string, unknown>;
    return {
        marketPrice: r.marketPrice != null ? Number(r.marketPrice) : null,
        medianPrice: r.medianPrice != null ? Number(r.medianPrice) : null,
        totalListings: parseInt(String(r.totalListings ?? r.total_listings ?? 0), 10),
    };
};

export const setupInterception = (
    page: Page,
    productId: number,
    salesWindowDays: number,
): { getInterceptedData: () => TcgInterceptedData; cleanup: () => Promise<void> } => {
    const collected: TcgInterceptedData = {
        listings: [],
        salesBuckets: [],
        productDetails: null,
    };

    const handler = async (response: Response) => {
        const url = response.url();
        const status = response.status();
        if (status < 200 || status >= 300) return;

        try {
            if (LISTINGS_PATTERN.test(url) && url.includes(String(productId))) {
                const body = await safeJson(response);
                const listings = parseListingsResponse(body);
                if (listings.length > 0) {
                    log.debug(`Intercepted listings for product ${productId}`, { count: listings.length, url });
                    collected.listings = listings;
                }
            } else if (SALES_PATTERN.test(url) && url.includes(String(productId))) {
                const body = await safeJson(response);
                const buckets = parseSalesResponse(body);
                if (buckets.length > 0) {
                    log.debug(`Intercepted sales for product ${productId}`, { count: buckets.length, url });
                    collected.salesBuckets = filterBucketsByWindow(buckets, salesWindowDays);
                }
            } else if (PRODUCT_PATTERN.test(url) && url.includes(String(productId))) {
                const body = await safeJson(response);
                const details = parseProductResponse(body);
                if (details) {
                    log.debug(`Intercepted product details for ${productId}`, { details, url });
                    collected.productDetails = details;
                }
            }
        } catch (err) {
            log.debug(`Intercept handler error for ${url}`, { error: String(err) });
        }
    };

    page.on('response', handler);

    return {
        getInterceptedData: () => ({ ...collected }),
        cleanup: async () => {
            page.off('response', handler);
        },
    };
};

const filterBucketsByWindow = (buckets: TcgSalesBucket[], days: number): TcgSalesBucket[] => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return buckets.filter((b) => {
        const d = new Date(b.bucketStartDate);
        return !isNaN(d.getTime()) && d >= cutoff;
    });
};
