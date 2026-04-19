import type {
    CardFinish,
    FoilSubtype,
    TcgVariantAttributes,
    TcgVariantArtStyle,
    TcgVariantFrameStyle,
    TcgVariantRarityStyle,
} from '../types.js';

type VariantInput = {
    finish: CardFinish;
    finishSubtype?: FoilSubtype | null;
    language?: string | null;
    scryfallFinishes?: string[] | null;
    scryfallPromoTypes?: string[] | null;
    scryfallFrameEffects?: string[] | null;
    scryfallSecurityStamp?: string | null;
};

const titleize = (value: string): string =>
    value
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');

const normalizeValues = (values?: string[] | null): string[] =>
    (values ?? []).map((v) => v.toLowerCase());

const hasToken = (values: string[] | null | undefined, tokens: string[]): boolean => {
    const normalized = normalizeValues(values);
    return tokens.some((token) => normalized.some((v) => v.includes(token)));
};

const detectFrameStyle = (
    frameEffects?: string[] | null,
    promoTypes?: string[] | null,
): TcgVariantFrameStyle => {
    if (hasToken(frameEffects, ['borderless'])) return 'borderless';
    if (hasToken(frameEffects, ['extendedart', 'extended'])) return 'extended-art';
    if (hasToken(frameEffects, ['showcase'])) return 'showcase';
    if (hasToken(frameEffects, ['retro', 'retroframe'])) return 'retro-frame';
    if (hasToken(frameEffects, ['textless']) || hasToken(promoTypes, ['textless'])) return 'textless';
    if (hasToken(frameEffects, ['fullart']) || hasToken(promoTypes, ['fullart'])) return 'full-art';
    return 'standard';
};

const detectArtStyle = (
    language?: string | null,
    frameEffects?: string[] | null,
    promoTypes?: string[] | null,
): TcgVariantArtStyle => {
    const lang = language?.toLowerCase() ?? '';
    if (hasToken(frameEffects, ['showcase']) && ['ja', 'jp'].includes(lang)) return 'japan-showcase';
    if (hasToken(promoTypes, ['japan', 'japanshowcase', 'jp-showcase'])) return 'japan-showcase';
    if (hasToken(promoTypes, ['anime']) || hasToken(frameEffects, ['anime'])) return 'anime';
    if (hasToken(promoTypes, ['alternate', 'alt-art', 'altart'])) return 'alternate-art';
    return 'standard';
};

const detectFoilStyle = (
    finish: CardFinish,
    finishSubtype?: FoilSubtype | null,
    scryfallFinishes?: string[] | null,
    promoTypes?: string[] | null,
    securityStamp?: string | null,
): FoilSubtype | null => {
    if (finish !== 'foil') return null;
    if (finishSubtype) return finishSubtype;
    if (hasToken(promoTypes, ['surge'])) return 'surge';
    if (hasToken(promoTypes, ['fractal'])) return 'fractal';
    if (hasToken(promoTypes, ['galaxy'])) return 'galaxy';
    if (hasToken(promoTypes, ['rainbow'])) return 'rainbow';
    if (hasToken(promoTypes, ['wave'])) return 'wave';
    if (hasToken(promoTypes, ['halo'])) return 'halo';
    if (hasToken(promoTypes, ['gilded'])) return 'gilded';
    if (hasToken(promoTypes, ['confetti'])) return 'confetti';
    if (hasToken(promoTypes, ['raised'])) return 'raised';
    if (hasToken(scryfallFinishes, ['step-and-compleat'])) return 'step-and-compleat';
    if (hasToken(scryfallFinishes, ['fractal'])) return 'fractal';
    if (hasToken(scryfallFinishes, ['surge'])) return 'surge';
    if (hasToken(scryfallFinishes, ['galaxy'])) return 'galaxy';
    if (hasToken(scryfallFinishes, ['rainbow'])) return 'rainbow';
    if (hasToken(scryfallFinishes, ['wave'])) return 'wave';
    if ((securityStamp ?? '').toLowerCase().includes('triangle')) return 'halo';
    return 'standard';
};

const detectRarityStyle = (
    promoTypes?: string[] | null,
    securityStamp?: string | null,
): TcgVariantRarityStyle => {
    if (hasToken(promoTypes, ['serialized'])) return 'serialized';
    if (hasToken(promoTypes, ['stamped', 'stamp'])) return 'stamped';
    if (hasToken(promoTypes, ['promo']) || Boolean(securityStamp)) return 'promo';
    return 'standard';
};

export const deriveVariantAttributes = (input: VariantInput): TcgVariantAttributes => {
    const frameStyle = detectFrameStyle(input.scryfallFrameEffects, input.scryfallPromoTypes);
    const artStyle = detectArtStyle(input.language, input.scryfallFrameEffects, input.scryfallPromoTypes);
    const foilStyle = detectFoilStyle(
        input.finish,
        input.finishSubtype ?? null,
        input.scryfallFinishes,
        input.scryfallPromoTypes,
        input.scryfallSecurityStamp,
    );
    const rarityStyle = detectRarityStyle(input.scryfallPromoTypes, input.scryfallSecurityStamp);
    const isSerialized = rarityStyle === 'serialized';

    return {
        frameStyle,
        artStyle,
        foilStyle,
        rarityStyle,
        isSerialized,
        serialNumber: null,
        serialTotal: null,
    };
};

const specialParts = (attrs: TcgVariantAttributes): string[] => {
    const parts: string[] = [];
    if (attrs.artStyle === 'japan-showcase') {
        parts.push('Japan Showcase');
    } else if (attrs.artStyle && attrs.artStyle !== 'standard') {
        parts.push(titleize(attrs.artStyle));
    }
    if (
        attrs.frameStyle &&
        attrs.frameStyle !== 'standard' &&
        !(attrs.frameStyle === 'showcase' && parts.some((p) => p.includes('Showcase')))
    ) {
        parts.push(titleize(attrs.frameStyle));
    }
    if (attrs.rarityStyle && attrs.rarityStyle !== 'standard' && attrs.rarityStyle !== 'serialized') {
        parts.push(titleize(attrs.rarityStyle));
    }
    if (attrs.isSerialized || attrs.rarityStyle === 'serialized') {
        parts.push('Serialized');
    }
    if (attrs.foilStyle && attrs.foilStyle !== 'standard') {
        parts.push(titleize(attrs.foilStyle));
    }
    return [...new Set(parts)];
};

const FINISH_LABELS: Record<string, string> = {
    nonfoil: 'Standard',
    foil: 'Foil',
    etched: 'Etched',
    glossy: 'Glossy',
    textured: 'Textured',
};

const finishLabel = (finish: CardFinish): string =>
    FINISH_LABELS[finish] ?? titleize(finish);

export const buildVariantLabel = (input: VariantInput): string => {
    const attrs = deriveVariantAttributes(input);
    const parts = specialParts(attrs);
    if (parts.length === 0) return finishLabel(input.finish);
    parts.push(finishLabel(input.finish));
    return parts.join(' ');
};

export const resolveFinishFromScryfall = (finishes?: string[] | null): CardFinish => {
    const f = (finishes ?? []).map((v) => v.toLowerCase());
    if (f.includes('etched')) return 'etched';
    if (f.includes('foil')) return 'foil';
    return 'nonfoil';
};
