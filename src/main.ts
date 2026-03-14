import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { gotScraping } from 'crawlee';

log.setLevel(log.LEVELS.INFO);
await Actor.init();

const input = await Actor.getInput<{ startUrls: any[]; maxItems?: number; proxyConfiguration?: any }>();
if (!input || !input.startUrls) {
    throw new Error('Input is missing startUrls');
}

const { startUrls, maxItems = 100, proxyConfiguration } = input;
log.info(`Input: ${startUrls.length} URLs, maxItems: ${maxItems}`);

// Prepare proxy
const proxyConfig = proxyConfiguration 
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : undefined;

let productCount = 0;

/**
 * Extract product listing data from a product object (from either category or detail page)
 */
function formatProduct(p: any, url: string) {
    // Price: try flat first, then nested
    let price = '';
    let priceValue: number | null = null;
    
    if (p.price?.text) {
        price = p.price.text;
        priceValue = p.price.value;
    } else if (p.price?.discountedPrice?.text) {
        price = p.price.discountedPrice.text;
        priceValue = p.price.discountedPrice.value;
    } else if (p.price?.sellingPrice?.text) {
        price = p.price.sellingPrice.text;
        priceValue = p.price.sellingPrice.value;
    }
    
    // Thumbnail
    const rawImages = p.images || p.imageUrl ? [p.imageUrl] : [];
    const imgList = Array.isArray(p.images) ? p.images : rawImages;
    const firstImage = imgList[0] || p.imageUrl || '';
    const thumbnail = firstImage 
        ? (firstImage.startsWith('http') ? firstImage : `https://cdn.dsmcdn.com${firstImage}`)
        : '';
    
    return {
        thumbnail,
        productId: String(p.id || ''),
        title: p.name || '',
        brand: p.brand?.name || p.brandName || '',
        price: price || 'N/A',
        priceValue,
        sellerName: p.merchantListing?.merchant?.name || p.merchantName || '',
        sellerId: p.merchantListing?.merchant?.id ? String(p.merchantListing.merchant.id) : (p.merchantId ? String(p.merchantId) : ''),
        category: p.category?.name || p.categoryName || '',
        categoryHierarchy: p.category?.hierarchy || p.categoryHierarchy || '',
        ratingAvg: p.ratingScore?.averageRating ? Number(p.ratingScore.averageRating.toFixed(2)) : null,
        ratingCount: p.ratingScore?.totalCount || 0,
        commentCount: p.ratingScore?.commentCount || 0,
        favoriteCount: p.favoriteCount || 0,
        inStock: p.inStock ?? true,
        url,
        scrapedAt: new Date().toISOString()
    };
}

/**
 * Fetch a single product detail via HTTP (fallback when category doesn't have full data)
 */
async function fetchProductDetail(url: string): Promise<any | null> {
    try {
        const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
        const response = await gotScraping({
            url,
            proxyUrl,
            headers: {
                'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });
        if (response.statusCode !== 200) return null;
        const html = response.body;
        const marker = '__envoy_product-detail__PROPS"]=';
        const idx = html.indexOf(marker);
        if (idx < 0) return null;
        const jsonStart = idx + marker.length;
        const scriptEnd = html.indexOf('</script>', jsonStart);
        if (scriptEnd < 0) return null;
        const props = JSON.parse(html.substring(jsonStart, scriptEnd));
        return props?.product || null;
    } catch {
        return null;
    }
}

// ======================================================================
// STRATEGY:
// 1. Open category page with Playwright (anti-bot)
// 2. Try to extract ALL product data from category page's window.__PROPS
// 3. If category only has partial data (no price), fall back to HTTP fetch
// 4. Paginate if we need more products
// ======================================================================

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestsPerCrawl: 50,
    requestHandler: async ({ request, page, enqueueLinks }) => {
        log.info(`[CATEGORY] Processing ${request.url}`);

        // Wait for product cards
        await page.waitForSelector('.product-card, a[href*="-p-"]', { timeout: 15000 }).catch(() => {
            log.warning(`[CATEGORY] Product links didn't load for ${request.url}`);
        });

        // STEP 1: Try to find product listing data in window PROPS
        const categoryData = await page.evaluate(() => {
            const w = window as any;
            const keys = Object.keys(w).filter(k => k.includes('PROPS'));

            // Search for any PROPS that contains a product list
            for (const key of keys) {
                const val = w[key];
                if (!val) continue;
                
                // Check common patterns for search/listing results
                // Could be: val.products, val.searchResult, val.result.products, etc.
                let products: any[] | null = null;
                
                if (Array.isArray(val.products)) products = val.products;
                else if (val.searchResult?.products) products = val.searchResult.products;
                else if (val.result?.products) products = val.result.products;
                else if (val.categoryProducts?.products) products = val.categoryProducts.products;
                else if (val.data?.products) products = val.data.products;
                else if (val.content?.products) products = val.content.products;
                
                if (products && products.length > 0) {
                    return {
                        source: key,
                        products: products.map((p: any) => ({
                            id: p.id,
                            name: p.name,
                            brand: p.brand,
                            brandName: p.brandName,
                            price: p.price,
                            imageUrl: p.imageUrl || p.image || p.images?.[0],
                            merchantName: p.merchantName,
                            merchantId: p.merchantId,
                            categoryName: p.categoryName,
                            categoryHierarchy: p.categoryHierarchy,
                            ratingScore: p.ratingScore,
                            favoriteCount: p.favoriteCount,
                            inStock: p.inStock,
                            url: p.url,
                        })),
                    };
                }
            }
            
            // Return all PROPS keys for debugging if no products found
            return { source: null, propsKeys: keys, products: [] };
        });

        if (categoryData.products && categoryData.products.length > 0) {
            // SUCCESS! Extract products directly from category page
            log.info(`[CATEGORY] Found ${categoryData.products.length} products in ${categoryData.source}`);
            
            const remaining = maxItems - productCount;
            const productsToSave = categoryData.products.slice(0, remaining);
            
            for (const p of productsToSave) {
                // Build product URL from id/name
                const productUrl = p.url 
                    ? (p.url.startsWith('http') ? p.url : `https://www.trendyol.com${p.url}`)
                    : request.url;
                
                const data = formatProduct(p, productUrl);
                await Actor.pushData(data);
                productCount++;
                log.info(`[PRODUCT] ✓ ${data.brand} - ${data.title} | ${data.price} (${productCount}/${maxItems})`);
                
                if (productCount >= maxItems) break;
            }
        } else {
            // FALLBACK: No product data in PROPS, extract URLs and fetch via HTTP
            log.info(`[CATEGORY] No product list in PROPS (keys: ${categoryData.propsKeys?.join(', ')}). Falling back to HTTP fetch.`);
            
            const productUrls: string[] = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('.product-card'));
                return links
                    .map(a => (a as HTMLAnchorElement).href)
                    .filter(href => href && href.includes('-p-'));
            });

            const remaining = maxItems - productCount;
            const urlsToFetch = productUrls.slice(0, remaining);
            
            // Fetch in parallel batches of 5
            const batchSize = 5;
            for (let i = 0; i < urlsToFetch.length && productCount < maxItems; i += batchSize) {
                const batch = urlsToFetch.slice(i, i + batchSize);
                await Promise.allSettled(
                    batch.map(async (url) => {
                        if (productCount >= maxItems) return;
                        const product = await fetchProductDetail(url);
                        if (product) {
                            // Get price from variants for detail pages
                            if (!product.price && product.variants?.length > 0) {
                                product.price = product.variants[0].price;
                            }
                            const data = formatProduct(product, url);
                            await Actor.pushData(data);
                            productCount++;
                            log.info(`[PRODUCT] ✓ ${data.brand} - ${data.title} | ${data.price} (${productCount}/${maxItems})`);
                        }
                    })
                );
            }
        }

        log.info(`[CATEGORY] Done. Total: ${productCount}/${maxItems}`);

        // Paginate if we need more
        if (productCount < maxItems) {
            await enqueueLinks({
                selector: '.pagination a, a.next',
                globs: ['https://www.trendyol.com/*?pi=*', 'https://www.trendyol.com/*&pi=*'],
            });
        }
    },
    headless: true,
    preNavigationHooks: [
        async ({ request, page }, gotoOptions) => {
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            });
            if (gotoOptions) {
                gotoOptions.waitUntil = 'domcontentloaded';
            }
        }
    ],
    browserPoolOptions: { useFingerprints: true },
    launchContext: {
        useChrome: true,
        launchOptions: { args: ['--disable-blink-features=AutomationControlled'] }
    }
});

log.info('Starting the crawl.');
await crawler.run(startUrls.map((req: any) => req.url));
log.info(`Crawl finished. Total products: ${productCount}`);
await Actor.exit();
