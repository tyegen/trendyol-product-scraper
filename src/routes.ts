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
        await page.waitForTimeout(3000); // Allow hydration scripts to execute

        // Extract product data from the embedded JSON blob
        // Trendyol embeds all product data in: window["__envoy_product-detail__PROPS"]
        const productData = await page.evaluate(() => {
            const w = window as any;
            // Try the envoy props first (new structure)
            const propsKey = '__envoy_product-detail__PROPS';
            const props = w[propsKey];
            
            if (props && props.product) {
                const p = props.product;
                return {
                    name: p.name || '',
                    brand: p.brand?.name || '',
                    price: p.price?.discountedPrice?.text || p.price?.sellingPrice?.text || '',
                    priceValue: p.price?.discountedPrice?.value || p.price?.sellingPrice?.value || null,
                    originalPrice: p.price?.originalPrice?.text || '',
                    productId: String(p.id || ''),
                    contentId: String(p.contentId || ''),
                    images: (p.images || []).map((url: string) => 
                        url.startsWith('http') ? url : `https://cdn.dsmcdn.com${url}`
                    ),
                    seller: {
                        name: p.merchant?.name || null,
                        id: String(p.merchant?.id || ''),
                    },
                    category: p.category?.name || '',
                    ratingScore: p.ratingScore || null,
                    found: true,
                };
            }
            
            // Fallback: search all window props for product data
            for (const key of Object.keys(w)) {
                if (key.includes('PROPS') && w[key]?.product) {
                    const p = w[key].product;
                    return {
                        name: p.name || '',
                        brand: p.brand?.name || '',
                        price: p.price?.discountedPrice?.text || p.price?.sellingPrice?.text || '',
                        priceValue: p.price?.discountedPrice?.value || p.price?.sellingPrice?.value || null,
                        originalPrice: p.price?.originalPrice?.text || '',
                        productId: String(p.id || ''),
                        contentId: String(p.contentId || ''),
                        images: (p.images || []).map((url: string) => 
                            url.startsWith('http') ? url : `https://cdn.dsmcdn.com${url}`
                        ),
                        seller: {
                            name: p.merchant?.name || null,
                            id: String(p.merchant?.id || ''),
                        },
                        category: p.category?.name || '',
                        ratingScore: p.ratingScore || null,
                        found: true,
                    };
                }
            }
            
            return { found: false, name: '', brand: '', price: '', priceValue: null, originalPrice: '', productId: '', contentId: '', images: [], seller: { name: null, id: '' }, category: '', ratingScore: null };
        });

        // Product ID fallback from URL
        const productIdMatch = request.url.match(/-p-(\d+)/);
        const productId = productData.productId || (productIdMatch ? productIdMatch[1] : null);

        if (productData.found && productData.name && productData.price) {
            await Actor.pushData({
                url: request.url,
                productId,
                title: productData.name,
                brand: productData.brand,
                price: productData.price,
                priceValue: productData.priceValue,
                originalPrice: productData.originalPrice,
                seller: productData.seller,
                category: productData.category,
                ratingScore: productData.ratingScore,
                images: [...new Set(productData.images)],
                scrapedAt: new Date().toISOString()
            });
            log.info(`[PRODUCT] Saved: ${productData.brand} - ${productData.name} (${productData.price})`);
        } else {
            log.warning(`[PRODUCT] Missing product data for ${request.url}. Found: ${productData.found}, Name: "${productData.name}", Price: "${productData.price}"`);
        }
    } catch (e: any) {
        log.error(`[PRODUCT] Failed to extract data for ${request.url}: ${e.message}`);
    }
});
