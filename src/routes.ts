import { createPlaywrightRouter } from 'crawlee';
import { Actor } from 'apify';
import * as fs from 'fs';

export const router = createPlaywrightRouter();

// Default handler for category/search pages
router.addDefaultHandler(async ({ request, page, enqueueLinks, log }) => {
    log.info(`[CATEGORY] Processing ${request.url}`);
    
    // Take a screenshot to debug
    await page.screenshot({ path: 'debug.png' });
    log.info(`Saved screenshot to debug.png`);

    // Wait for product cards to load in the DOM
    await page.waitForSelector('.p-card-chldrn-cntnr, .p-card-wrppr', { timeout: 15000 }).catch(() => {
        log.warning(`[CATEGORY] Product cards didn't load for ${request.url}`);
    });

    const cardHtml = await page.evaluate(() => {
        const el = document.querySelector('.p-card-wrppr, .p-card-chldrn-cntnr');
        return el ? el.outerHTML : 'No card found';
    });
    fs.writeFileSync('product-card.html', cardHtml);
    log.info(`[CATEGORY] Dumped product card HTML`);

    // Find and enqueue product links
    const enqueued = await enqueueLinks({
        selector: '.p-card-wrppr a, .p-card-chldrn-cntnr a',
        label: 'detail',
    });
    
    log.info(`[CATEGORY] Enqueued ${enqueued.processedRequests.length} products from ${request.url}`);

    // Handle pagination (usually ?pi=2 or similar queries)
    // Try to find the next page arrow or pagination links
    await enqueueLinks({
        selector: 'a.slc-title, a.next-page', // Adjust css selectors if needed
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
