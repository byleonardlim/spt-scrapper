export type TcgListing = {
    listingId: number | string;
    price: number;
    shippingPrice: number;
    condition: string;
    printing: string;
    quantity: number;
    sellerName: string;
    goldSeller: boolean;
    directSeller: boolean;
    verifiedSeller: boolean;
    sellerRating: number;
    sellerSales: string | number;
};

export type TcgSalesBucket = {
    bucketStartDate: string;
    quantitySold: number;
    marketPrice: number;
    condition?: string;
    printing?: string;
};

export type TcgProductDetails = {
    marketPrice: number | null;
    medianPrice: number | null;
    totalListings: number;
};

export type TcgInterceptedData = {
    listings: TcgListing[];
    salesBuckets: TcgSalesBucket[];
    productDetails: TcgProductDetails | null;
};
