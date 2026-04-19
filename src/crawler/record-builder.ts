import type { ActorInput, ScrapedRecord, TopListing, SaleRecord, SptAnalyticsPreview } from '../types.js';
import type { ScryfallSeedCard } from '../types.js';
import type { TcgInterceptedData, TcgListing, TcgSalesBucket } from './tcgplayer-types.js';

const deriveSellerType = (listing: TcgListing): TopListing['seller_type'] => {
    if (listing.goldSeller) return 'gold';
    if (listing.directSeller) return 'direct';
    if (listing.verifiedSeller) return 'verified';
    return 'standard';
};

const buildTopListings = (listings: TcgListing[], count: number): TopListing[] => {
    return listings
        .slice(0, count)
        .map((l): TopListing => ({
            listing_id: String(l.listingId),
            seller_name: l.sellerName,
            seller_type: deriveSellerType(l),
            seller_rating: l.sellerRating,
            seller_sales_count: parseInt(String(l.sellerSales), 10) || 0,
            condition: l.condition,
            printing: l.printing,
            quantity_available: l.quantity,
            price_base: l.price,
            price_shipping: l.shippingPrice,
            price_landed: Number((l.price + l.shippingPrice).toFixed(2)),
        }));
};

const buildSalesHistory = (buckets: TcgSalesBucket[]): SaleRecord[] => {
    return buckets
        .sort((a, b) => new Date(b.bucketStartDate).getTime() - new Date(a.bucketStartDate).getTime())
        .map((b): SaleRecord => ({
            sale_date: b.bucketStartDate,
            condition: b.condition ?? 'All',
            printing: b.printing ?? 'All',
            quantity_sold: b.quantitySold,
            sale_price_landed: b.marketPrice,
        }));
};

const computeAnalytics = (
    listings: TopListing[],
    salesHistory: SaleRecord[],
    salesWindowDays: number,
): SptAnalyticsPreview => {
    if (listings.length === 0) {
        return { wall_depth_10pct: 0, sales_velocity_24h: 0, liquidity_gap_ratio: 0 };
    }

    const sorted = [...listings].sort((a, b) => a.price_landed - b.price_landed);
    const lowestPrice = sorted[0]?.price_landed ?? 0;
    const wallThreshold = lowestPrice * 1.1;
    const wall_depth_10pct = sorted.filter((l) => l.price_landed <= wallThreshold).length;

    const totalSold = salesHistory.reduce((sum, s) => sum + s.quantity_sold, 0);
    const sales_velocity_24h = salesWindowDays > 0
        ? Number((totalSold / salesWindowDays).toFixed(2))
        : 0;

    const secondLowest = sorted[1];
    const liquidity_gap_ratio =
        lowestPrice > 0 && secondLowest
            ? Number(((secondLowest.price_landed - lowestPrice) / lowestPrice).toFixed(4))
            : 0;

    return { wall_depth_10pct, sales_velocity_24h, liquidity_gap_ratio };
};

export const buildRecord = (
    seed: ScryfallSeedCard,
    data: TcgInterceptedData,
    input: ActorInput,
): ScrapedRecord => {
    const topListings = buildTopListings(data.listings, input.topListingsCount);
    const salesHistory = buildSalesHistory(data.salesBuckets);
    const analytics = computeAnalytics(topListings, salesHistory, input.salesWindowDays);

    const totalUnitsAvailable = data.listings.reduce((sum, l) => sum + l.quantity, 0);

    return {
        spt_id: seed.sptId,
        tcgplayer_product_id: seed.tcgplayerProductId,
        finish: seed.finish,
        variant_label: seed.variantLabel,
        variant_attributes: seed.variantAttributes,
        product_metadata: {
            spt_id: seed.sptId,
            name: seed.name,
            set_name: seed.setName,
            rarity_tier: seed.rarity,
            tcg_market_price: data.productDetails?.marketPrice ?? null,
            tcg_median_price: data.productDetails?.medianPrice ?? null,
        },
        inventory_snapshot: {
            timestamp: new Date().toISOString(),
            total_active_listings: data.productDetails?.totalListings || data.listings.length,
            total_units_available: totalUnitsAvailable,
            top_listings: topListings,
        },
        sales_pulse: {
            latest_sales_count: salesHistory.length,
            sales_history: salesHistory,
        },
        spt_analytics_preview: analytics,
    };
};
