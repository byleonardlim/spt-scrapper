export type CardFinish = 'nonfoil' | 'foil' | 'etched' | 'glossy' | 'textured';

export type FoilSubtype =
    | 'standard'
    | 'surge'
    | 'fractal'
    | 'galaxy'
    | 'rainbow'
    | 'wave'
    | 'step-and-compleat'
    | 'halo'
    | 'gilded'
    | 'confetti'
    | 'raised';

export type TcgVariantFrameStyle =
    | 'standard'
    | 'showcase'
    | 'borderless'
    | 'extended-art'
    | 'retro-frame'
    | 'full-art'
    | 'textless';

export type TcgVariantArtStyle =
    | 'standard'
    | 'alternate-art'
    | 'anime'
    | 'japan-showcase';

export type TcgVariantRarityStyle =
    | 'standard'
    | 'serialized'
    | 'stamped'
    | 'promo';

export type TcgVariantAttributes = {
    frameStyle: TcgVariantFrameStyle;
    artStyle: TcgVariantArtStyle;
    foilStyle: FoilSubtype | null;
    rarityStyle: TcgVariantRarityStyle;
    isSerialized: boolean;
    serialNumber: number | null;
    serialTotal: number | null;
};

export type ScryfallCardRaw = {
    id: string;
    name: string;
    set: string;
    set_name: string;
    collector_number: string;
    rarity: string;
    lang: string;
    tcgplayer_id?: number;
    tcgplayer_etched_id?: number;
    finishes?: string[];
    promo_types?: string[];
    frame_effects?: string[];
    security_stamp?: string;
};

export type ScryfallSeedCard = {
    scryfallId: string;
    sptId: string;
    name: string;
    setCode: string;
    setName: string;
    collectorNumber: string;
    rarity: string;
    language: string;
    finish: CardFinish;
    variantAttributes: TcgVariantAttributes;
    variantLabel: string;
    tcgplayerProductId: number;
};

export type TopListing = {
    listing_id: string;
    seller_name: string;
    seller_type: 'gold' | 'direct' | 'verified' | 'standard';
    seller_rating: number;
    seller_sales_count: number;
    condition: string;
    printing: string;
    quantity_available: number;
    price_base: number;
    price_shipping: number;
    price_landed: number;
};

export type SaleRecord = {
    sale_date: string;
    condition: string;
    printing: string;
    quantity_sold: number;
    sale_price_landed: number;
};

export type SptAnalyticsPreview = {
    wall_depth_10pct: number;
    sales_velocity_24h: number;
    liquidity_gap_ratio: number;
};

export type ScrapedRecord = {
    spt_id: string;
    tcgplayer_product_id: number;
    finish: CardFinish;
    variant_label: string;
    variant_attributes: TcgVariantAttributes;
    product_metadata: {
        spt_id: string;
        name: string;
        set_name: string;
        rarity_tier: string;
        tcg_market_price: number | null;
        tcg_median_price: number | null;
    };
    inventory_snapshot: {
        timestamp: string;
        total_active_listings: number;
        total_units_available: number;
        top_listings: TopListing[];
    };
    sales_pulse: {
        latest_sales_count: number;
        sales_history: SaleRecord[];
    };
    spt_analytics_preview: SptAnalyticsPreview;
};

export type ActorInput = {
    sets: string[];
    cardsPerSet: number;
    salesWindowDays: 30 | 90;
    topListingsCount: number;
    webhookUrl: string | null;
    webhookAuthToken: string | null;
    webhookDeliveryMode: 'batch' | 'per-record';
    maxConcurrency: number;
    delayBetweenRequestsMs: number;
    maxRetries: number;
    proxyConfiguration: {
        useApifyProxy: boolean;
        apifyProxyGroups: string[];
        apifyProxyCountry: string;
    } | null;
};

export const DEFAULT_INPUT: ActorInput = {
    sets: ['eoe', 'tmnt'],
    cardsPerSet: 50,
    salesWindowDays: 30,
    topListingsCount: 10,
    webhookUrl: null,
    webhookAuthToken: null,
    webhookDeliveryMode: 'batch',
    maxConcurrency: 3,
    delayBetweenRequestsMs: 1500,
    maxRetries: 3,
    proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'US',
    },
};
