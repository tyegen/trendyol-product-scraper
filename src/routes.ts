import { createPlaywrightRouter } from 'crawlee';
import { Actor } from 'apify';
import * as fs from 'fs';

export const router = createPlaywrightRouter();

// Default handler for category/search pages
router.addDefaultHandler(async ({ request, page, enqueueLinks, log }) => {
    log.info(`[CATEGORY] Processing ${request.url}`);
    
    // Take a screenshot to debug
    const screenshot = await page.screenshot();
    await Actor.setValue('debug-screenshot', screenshot, { contentType: 'image/png' });
    log.info(`Saved screenshot to KeyValueStore as debug-screenshot`);

    // Wait for the main content or links to appear (more generic, 'product-card' is their new class)
    await page.waitForSelector('.product-card, a[href*="-p-"]', { timeout: 15000 }).catch(() => {
        log.warning(`[CATEGORY] Product links didn't load for ${request.url}`);
    });

    const cardHtml = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('.product-card, a[href*="-p-"]'));
        return links.length > 0 ? "Found " + links.length + " links" : document.body.innerHTML; 
    });
    await Actor.setValue('debug-html', cardHtml, { contentType: 'text/html' });
    log.info(`[CATEGORY] Dumped HTML to KeyValueStore as debug-html`);

    // Find and enqueue product links using precise CSS class from the debug-html file
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
router.addHandler('detail', async ({ request, page, log }) => {
    log.info(`[PRODUCT] Extracting: ${request.url}`);

    try {
        // Wait for content to load 
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        // Extract product data from window["__envoy_product-detail__PROPS"]
        const productData = await page.evaluate(() => {
            const w = window as any;
            const props = w['__envoy_product-detail__PROPS'];
            
            if (!props?.product) return null;
            
            const p = props.product;
            
            // Price is at variants[0].price with FLAT structure: {value, text}
            // NOT nested as {discountedPrice: {value, text}}
            let priceText = '';
            let priceValue: number | null = null;
            
            // Path 1: Direct product.price (flat)
            if (p.price?.text) {
                priceText = p.price.text;
                priceValue = p.price.value;
            }
            // Path 2: Direct product.price (nested - just in case)
            else if (p.price?.discountedPrice?.text) {
                priceText = p.price.discountedPrice.text;
                priceValue = p.price.discountedPrice.value;
            }
            
            // Path 3: variants[0].price (flat)
            if (!priceText && p.variants?.length > 0) {
                const vp = p.variants[0].price;
                if (vp?.text) {
                    priceText = vp.text;
                    priceValue = vp.value;
                } else if (vp?.discountedPrice?.text) {
                    priceText = vp.discountedPrice.text;
                    priceValue = vp.discountedPrice.value;
                }
            }
            
            // Seller comes from merchantListing, not merchant
            const ml = p.merchantListing;
            const seller = {
                name: ml?.merchantName || ml?.name || null,
                id: ml?.merchantId ? String(ml.merchantId) : (ml?.id ? String(ml.id) : ''),
            };
            
            return {
                name: p.name || '',
                brand: p.brand?.name || '',
                price: priceText,
                priceValue,
                productId: String(p.id || ''),
                contentId: String(p.contentId || ''),
                images: (p.images || []).map((url: string) => 
                    url.startsWith('http') ? url : `https://cdn.dsmcdn.com${url}`
                ),
                seller,
                category: p.category?.name || '',
                categoryHierarchy: p.category?.hierarchy || '',
                ratingScore: p.ratingScore || null,
                favoriteCount: p.favoriteCount || 0,
                inStock: p.inStock ?? true,
            };
        });

        if (!productData) {
            log.warning(`[PRODUCT] No product data found for ${request.url}`);
            return;
        }

        // Product ID fallback from URL
        const productIdMatch = request.url.match(/-p-(\d+)/);
        const productId = productData.productId || (productIdMatch ? productIdMatch[1] : null);

        await Actor.pushData({
            url: request.url,
            productId,
            title: productData.name,
            brand: productData.brand,
            price: productData.price || 'N/A',
            priceValue: productData.priceValue,
            seller: productData.seller,
            category: productData.category,
            categoryHierarchy: productData.categoryHierarchy,
            ratingScore: productData.ratingScore,
            favoriteCount: productData.favoriteCount,
            inStock: productData.inStock,
            images: [...new Set(productData.images)],
            scrapedAt: new Date().toISOString()
        });

        log.info(`[PRODUCT] Saved: ${productData.brand} - ${productData.name} (${productData.price || 'N/A'})`);
    } catch (e: any) {
        log.error(`[PRODUCT] Failed to extract data for ${request.url}: ${e.message}`);
    }
});
