import { Actor, log } from 'apify';
import { DEFAULT_INPUT, type ActorInput, type ScrapedRecord } from './types.js';

Actor.main(async () => {
    const rawInput = (await Actor.getInput<Partial<ActorInput>>()) ?? {};
    const input: ActorInput = { ...DEFAULT_INPUT, ...rawInput };

    log.info('Actor started', {
        sets: input.sets,
        cardsPerSet: input.cardsPerSet,
        salesWindowDays: input.salesWindowDays,
        topListingsCount: input.topListingsCount,
        webhookDeliveryMode: input.webhookDeliveryMode,
        hasWebhook: Boolean(input.webhookUrl),
    });

    const { seedScryfall } = await import('./scryfall/seed.js');
    const { runCrawler } = await import('./crawler/index.js');
    const { deliverResults } = await import('./output/deliver.js');

    log.info('Phase 1: Seeding card list from Scryfall...');
    const seedCards = await seedScryfall(input);
    log.info(`Scryfall seed complete — ${seedCards.length} print variants queued`);

    log.info('Phase 2: Crawling TCGPlayer...');
    const results: ScrapedRecord[] = await runCrawler(seedCards, input);
    log.info(`Crawl complete — ${results.length} records scraped`);

    log.info('Phase 3: Delivering results...');
    await deliverResults(results, input);
    log.info('Actor finished successfully');
});
