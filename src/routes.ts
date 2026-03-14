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

        // STEP 1: Dump the full product object structure for debugging
        const debugInfo = await page.evaluate(() => {
            const w = window as any;
            const propsKey = '__envoy_product-detail__PROPS';
            const props = w[propsKey];
            
            if (!props) {
                // List all window keys containing PROPS
                const allKeys = Object.keys(w).filter(k => k.includes('PROPS'));
                return { error: 'envoy_product-detail__PROPS not found', availableKeys: allKeys };
            }
            
            if (!props.product) {
                return { error: 'product not found in props', propsKeys: Object.keys(props) };
            }
            
            const p = props.product;
            return {
                productKeys: Object.keys(p),
                hasPrice: !!p.price,
                priceKeys: p.price ? Object.keys(p.price) : null,
                hasVariants: !!p.variants,
                variantsLength: p.variants?.length,
                firstVariantKeys: p.variants?.[0] ? Object.keys(p.variants[0]) : null,
                firstVariantPriceKeys: p.variants?.[0]?.price ? Object.keys(p.variants[0].price) : null,
                // Dump actual price data
                directPrice: p.price || null,
                variantPrice: p.variants?.[0]?.price || null,
                // Try all possible price paths
                name: p.name,
                brand: p.brand,
                merchant: p.merchant,
                category: p.category,
            };
        });
        
        log.info(`[PRODUCT] Debug info: ${JSON.stringify(debugInfo)}`);
        await Actor.setValue('debug-product-structure', JSON.stringify(debugInfo, null, 2), { contentType: 'application/json' });

        // STEP 2: Extract product data
        const productData = await page.evaluate(() => {
            const w = window as any;
            const props = w['__envoy_product-detail__PROPS'];
            
            if (!props?.product) return null;
            
            const p = props.product;
            
            // Try ALL possible price locations
            let priceText = '';
            let priceValue: number | null = null;
            let originalPriceText = '';
            
            // Path 1: product.price
            if (p.price?.discountedPrice?.text) {
                priceText = p.price.discountedPrice.text;
                priceValue = p.price.discountedPrice.value;
                originalPriceText = p.price.originalPrice?.text || '';
            } else if (p.price?.sellingPrice?.text) {
                priceText = p.price.sellingPrice.text;
                priceValue = p.price.sellingPrice.value;
            }
            
            // Path 2: product.variants[0].price
            if (!priceText && p.variants?.length > 0) {
                const vp = p.variants[0].price;
                if (vp?.discountedPrice?.text) {
                    priceText = vp.discountedPrice.text;
                    priceValue = vp.discountedPrice.value;
                    originalPriceText = vp.originalPrice?.text || '';
                } else if (vp?.sellingPrice?.text) {
                    priceText = vp.sellingPrice.text;
                    priceValue = vp.sellingPrice.value;
                }
            }
            
            // Path 3: product.allVariants
            if (!priceText && p.allVariants?.length > 0) {
                const vp = p.allVariants[0].price;
                if (vp?.discountedPrice?.text) {
                    priceText = vp.discountedPrice.text;
                    priceValue = vp.discountedPrice.value;
                } else if (vp?.sellingPrice?.text) {
                    priceText = vp.sellingPrice.text;
                    priceValue = vp.sellingPrice.value;
                }
            }
            
            return {
                name: p.name || '',
                brand: p.brand?.name || '',
                price: priceText,
                priceValue,
                originalPrice: originalPriceText,
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
            };
        });

        if (!productData) {
            log.warning(`[PRODUCT] No product data found for ${request.url}`);
            return;
        }

        // Product ID fallback from URL
        const productIdMatch = request.url.match(/-p-(\d+)/);
        const productId = productData.productId || (productIdMatch ? productIdMatch[1] : null);

        // Save data even if price is missing (we can fix price later)
        await Actor.pushData({
            url: request.url,
            productId,
            title: productData.name,
            brand: productData.brand,
            price: productData.price || 'N/A',
            priceValue: productData.priceValue,
            originalPrice: productData.originalPrice,
            seller: productData.seller,
            category: productData.category,
            ratingScore: productData.ratingScore,
            images: [...new Set(productData.images)],
            scrapedAt: new Date().toISOString()
        });

        if (productData.price) {
            log.info(`[PRODUCT] Saved: ${productData.brand} - ${productData.name} (${productData.price})`);
        } else {
            log.warning(`[PRODUCT] Saved with missing price: ${productData.brand} - ${productData.name}. Check debug-product-structure in KV store.`);
        }
    } catch (e: any) {
        log.error(`[PRODUCT] Failed to extract data for ${request.url}: ${e.message}`);
    }
});
