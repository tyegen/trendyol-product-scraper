import { createPlaywrightRouter } from 'crawlee';
import { Actor } from 'apify';

export const router = createPlaywrightRouter();

// Default handler for category/search pages (needs Playwright for anti-bot)
router.addDefaultHandler(async ({ request, page, enqueueLinks, log }) => {
    log.info(`[CATEGORY] Processing ${request.url}`);

    // Wait for product cards to appear
    await page.waitForSelector('.product-card, a[href*="-p-"]', { timeout: 15000 }).catch(() => {
        log.warning(`[CATEGORY] Product links didn't load for ${request.url}`);
    });

    // Enqueue product links
    const enqueued = await enqueueLinks({
        selector: '.product-card',
        label: 'detail',
    });
    
    log.info(`[CATEGORY] Enqueued ${enqueued.processedRequests.length} products from ${request.url}`);

    // Handle pagination
    await enqueueLinks({
        selector: '.pagination a, a.next',
        globs: ['https://www.trendyol.com/*?pi=*', 'https://www.trendyol.com/*&pi=*'],
    });
});

// Handler for product detail pages
// No waitForTimeout - the JSON data is in the initial HTML <script> tags
router.addHandler('detail', async ({ request, page, log }) => {
    log.info(`[PRODUCT] Extracting: ${request.url}`);

    try {
        // Only wait for initial HTML to arrive - no need to wait for JS rendering
        // The product data is embedded in <script> tags as server-side rendered JSON
        await page.waitForLoadState('domcontentloaded');

        // Extract product data from window["__envoy_product-detail__PROPS"]
        const product = await page.evaluate(() => {
            const w = window as any;
            const props = w['__envoy_product-detail__PROPS'];
            return props?.product || null;
        });
        
        if (!product) {
            log.warning(`[PRODUCT] No product data found for ${request.url}`);
            return;
        }
        
        // === PRICE: flat structure at variants[0].price = {value, text} ===
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
        
        // === PRODUCT ID ===
        const productIdMatch = request.url.match(/-p-(\d+)/);
        const productId = String(product.id || '') || (productIdMatch ? productIdMatch[1] : '');
        
        // === THUMBNAIL: first image only ===
        const rawImages = product.images || [];
        const firstImage = rawImages[0] || '';
        const thumbnail = firstImage 
            ? (firstImage.startsWith('http') ? firstImage : `https://cdn.dsmcdn.com${firstImage}`)
            : '';
        
        // === SELLER from merchantListing ===
        const ml = product.merchantListing;
        
        // === PUSH FLAT DATA ===
        await Actor.pushData({
            thumbnail,
            productId,
            title: product.name || '',
            brand: product.brand?.name || '',
            price: price || 'N/A',
            priceValue,
            sellerName: ml?.merchantName || ml?.name || '',
            sellerId: ml?.merchantId ? String(ml.merchantId) : '',
            category: product.category?.name || '',
            categoryHierarchy: product.category?.hierarchy || '',
            ratingAvg: product.ratingScore?.averageRating ? Number(product.ratingScore.averageRating.toFixed(2)) : null,
            ratingCount: product.ratingScore?.totalCount || 0,
            commentCount: product.ratingScore?.commentCount || 0,
            favoriteCount: product.favoriteCount || 0,
            inStock: product.inStock ?? true,
            url: request.url,
            scrapedAt: new Date().toISOString()
        });

        log.info(`[PRODUCT] ✓ ${product.brand?.name || ''} - ${product.name} | ${price || 'N/A'}`);
    } catch (e: any) {
        log.error(`[PRODUCT] Failed: ${request.url}: ${e.message}`);
    }
});
