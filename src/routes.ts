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
        // Wait for h1 (the product title) instead of a specific class
        await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {
            log.warning(`[PRODUCT] h1 tag didn't load for ${request.url}`);
        });

        // Debug: Dump product HTML
        const detailHtml = await page.evaluate(() => document.body.innerHTML);
        await Actor.setValue('debug-detail-html', detailHtml, { contentType: 'text/html' });

        // Extract basic data
        const titleAndBrand = await page.evaluate(() => {
            const h1 = document.querySelector('h1');
            const h1Clone = h1 ? h1.cloneNode(true) as HTMLElement : null;
            
            // Typical Trendyol structure: <h1> <a href="...">Brand</a> Title text </h1>
            let brand = '';
            let title = h1 ? h1.textContent?.trim() || '' : '';
            
            if (h1Clone) {
                const brandEl = h1Clone.querySelector('a');
                if (brandEl) {
                    brand = brandEl.textContent?.trim() || '';
                    title = h1Clone.textContent?.replace(brand, '').trim() || title;
                } else if (h1Clone.querySelector('span')) {
                    brand = h1Clone.querySelector('span')?.textContent?.trim() || '';
                }
            }
            return { title, brand };
        });

        const priceStr = await page.evaluate(() => {
            // Find anything that looks like price
            const els = Array.from(document.querySelectorAll('span, div'))
                .filter(el => el.textContent?.includes('TL') && el.className.includes('prc'));
            
            for (const el of els) {
                if (el.className.includes('slg') || el.className.includes('dsc')) {
                    return el.textContent?.trim();
                }
            }
            return els.length > 0 ? els[0].textContent?.trim() : '';
        });
        
        // Product ID is usually in the URL (...-p-12345)
        const productIdMatch = request.url.match(/-p-(\d+)/);
        const productId = productIdMatch ? productIdMatch[1] : null;

        // Seller information
        const sellerInfo = await page.evaluate(() => {
            const linkEl = document.querySelector('a[href*="merchantId="]');
            const name = linkEl ? linkEl.textContent?.trim() : null;
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
            const imgs = Array.from(document.querySelectorAll('img'));
            return imgs.map(img => img.getAttribute('src'))
                .filter(src => src && src.includes('product/media/images'))
                .map(src => src!.startsWith('http') ? src! : `https://cdn.dsmcdn.com${src}`);
        });

        // Push extracted data to Apify dataset
        if (titleAndBrand.title && priceStr) {
            await Actor.pushData({
                url: request.url,
                productId,
                title: titleAndBrand.title,
                brand: titleAndBrand.brand,
                price: priceStr,
                seller: sellerInfo,
                images: [...new Set(images)], // unique images
                scrapedAt: new Date().toISOString()
            });
            log.info(`[PRODUCT] Saved: ${titleAndBrand.brand} - ${titleAndBrand.title} (${priceStr})`);
        } else {
            log.warning(`[PRODUCT] Missing title or price for ${request.url}`);
        }
    } catch (e: any) {
        log.error(`[PRODUCT] Failed to extract data for ${request.url}: ${e.message}`);
    }
});
