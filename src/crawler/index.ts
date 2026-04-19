import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestQueue } from 'crawlee';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { ActorInput, ScrapedRecord, ScryfallSeedCard } from '../types.js';
import type { TcgInterceptedData } from './tcgplayer-types.js';
import { setupInterception } from './intercept.js';
import { extractFromSsrState, extractFromDom, mergeInterceptedData } from './extract.js';
import { buildRecord } from './record-builder.js';

chromium.use(StealthPlugin());

const JITTER_EXTRA_MS = 2000;
const DATADOME_PATTERNS = ['datadome', 'blocked', 'captcha', 'interstitial'];

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
        maxConcurrency: input.maxConcurrency,
        maxRequestRetries: input.maxRetries,
        requestHandlerTimeoutSecs: 120,
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

            const { getInterceptedData, cleanup } = setupInterception(page, productId, input.salesWindowDays);

            try {
                await page.goto(request.url, { waitUntil: 'networkidle', timeout: 90_000 });

                if (await isDataDomeBlock(page)) {
                    log.warning(`DataDome block detected for product ${productId} — retiring session`);
                    session?.retire();
                    throw new Error('DataDome block detected');
                }

                await sleep(randomJitter(500));

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
