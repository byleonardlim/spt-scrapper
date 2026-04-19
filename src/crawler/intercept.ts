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

export const parseListingsResponse = (body: unknown): TcgListing[] => {
    if (!body || typeof body !== 'object') return [];
    const b = body as Record<string, unknown>;

    // TCGPlayer listings API returns: {errors:[], results:[{totalResults, aggregations, results:[...listings...]}]}
    // The actual listing items are nested inside results[0].results or results[0].listings
    let items: Record<string, unknown>[] = [];

    const topResults = b.results;
    if (Array.isArray(topResults) && topResults.length > 0) {
        const first = topResults[0] as Record<string, unknown>;
        // Nested results array inside the first result object
        const nested = first.results ?? first.listings ?? first.data;
        if (Array.isArray(nested) && nested.length > 0) {
            items = nested as Record<string, unknown>[];
        }
    }

    // Fallback: maybe body itself has listings/data at top level
    if (items.length === 0) {
        const fallback = b.listings ?? b.data;
        if (Array.isArray(fallback)) items = fallback as Record<string, unknown>[];
    }

    if (items.length === 0) return [];

    return items.map((r): TcgListing | null => {
        // TCGPlayer listing fields: sellerKey, condition, printing, price/directPrice,
        // quantity, sellerName, goldStar, directSeller, verifiedSeller, sellerShippingPrice, etc.
        const price = Number(r.price ?? r.directLowPrice ?? r.listingPrice ?? 0);
        if (price <= 0) return null;
        return {
            listingId: String(r.listingId ?? r.listing_id ?? r.sellerListingId ?? ''),
            price,
            shippingPrice: Number(r.shippingPrice ?? r.sellerShippingPrice ?? r.shipping_price ?? 0),
            condition: String(r.condition ?? 'Unknown'),
            printing: String(r.printing ?? r.variant ?? r.printing_name ?? 'Normal'),
            quantity: parseInt(String(r.quantity ?? 1), 10),
            sellerName: String(r.sellerName ?? r.seller_name ?? r.sellerKey ?? ''),
            goldSeller: Boolean(r.goldSeller ?? r.goldStar ?? r.gold_seller ?? false),
            directSeller: Boolean(r.directSeller ?? r.direct_seller ?? r.isDirect ?? false),
            verifiedSeller: Boolean(r.verifiedSeller ?? r.verified_seller ?? r.isVerified ?? false),
            sellerRating: Number(r.sellerRating ?? r.seller_rating ?? r.sellerFeedbackRating ?? 0),
            sellerSales: String(r.sellerSales ?? r.seller_sales ?? r.sellerFeedbackCount ?? '0'),
        };
    }).filter((l): l is TcgListing => l !== null);
};

const parseSalesResponse = (body: unknown): TcgSalesBucket[] => {
    if (!body || typeof body !== 'object') return [];
    const b = body as Record<string, unknown>;

    // TCGPlayer latestsales API returns: {data:[{condition, variant, purchasePrice, shippingPrice, orderDate, quantity, ...}]}
    // These are individual sale transactions, not pre-aggregated buckets.
    const rawItems =
        b.data ??
        (Array.isArray(b.results) ? (b.results[0] as Record<string, unknown>)?.data : undefined) ??
        b.buckets ??
        b.results ??
        [];

    if (!Array.isArray(rawItems)) return [];

    return rawItems
        .map((r: Record<string, unknown>): TcgSalesBucket | null => {
            // Map individual sale transaction fields to our bucket format
            const marketPrice = Number(
                r.purchasePrice ?? r.marketPrice ?? r.market_price ?? r.price,
            );
            const bucketStartDate = String(
                r.orderDate ?? r.bucketStartDate ?? r.bucket_start_date ?? r.date ?? '',
            );
            if (!bucketStartDate || isNaN(marketPrice)) return null;
            return {
                bucketStartDate,
                quantitySold: parseInt(String(r.quantity ?? r.quantitySold ?? r.quantity_sold ?? 1), 10),
                marketPrice,
                condition: r.condition ? String(r.condition) : undefined,
                printing: r.printing ?? r.variant ? String(r.printing ?? r.variant) : undefined,
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
        totalListings: parseInt(String(r.totalListings ?? r.total_listings ?? r.listingsCount ?? 0), 10),
    };
};

export const setupInterception = (
    page: Page,
    productId: number,
    salesWindowDays: number,
): { getInterceptedData: () => TcgInterceptedData; getObservedUrls: () => string[]; getListingsApiUrl: () => string | null; getListingsApiHeaders: () => Record<string, string>; getListingsApiMethod: () => string; getListingsApiPostData: () => string | null; collected: TcgInterceptedData; cleanup: () => Promise<void> } => {
    const collected: TcgInterceptedData = {
        listings: [],
        salesBuckets: [],
        productDetails: null,
    };
    const observedApiUrls: string[] = [];
    let listingsSnippetLogged = false;
    let listingsApiUrl: string | null = null;
    let listingsApiHeaders: Record<string, string> = {};
    let listingsApiMethod: string = 'GET';
    let listingsApiPostData: string | null = null;

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
                const listings = parseListingsResponse(body);

                // Extract totalResults from listings API (the real total listing count)
                if (body && typeof body === 'object') {
                    const b = body as Record<string, unknown>;
                    const r0 = Array.isArray(b.results) && b.results[0] ? b.results[0] as Record<string, unknown> : null;
                    const total = Number(r0?.totalResults ?? r0?.totalListings ?? 0);
                    if (total > 0 && collected.productDetails) {
                        collected.productDetails.totalListings = total;
                    } else if (total > 0 && !collected.productDetails) {
                        collected.productDetails = { marketPrice: null, medianPrice: null, totalListings: total };
                    }
                }

                if (listings.length > 0) {
                    // Capture request details from the call that actually returns listings
                    // (not from aggregation-only calls which have a different POST body)
                    if (!listingsApiUrl) {
                        listingsApiUrl = url;
                        try {
                            const req = response.request();
                            listingsApiHeaders = await req.allHeaders();
                            listingsApiMethod = req.method();
                            listingsApiPostData = req.postData() ?? null;
                            log.info(`Product ${productId}: captured listings API`, {
                                method: listingsApiMethod,
                                hasPostData: Boolean(listingsApiPostData),
                                postDataKeys: listingsApiPostData ? Object.keys(JSON.parse(listingsApiPostData)).slice(0, 15) : [],
                            });
                        } catch { /* ignore */ }
                    }
                    // Accumulate listings across multiple API responses, dedup by listingId
                    const existingIds = new Set(collected.listings.map((l) => l.listingId));
                    const newItems = listings.filter((l) => !existingIds.has(l.listingId));
                    collected.listings.push(...newItems);
                    log.info(`Product ${productId}: +${newItems.length} listings (total: ${collected.listings.length})`);
                } else if (body && !listingsSnippetLogged) {
                    // Log results[0] keys once to discover the field containing listing items
                    const b = body as Record<string, unknown>;
                    const r0 = Array.isArray(b.results) && b.results[0] ? b.results[0] as Record<string, unknown> : null;
                    const r0Keys = r0 ? Object.keys(r0) : [];
                    log.debug(`Listings API (no items) for ${productId}`, { r0Keys });
                    listingsSnippetLogged = true;
                }
            } else if (SALES_PATTERN.test(url) && url.includes(String(productId))) {
                const body = await safeJson(response);
                const buckets = parseSalesResponse(body);
                if (buckets.length > 0) {
                    // Accumulate sales across multiple responses, dedup by orderDate+price
                    const existingKeys = new Set(collected.salesBuckets.map((b) => `${b.bucketStartDate}|${b.marketPrice}`));
                    const newBuckets = filterBucketsByWindow(buckets, salesWindowDays)
                        .filter((b) => !existingKeys.has(`${b.bucketStartDate}|${b.marketPrice}`));
                    collected.salesBuckets.push(...newBuckets);
                    log.info(`Product ${productId}: +${newBuckets.length} sales (total: ${collected.salesBuckets.length})`);
                }
            } else if (PRODUCT_PATTERN.test(url) && url.includes(String(productId))) {
                const body = await safeJson(response);
                const details = parseProductResponse(body);
                if (details) {
                    log.info(`Product ${productId} details`, { market: details.marketPrice, median: details.medianPrice });
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
        getInterceptedData: () => ({
            listings: [...collected.listings],
            salesBuckets: [...collected.salesBuckets],
            productDetails: collected.productDetails,
        }),
        getObservedUrls: () => [...observedApiUrls],
        getListingsApiUrl: () => listingsApiUrl,
        getListingsApiHeaders: () => ({ ...listingsApiHeaders }),
        getListingsApiMethod: () => listingsApiMethod,
        getListingsApiPostData: () => listingsApiPostData,
        collected,
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
