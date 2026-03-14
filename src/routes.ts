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

    // Wait for the main content or links to appear (more generic)
    await page.waitForSelector('a[href*="-p-"]', { timeout: 15000 }).catch(() => {
        log.warning(`[CATEGORY] Product links didn't load for ${request.url}`);
    });

    const cardHtml = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="-p-"]'));
        return links.length > 0 ? "Found " + links.length + " links" : document.body.innerHTML; 
    });
    await Actor.setValue('debug-html', cardHtml, { contentType: 'text/html' });
    log.info(`[CATEGORY] Dumped HTML to KeyValueStore as debug-html`);

    // Find and enqueue product links using globs to bypass CSS class changes
    const enqueued = await enqueueLinks({
        globs: ['https://www.trendyol.com/*-p-*'],
        label: 'detail',
    });
    
    log.info(`[CATEGORY] Enqueued ${enqueued.processedRequests.length} products from ${request.url}`);

    // Handle pagination (find any link that has ?pi= or page=)
    await enqueueLinks({
        globs: ['https://www.trendyol.com/*?pi=*', 'https://www.trendyol.com/*&pi=*'],
    });
});

// Handler for product detail pages
router.addHandler('detail', async ({ request, page, log }) => {
    log.info(`[PRODUCT] Extracting: ${request.url}`);

    try {
        // Wait for main elements to load
        await page.waitForSelector('.pr-new-br', { timeout: 15000 });

        // Extract basic data
        const title = await page.evaluate(() => {
            const el1 = document.querySelector('h1.pr-new-br span');
            const el2 = document.querySelector('h1');
            return el1 ? el1.textContent?.trim() : (el2 ? el2.textContent?.trim() : '');
        });

        const brand = await page.evaluate(() => {
            const el = document.querySelector('.pr-new-br a');
            return el ? el.textContent?.trim() : '';
        });

        const priceStr = await page.evaluate(() => {
            const el1 = document.querySelector('.prc-dsc');
            const el2 = document.querySelector('.prc-slg');
            return el1 ? el1.textContent?.trim() : (el2 ? el2.textContent?.trim() : '');
        });
        
        // Product ID is usually in the URL (...-p-12345)
        const productIdMatch = request.url.match(/-p-(\d+)/);
        const productId = productIdMatch ? productIdMatch[1] : null;

        // Seller information
        const sellerInfo = await page.evaluate(() => {
            const nameEl = document.querySelector('.merchant-text') || document.querySelector('.merchant-box-wrapper a');
            const linkEl = document.querySelector('.merchant-box-wrapper a');
            const name = nameEl ? nameEl.textContent?.trim() : null;
            let id = null;
            if (linkEl) {
                const href = linkEl.getAttribute('href');
                const match = href?.match(/merchantId=(\d+)/);
                if (match) id = match[1];
            }
            return { name, id };
        });

        // Images
        const images = await page.evaluate(() => {
            const imgs = Array.from(document.querySelectorAll('.gallery-modal-content img, .product-image-container img'));
            return imgs.map(img => img.getAttribute('src'))
                .filter(src => src && !src.includes('ty.gl'))
                .map(src => src!.startsWith('http') ? src! : `https://cdn.dsmcdn.com${src}`);
        });

        // Push extracted data to Apify dataset
        if (title && priceStr) {
            await Actor.pushData({
                url: request.url,
                productId,
                title,
                brand,
                price: priceStr,
                seller: sellerInfo,
                images: [...new Set(images)], // unique images
                scrapedAt: new Date().toISOString()
            });
            log.info(`[PRODUCT] Saved: ${brand} - ${title} (${priceStr})`);
        } else {
            log.warning(`[PRODUCT] Missing title or price for ${request.url}`);
        }
    } catch (e: any) {
        log.error(`[PRODUCT] Failed to extract data for ${request.url}: ${e.message}`);
    }
});
