# 🚀 Trendyol Product Scraper (Ultra Fast & 90% Cheaper)

Extract product data from **Trendyol.com** at lightning speed and the lowest possible cost. This scraper is highly optimized using a hybrid approach that extracts data directly from category listing JSON, making it **90% cheaper** and significantly faster than traditional scrapers.

## 🌟 Key Features

- **Extreme Cost-Efficiency**: Extracts up to 24 products per request directly from category JSON. 
- **Ultra-Fast**: No more navigating through every single product page. 
- **Smart Data Extraction**: Captures verified prices, brand names, ratings, and image URLs.
- **Proxy Optimized**: Works perfectly with residential and cost-effective datacenter proxies.
- **Anti-Bot Ready**: Integrated with Playwright and modern fingerprinting to bypass detection.

## 📊 Extracted Data

The scraper extracts the following fields for each product:

- **Product Identity**: ID, Title, URL
- **Brand & Seller**: Verified Brand Name, Seller ID
- **Pricing**: Formatted Price (e.g., "19.056,05 TL"), Numeric Price Value
- **Ratings**: Average Rating, Total Rating Count
- **Availability**: In-stock status, Free Shipping status
- **Media**: Direct CDN Thumbnail URL

## 💰 Pricing

- **Pay Per Result**: Only **$10 per 1,000 results** ($0.01 per item).
- Since the scraper is highly optimized, your compute (CU) costs will be negligible ($0.001 per run).

## 🛠️ How to Use

1. **Start URLs**: Provide Trendyol category, search, or boutique URLs.
2. **Max Items**: Set the limit for how many products you want.
3. **Proxy**: Automatic selection is recommended. Datacenter (TR) proxies work best for cost.

## 📖 Output Example

```json
{
  "thumbnail": "https://cdn.dsmcdn.com/mnresize/400/-/ty1670/prod/QC/20250425/18/9e643a50-5bb5-3844-a3a8-caac2c066cf7/1_org_zoom.jpg",
  "productId": "930469542",
  "title": "S8 Pro Akıllı Robot Süpürge",
  "brand": "Roborock",
  "price": "19.056,05 TL",
  "priceValue": 19056.05,
  "sellerId": "1223206",
  "category": "Robot Süpürge",
  "ratingAvg": 4.36,
  "ratingCount": 1128,
  "inStock": true,
  "freeCargo": true,
  "url": "https://www.trendyol.com/roborock/s8-pro-akilli-robot-supurge-p-930469542",
  "scrapedAt": "2026-03-14T22:14:41.507Z"
}
```

---
*Developed with ❤️ for high-scale e-commerce data extraction.*
