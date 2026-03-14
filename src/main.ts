import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { router } from './routes.js';

log.setLevel(log.LEVELS.DEBUG);
await Actor.init();

const input = await Actor.getInput<{ startUrls: any[]; maxItems?: number; proxyConfiguration?: any }>();
if (!input || !input.startUrls) {
    throw new Error('Input is missing startUrls');
}

console.log('INPUT IS:', JSON.stringify(input, null, 2));

const { startUrls, maxItems = 100, proxyConfiguration } = input;

// Prepare proxy based on Apify Actor input
const proxyConfigurationParams = proxyConfiguration 
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : undefined;

// Create a PlaywrightCrawler instance
const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfigurationParams,
    maxRequestsPerCrawl: maxItems,
    requestHandler: router,
    headless: true,
    
    // Adding anti-scraping headers and browser fingerprinting
    preNavigationHooks: [
        async ({ request, page }, gotoOptions) => {
            // Set realistic headers
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            });

            // Wait until domcontentloaded to handle heavy CSR pages faster than networkidle
            if (gotoOptions) {
                gotoOptions.waitUntil = 'domcontentloaded';
            }
        }
    ],
    // Helps with Cloudflare by using actual Chrome instead of Chromium 
    // and randomizing browser fingerprints
    browserPoolOptions: {
        useFingerprints: true
    },
    launchContext: {
        useChrome: true, // Use real Chrome executable
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled']
        }
    }
});

log.info('Starting the crawl.');
const urls = startUrls.map(req => req.url);
await crawler.run(urls);
log.info('Crawl finished.');

await Actor.exit();
