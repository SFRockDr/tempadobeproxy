// /api/proxy.js
import * as cheerio from 'cheerio';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter required' });
  }
  
  const fullUrl = `https://helpx.adobe.com/${url}`;
  
  try {
    console.log('Fetching:', fullUrl);
    
    // Try with more realistic browser headers
    const response = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      timeout: 10000
    });
    console.log('Response status:', response.status);
    
    if (!response.ok) {
      return res.json({ 
        error: `HTTP ${response.status}`,
        url: fullUrl,
        statusText: response.statusText
      });
    }
    
    const html = await response.text();
    console.log('HTML length:', html.length);
    
    // Just return basic info for now
    res.json({ 
      success: true,
      url: fullUrl,
      htmlLength: html.length,
      preview: html.substring(0, 200)
    });
    
  } catch (error) {
    console.error('Direct fetch failed:', error.message);
    
    // Try ScrapeOwl as fallback
    try {
      const SCRAPEOWL_API_KEY = process.env.SCRAPEOWL_API_KEY;
      
      if (!SCRAPEOWL_API_KEY) {
        throw new Error('SCRAPEOWL_API_KEY not configured');
      }
      
      console.log('Trying ScrapeOwl...');
      const scrapeOwlUrl = `https://api.scrapeowl.com/v1/scrape?api_key=${SCRAPEOWL_API_KEY}&url=${encodeURIComponent(fullUrl)}&elements=%23position,.main-content,article,.content`;
      
      const scrapeResponse = await fetch(scrapeOwlUrl);
      const scrapeData = await scrapeResponse.json();
      
      if (scrapeData.html) {
        return res.json({ 
          success: true,
          url: fullUrl,
          htmlLength: scrapeData.html.length,
          preview: scrapeData.html.substring(0, 200),
          method: 'scrapeowl'
        });
      } else {
        throw new Error('ScrapeOwl returned no HTML');
      }
      
    } catch (scrapeError) {
      console.error('ScrapeOwl failed:', scrapeError.message);
    }
    
    // All methods failed
    res.status(500).json({ 
      error: 'All fetch methods failed. Adobe is blocking automated access.',
      suggestions: [
        'Add SCRAPEOWL_API_KEY to Vercel environment variables',
        'Try ScrapingBee as alternative',
        'Use Puppeteer with chrome-aws-lambda'
      ],
      url: fullUrl
    });
  }
};;
