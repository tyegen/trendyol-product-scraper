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
            // Wait until domcontentloaded to handle heavy CSR pages faster than networkidle
            if (gotoOptions) {
                gotoOptions.waitUntil = 'domcontentloaded';
            }
        }
    ],
    // Helps with Cloudflare
    browserPoolOptions: {
        useFingerprints: true,
    },
});

log.info('Starting the crawl.');
const urls = startUrls.map(req => req.url);
await crawler.run(urls);
log.info('Crawl finished.');

await Actor.exit();
