import { log } from 'apify';
import type { Page, Response } from 'playwright-core';
import type { TcgInterceptedData, TcgListing, TcgSalesBucket, TcgProductDetails } from './tcgplayer-types.js';

const LISTINGS_PATTERN = /mp-search-api\.tcgplayer\.com\/v1\/product\/\d+\/listings/i;
const SALES_PATTERN = /mpapi\.tcgplayer\.com\/v2\/product\/\d+\/latestsales/i;
const PRODUCT_PATTERN = /mp-search-api\.tcgplayer\.com\/v2\/product\/\d+\/details/i;
const PRICE_HISTORY_PATTERN = /infinite-api\.tcgplayer\.com\/price\/history\/\d+/i;

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
): { getInterceptedData: () => TcgInterceptedData; getObservedUrls: () => string[]; cleanup: () => Promise<void> } => {
    const collected: TcgInterceptedData = {
        listings: [],
        salesBuckets: [],
        productDetails: null,
    };
    const observedApiUrls: string[] = [];

    const handler = async (response: Response) => {
        const url = response.url();
        const status = response.status();
        if (status < 200 || status >= 300) return;

        try {
            if (/tcgplayer\.com/i.test(url) && !/\.(png|jpg|jpeg|gif|svg|woff|css)/.test(url)) {
                observedApiUrls.push(`[${status}] ${url.slice(0, 200)}`);
            }

            if (LISTINGS_PATTERN.test(url) && url.includes(String(productId))) {
                const body = await safeJson(response);
                const bodyKeys = body && typeof body === 'object' ? Object.keys(body as Record<string, unknown>).slice(0, 10) : [];
                log.info(`Intercepted listings API for product ${productId}`, { url: url.slice(0, 150), bodyKeys });
                const listings = parseListingsResponse(body);
                log.info(`Parsed ${listings.length} listings for product ${productId}`);
                if (listings.length > 0) {
                    collected.listings = listings;
                } else if (body) {
                    // Log a snippet of raw body to debug parsing
                    const snippet = JSON.stringify(body).slice(0, 500);
                    log.info(`Listings body snippet for ${productId}`, { snippet });
                }
            } else if (SALES_PATTERN.test(url) && url.includes(String(productId))) {
                const body = await safeJson(response);
                const bodyKeys = body && typeof body === 'object' ? Object.keys(body as Record<string, unknown>).slice(0, 10) : [];
                log.info(`Intercepted sales API for product ${productId}`, { url: url.slice(0, 150), bodyKeys });
                const buckets = parseSalesResponse(body);
                log.info(`Parsed ${buckets.length} sales buckets for product ${productId}`);
                if (buckets.length > 0) {
                    collected.salesBuckets = filterBucketsByWindow(buckets, salesWindowDays);
                } else if (body) {
                    const snippet = JSON.stringify(body).slice(0, 500);
                    log.info(`Sales body snippet for ${productId}`, { snippet });
                }
            } else if (PRODUCT_PATTERN.test(url) && url.includes(String(productId))) {
                const body = await safeJson(response);
                const bodyKeys = body && typeof body === 'object' ? Object.keys(body as Record<string, unknown>).slice(0, 10) : [];
                log.info(`Intercepted product details API for product ${productId}`, { url: url.slice(0, 150), bodyKeys });
                const details = parseProductResponse(body);
                if (details) {
                    log.info(`Parsed product details for ${productId}`, { details });
                    collected.productDetails = details;
                }
            } else if (PRICE_HISTORY_PATTERN.test(url) && url.includes(String(productId))) {
                const body = await safeJson(response);
                log.debug(`Intercepted price history for ${productId}`, { url, bodyKeys: body ? Object.keys(body as Record<string, unknown>) : [] });
                // Extract market/median price from price history if product details not yet captured
                if (!collected.productDetails && body && typeof body === 'object') {
                    const b = body as Record<string, unknown>;
                    const mp = Number(b.marketPrice ?? (b as any).result?.marketPrice);
                    const med = Number(b.medianPrice ?? (b as any).result?.medianPrice);
                    if (!isNaN(mp)) {
                        collected.productDetails = {
                            marketPrice: mp,
                            medianPrice: isNaN(med) ? null : med,
                            totalListings: 0,
                        };
                    }
                }
            }
        } catch (err) {
            log.debug(`Intercept handler error for ${url}`, { error: String(err) });
        }
    };

    page.on('response', handler);

    return {
        getInterceptedData: () => ({ ...collected }),
        getObservedUrls: () => [...observedApiUrls],
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
