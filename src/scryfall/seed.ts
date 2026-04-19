import { log } from 'apify';
import { gotScraping } from 'got-scraping';
import type { ActorInput, ScryfallCardRaw, ScryfallSeedCard, CardFinish } from '../types.js';
import { deriveVariantAttributes, buildVariantLabel } from '../utils/variant.js';

const SCRYFALL_API = 'https://api.scryfall.com';
const RATE_LIMIT_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type ScryfallSearchResponse = {
    object: string;
    total_cards: number;
    has_more: boolean;
    next_page?: string;
    data: ScryfallCardRaw[];
};

const fetchSetPage = async (url: string): Promise<ScryfallSearchResponse> => {
    const response = await gotScraping.get(url, {
        responseType: 'json',
        headers: {
            Accept: 'application/json',
            'User-Agent': 'SPT-Apify-Actor/1.0',
        },
    });
    return response.body as ScryfallSearchResponse;
};

const fetchSetCards = async (setCode: string, limit: number): Promise<ScryfallCardRaw[]> => {
    const collected: ScryfallCardRaw[] = [];
    let url: string | undefined =
        `${SCRYFALL_API}/cards/search?q=set:${encodeURIComponent(setCode)}&unique=prints&order=collector_number&page=1`;

    while (url && collected.length < limit) {
        log.debug(`Fetching Scryfall page: ${url}`);
        const page = await fetchSetPage(url);

        for (const card of page.data) {
            if (collected.length >= limit) break;
            if (!card.tcgplayer_id) {
                log.debug(`Skipping card without tcgplayer_id: ${card.name} (${card.set}-${card.collector_number})`);
                continue;
            }
            collected.push(card);
        }

        url = page.has_more && collected.length < limit ? page.next_page : undefined;
        if (url) await sleep(RATE_LIMIT_MS);
    }

    return collected;
};

const FINISHES_TO_SEED: CardFinish[] = ['nonfoil', 'foil', 'glossy', 'textured'];

const cardToSeedEntries = (card: ScryfallCardRaw): ScryfallSeedCard[] => {
    if (!card.tcgplayer_id) return [];

    const entries: ScryfallSeedCard[] = [];
    const scryfallFinishes = card.finishes ?? [];

    // Generate a seed for each finish type that exists on this card (excluding etched)
    for (const finish of FINISHES_TO_SEED) {
        // Skip if this finish isn't in Scryfall's finishes array
        if (!scryfallFinishes.includes(finish)) continue;

        const variantAttributes = deriveVariantAttributes({
            finish,
            language: card.lang,
            scryfallFinishes: card.finishes ?? null,
            scryfallPromoTypes: card.promo_types ?? null,
            scryfallFrameEffects: card.frame_effects ?? null,
            scryfallSecurityStamp: card.security_stamp ?? null,
        });
        const variantLabel = buildVariantLabel({
            finish,
            language: card.lang,
            scryfallFinishes: card.finishes ?? null,
            scryfallPromoTypes: card.promo_types ?? null,
            scryfallFrameEffects: card.frame_effects ?? null,
            scryfallSecurityStamp: card.security_stamp ?? null,
        });

        entries.push({
            scryfallId: card.id,
            sptId: `${card.set}-${card.collector_number}`,
            name: card.name,
            setCode: card.set,
            setName: card.set_name,
            collectorNumber: card.collector_number,
            rarity: card.rarity,
            language: card.lang,
            finish,
            variantAttributes,
            variantLabel,
            tcgplayerProductId: card.tcgplayer_id,
        });
    }

    return entries;
};

const etchedCardToSeedEntry = (card: ScryfallCardRaw): ScryfallSeedCard | null => {
    if (!card.tcgplayer_etched_id) return null;

    const variantAttributes = deriveVariantAttributes({
        finish: 'etched',
        language: card.lang,
        scryfallFinishes: ['etched'],
        scryfallPromoTypes: card.promo_types ?? null,
        scryfallFrameEffects: card.frame_effects ?? null,
        scryfallSecurityStamp: card.security_stamp ?? null,
    });
    const variantLabel = buildVariantLabel({
        finish: 'etched',
        language: card.lang,
        scryfallFinishes: ['etched'],
        scryfallPromoTypes: card.promo_types ?? null,
        scryfallFrameEffects: card.frame_effects ?? null,
        scryfallSecurityStamp: card.security_stamp ?? null,
    });

    return {
        scryfallId: card.id,
        sptId: `${card.set}-${card.collector_number}`,
        name: card.name,
        setCode: card.set,
        setName: card.set_name,
        collectorNumber: card.collector_number,
        rarity: card.rarity,
        language: card.lang,
        finish: 'etched',
        variantAttributes,
        variantLabel,
        tcgplayerProductId: card.tcgplayer_etched_id,
    };
};

export const seedScryfall = async (input: ActorInput): Promise<ScryfallSeedCard[]> => {
    const allSeeds: ScryfallSeedCard[] = [];

    for (const setCode of input.sets) {
        log.info(`Fetching Scryfall cards for set: ${setCode}`);
        const cards = await fetchSetCards(setCode, input.cardsPerSet);
        log.info(`Set ${setCode}: ${cards.length} prints found`);

        for (const card of cards) {
            const seeds = cardToSeedEntries(card);
            allSeeds.push(...seeds);

            const etchedSeed = etchedCardToSeedEntry(card);
            if (etchedSeed) allSeeds.push(etchedSeed);
        }

        await sleep(RATE_LIMIT_MS);
    }

    log.info(`Total seed entries: ${allSeeds.length}`);
    return allSeeds;
};
