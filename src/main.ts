import { Actor } from 'apify';
import { PlaywrightCrawler, log, ProxyConfiguration } from 'crawlee';
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

/**
 * FAST product detail extraction via HTTP (gotScraping + Apify proxy).
 * No browser needed - just fetches the HTML and parses the JSON blob.
 */
async function fetchProduct(url: string): Promise<any | null> {
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
        
        const jsonStr = html.substring(jsonStart, scriptEnd);
        const props = JSON.parse(jsonStr);
        return props?.product || null;
    } catch (e: any) {
        log.warning(`[HTTP] Failed to fetch ${url}: ${e.message}`);
        return null;
    }
}

/**
 * Extract and push product data from the raw product object.
 */
function extractAndPush(product: any, url: string) {
    // Price: flat structure at variants[0].price = {value, text}
    let price = '';
    let priceValue: number | null = null;
    
    if (product.price?.text) {
        price = product.price.text;
        priceValue = product.price.value;
    } else if (product.variants?.length > 0) {
        const vp = product.variants[0].price;
        if (vp?.text) {
            price = vp.text;
            priceValue = vp.value;
        }
    }
    
    // Product ID from URL
    const productIdMatch = url.match(/-p-(\d+)/);
    const productId = String(product.id || '') || (productIdMatch ? productIdMatch[1] : '');
    
    // Thumbnail: first image
    const rawImages = product.images || [];
    const firstImage = rawImages[0] || '';
    const thumbnail = firstImage 
        ? (firstImage.startsWith('http') ? firstImage : `https://cdn.dsmcdn.com${firstImage}`)
        : '';
    
    // Seller from merchantListing.merchant
    const merchant = product.merchantListing?.merchant;
    
    return {
        thumbnail,
        productId,
        title: product.name || '',
        brand: product.brand?.name || '',
        price: price || 'N/A',
        priceValue,
        sellerName: merchant?.name || '',
        sellerId: merchant?.id ? String(merchant.id) : '',
        category: product.category?.name || '',
        categoryHierarchy: product.category?.hierarchy || '',
        ratingAvg: product.ratingScore?.averageRating ? Number(product.ratingScore.averageRating.toFixed(2)) : null,
        ratingCount: product.ratingScore?.totalCount || 0,
        commentCount: product.ratingScore?.commentCount || 0,
        favoriteCount: product.favoriteCount || 0,
        inStock: product.inStock ?? true,
        url,
        scrapedAt: new Date().toISOString()
    };
}

// ======================================================================
// ARCHITECTURE: Playwright for category pages ONLY, HTTP for products.
// This saves ~5-10x in compute cost since products don't need a browser.
// ======================================================================

let productCount = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    // Only category pages go through Playwright, so this limits category pages
    maxRequestsPerCrawl: 50,
    requestHandler: async ({ request, page, enqueueLinks }) => {
        log.info(`[CATEGORY] Processing ${request.url}`);

        // Wait for product cards
        await page.waitForSelector('.product-card, a[href*="-p-"]', { timeout: 15000 }).catch(() => {
            log.warning(`[CATEGORY] Product links didn't load for ${request.url}`);
        });

        // Extract product URLs directly from the page
        const productUrls: string[] = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('.product-card'));
            return links
                .map(a => (a as HTMLAnchorElement).href)
                .filter(href => href && href.includes('-p-'));
        });

        log.info(`[CATEGORY] Found ${productUrls.length} product URLs on ${request.url}`);

        // Fetch products via fast HTTP (no browser!)
        const remaining = maxItems - productCount;
        const urlsToFetch = productUrls.slice(0, remaining);
        
        // Fetch in parallel batches of 5 for speed
        const batchSize = 5;
        for (let i = 0; i < urlsToFetch.length && productCount < maxItems; i += batchSize) {
            const batch = urlsToFetch.slice(i, i + batchSize);
            const results = await Promise.allSettled(
                batch.map(async (url) => {
                    const product = await fetchProduct(url);
                    if (product) {
                        const data = extractAndPush(product, url);
                        await Actor.pushData(data);
                        productCount++;
                        log.info(`[PRODUCT] ✓ ${data.brand} - ${data.title} | ${data.price} (${productCount}/${maxItems})`);
                    } else {
                        log.warning(`[PRODUCT] ✗ Failed to extract: ${url}`);
                    }
                })
            );
        }

        log.info(`[CATEGORY] Done. Total products so far: ${productCount}/${maxItems}`);

        // If we still need more products, paginate
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
    browserPoolOptions: {
        useFingerprints: true
    },
    launchContext: {
        useChrome: true,
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled']
        }
    }
});

log.info('Starting the crawl.');
const urls = startUrls.map((req: any) => req.url);
await crawler.run(urls);
log.info(`Crawl finished. Total products scraped: ${productCount}`);

await Actor.exit();
