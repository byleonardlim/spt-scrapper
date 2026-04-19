import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestQueue, KeyValueStore } from 'crawlee';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { ActorInput, ScrapedRecord, ScryfallSeedCard } from '../types.js';
import type { TcgInterceptedData } from './tcgplayer-types.js';
import { setupInterception, parseListingsResponse } from './intercept.js';
import { extractFromSsrState, extractFromDom, mergeInterceptedData } from './extract.js';
import { buildRecord } from './record-builder.js';

chromium.use(StealthPlugin());

const JITTER_EXTRA_MS = 2000;
const DATADOME_PATTERNS = ['datadome', 'blocked', 'captcha', 'interstitial'];
const HYDRATION_TIMEOUT_MS = 15_000;
const PRODUCT_SELECTORS = [
    'section.product-details__listings-total',
    'div.marketPrice',
    'table.near-mint-table',
    'section.spotlight__seller',
    '.top-listing-price',
    '.marketplace',
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const randomJitter = (baseMs: number): number =>
    baseMs + Math.floor(Math.random() * JITTER_EXTRA_MS);

const isDataDomeBlock = async (page: import('playwright-core').Page): Promise<boolean> => {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const cookies = await page.context().cookies();
    const hasDataDomeCookie = cookies.some((c) => c.name.toLowerCase().includes('datadome'));
    const titleBlocked = DATADOME_PATTERNS.some((p) => title.toLowerCase().includes(p));
    const urlBlocked = DATADOME_PATTERNS.some((p) => url.toLowerCase().includes(p));
    return (titleBlocked || urlBlocked) && hasDataDomeCookie;
};

const isSoftBlock = async (page: import('playwright-core').Page): Promise<boolean> => {
    const hasNextData = await page.evaluate(() => {
        return document.getElementById('__NEXT_DATA__')?.textContent?.length ?? 0;
    }).catch(() => 0);
    if (hasNextData > 100) return false;

    const bodyLen = await page.evaluate(() => {
        return document.body?.innerText?.trim().length ?? 0;
    }).catch(() => 0);

    const title = await page.title().catch(() => '');
    const isGenericTitle = title.toLowerCase().includes('trusted marketplace') ||
        title.toLowerCase().includes('tcgplayer') && !title.includes('|');

    return bodyLen < 50 && isGenericTitle;
};

const waitForHydration = async (page: import('playwright-core').Page): Promise<boolean> => {
    const selectorPromise = page.waitForSelector(
        PRODUCT_SELECTORS.join(', '),
        { timeout: HYDRATION_TIMEOUT_MS },
    ).then(() => true).catch(() => false);

    const nextDataPromise = page.waitForFunction(
        () => {
            const el = document.getElementById('__NEXT_DATA__');
            return el?.textContent && el.textContent.length > 100;
        },
        { timeout: HYDRATION_TIMEOUT_MS },
    ).then(() => true).catch(() => false);

    const results = await Promise.allSettled([selectorPromise, nextDataPromise]);
    return results.some((r) => r.status === 'fulfilled' && r.value === true);
};

export const runCrawler = async (
    seedCards: ScryfallSeedCard[],
    input: ActorInput,
): Promise<ScrapedRecord[]> => {
    const results: ScrapedRecord[] = [];
    const seedMap = new Map<string, ScryfallSeedCard>(
        seedCards.map((c) => [String(c.tcgplayerProductId), c]),
    );

    const proxyConfiguration = input.proxyConfiguration?.useApifyProxy
        ? await Actor.createProxyConfiguration({
              groups: input.proxyConfiguration.apifyProxyGroups,
              countryCode: input.proxyConfiguration.apifyProxyCountry,
          })
        : undefined;

    const requestQueue = await RequestQueue.open();
    for (const card of seedCards) {
        await requestQueue.addRequest({
            url: `https://www.tcgplayer.com/product/${card.tcgplayerProductId}/`,
            uniqueKey: String(card.tcgplayerProductId),
            userData: { productId: card.tcgplayerProductId },
        });
    }

    const crawler = new PlaywrightCrawler({
        requestQueue,
        launchContext: {
            launcher: chromium as unknown as typeof import('playwright-core').chromium,
            launchOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                ],
            },
        },
        proxyConfiguration,
        maxConcurrency: Math.min(input.maxConcurrency, 1),
        maxRequestRetries: input.maxRetries,
        requestHandlerTimeoutSecs: 180,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, request, session }) {
            const productId = request.userData['productId'] as number;
            const seed = seedMap.get(String(productId));
            if (!seed) {
                log.warning(`No seed card found for productId ${productId}`);
                return;
            }

            log.info(`Scraping product ${productId} — ${seed.name} [${seed.variantLabel}]`);

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            });

            const { getInterceptedData, collected, getListingsApiUrl, getListingsApiHeaders, getListingsApiMethod, getListingsApiPostData, cleanup } = setupInterception(page, productId, input.salesWindowDays);

            try {
                // Phase A: Navigate with domcontentloaded (don't wait for networkidle)
                await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

                // Phase B: Check for hard DataDome block (captcha/interstitial redirect)
                if (await isDataDomeBlock(page)) {
                    log.warning(`Product ${productId} — hard DataDome block, retiring session`);
                    session?.retire();
                    throw new Error('DataDome hard block');
                }

                // Phase C: Wait for page hydration (product content or __NEXT_DATA__)
                log.info(`Product ${productId} — waiting for hydration...`);
                const hydrated = await waitForHydration(page);

                if (!hydrated) {
                    // Give DataDome JS challenge extra time to resolve
                    log.info(`Product ${productId} — hydration timeout, waiting extra 5s for DataDome challenge...`);
                    await sleep(5000);
                }

                // Phase D: Soft block detection — empty shell = DataDome silent block
                if (await isSoftBlock(page)) {
                    log.warning(`Product ${productId} — soft block detected (empty shell page), retiring session`);

                    // Save diagnostic screenshot before retiring
                    try {
                        const screenshotBuffer = await page.screenshot({ fullPage: false });
                        const kvStore = await KeyValueStore.open();
                        await kvStore.setValue(`diag-softblock-${productId}`, screenshotBuffer, { contentType: 'image/png' });
                    } catch { /* ignore */ }

                    session?.retire();
                    throw new Error('DataDome soft block — empty shell page');
                }

                // Phase E: Small jitter before extraction
                await sleep(randomJitter(500));

                // Phase F: Paginate listings API if we need more
                const targetListings = input.topListingsCount;
                const listingsApiUrl = getListingsApiUrl();
                const PAGE_SIZE = 10;
                const MAX_PAGES = 5;

                if (collected.listings.length < targetListings && listingsApiUrl) {
                    const method = getListingsApiMethod();
                    const originalPostData = getListingsApiPostData();
                    const apiHeaders = getListingsApiHeaders();
                    // Remove HTTP/2 pseudo-headers and headers that shouldn't be forwarded
                    for (const key of Object.keys(apiHeaders)) {
                        if (key.startsWith(':') || key === 'host' || key === 'content-length') {
                            delete apiHeaders[key];
                        }
                    }

                    log.info(`Product ${productId}: have ${collected.listings.length}/${targetListings} listings, paginating API (${method})...`);

                    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
                        if (collected.listings.length >= targetListings) break;

                        const offset = pageNum * PAGE_SIZE;

                        try {
                            let apiResponse;

                            if (method === 'POST' && originalPostData) {
                                // Modify the POST body — TCGPlayer uses Elasticsearch from/size
                                let postBody: Record<string, unknown> = {};
                                try { postBody = JSON.parse(originalPostData); } catch { /* use empty */ }
                                postBody.from = offset;
                                postBody.size = PAGE_SIZE;

                                apiResponse = await page.context().request.post(listingsApiUrl, {
                                    headers: apiHeaders,
                                    data: postBody,
                                });
                            } else {
                                // GET with query params
                                const fetchUrl = new URL(listingsApiUrl);
                                fetchUrl.searchParams.set('offset', String(offset));
                                fetchUrl.searchParams.set('limit', String(PAGE_SIZE));

                                apiResponse = await page.context().request.get(fetchUrl.toString(), {
                                    headers: apiHeaders,
                                });
                            }

                            if (!apiResponse.ok()) {
                                log.info(`Product ${productId}: page ${pageNum + 1} returned ${apiResponse.status()}, stopping`);
                                break;
                            }

                            const body = await apiResponse.json();
                            const listings = parseListingsResponse(body);
                            if (listings.length > 0) {
                                const existingIds = new Set(collected.listings.map((l) => l.listingId));
                                const newItems = listings.filter((l) => !existingIds.has(l.listingId));
                                collected.listings.push(...newItems);
                                log.info(`Product ${productId}: page ${pageNum + 1} → +${newItems.length} listings (total: ${collected.listings.length})`);
                            } else {
                                log.info(`Product ${productId}: page ${pageNum + 1} returned 0 listings, stopping`);
                                break;
                            }
                        } catch (err) {
                            log.info(`Product ${productId}: pagination failed at page ${pageNum + 1}`, { error: String(err) });
                            break;
                        }

                        await sleep(randomJitter(300));
                    }
                }

                const intercepted = getInterceptedData();
                const ssr = await extractFromSsrState(page);
                const dom =
                    intercepted.listings.length === 0 && intercepted.salesBuckets.length === 0
                        ? await extractFromDom(page)
                        : null;

                const merged: TcgInterceptedData = mergeInterceptedData(
                    intercepted.listings.length > 0 || intercepted.salesBuckets.length > 0 ? intercepted : null,
                    ssr,
                    dom,
                );

                log.info(`Product ${productId} extracted`, {
                    listings: merged.listings.length,
                    buckets: merged.salesBuckets.length,
                    hasProductDetails: Boolean(merged.productDetails),
                });

                // --- Diagnostic: screenshot on zero data (passed soft-block but still empty) ---
                if (merged.listings.length === 0 && merged.salesBuckets.length === 0 && !merged.productDetails) {
                    log.warning(`Product ${productId} ZERO DATA — page loaded but no data found`);
                    try {
                        const screenshotBuffer = await page.screenshot({ fullPage: false });
                        const kvStore = await KeyValueStore.open();
                        await kvStore.setValue(`diag-nodata-${productId}`, screenshotBuffer, { contentType: 'image/png' });
                    } catch { /* ignore */ }
                }

                const record = buildRecord(seed, merged, input);
                results.push(record);

                if (input.webhookDeliveryMode === 'per-record') {
                    const { deliverResults } = await import('../output/deliver.js');
                    await deliverResults([record], input);
                }

            } finally {
                await cleanup();
                await sleep(randomJitter(input.delayBetweenRequestsMs));
            }
        },
        async failedRequestHandler({ request }) {
            log.error(`Failed to scrape product ${request.userData['productId']}`, {
                url: request.url,
                retryCount: request.retryCount,
            });
        },
    });

    await crawler.run();
    return results;
};
