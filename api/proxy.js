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
  
  // Check if ScrapeOwl key exists
  const SCRAPEOWL_API_KEY = process.env.SCRAPEOWL_API_KEY;
  console.log('ScrapeOwl key exists:', !!SCRAPEOWL_API_KEY);
  
  // Skip direct fetch, go straight to ScrapeOwl for testing
  try {
    if (!SCRAPEOWL_API_KEY) {
      return res.status(500).json({ 
        error: 'SCRAPEOWL_API_KEY not configured in Vercel environment variables' 
      });
    }
    
    console.log('Using ScrapeOwl for:', fullUrl);
    const scrapeOwlUrl = `https://api.scrapeowl.com/v1/scrape?api_key=${SCRAPEOWL_API_KEY}&url=${encodeURIComponent(fullUrl)}`;
    
    const scrapeResponse = await fetch(scrapeOwlUrl);
    console.log('ScrapeOwl response status:', scrapeResponse.status);
    
    const scrapeData = await scrapeResponse.json();
    console.log('ScrapeOwl response keys:', Object.keys(scrapeData));
    
    if (scrapeData.html) {
      return res.json({ 
        success: true,
        url: fullUrl,
        htmlLength: scrapeData.html.length,
        preview: scrapeData.html.substring(0, 200),
        method: 'scrapeowl'
      });
    } else {
      return res.status(500).json({
        error: 'ScrapeOwl returned no HTML',
        response: scrapeData
      });
    }
    
  } catch (error) {
    console.error('ScrapeOwl error:', error);
    return res.status(500).json({ 
      error: error.message,
      stack: error.stack,
      url: fullUrl
    });
  }
};;
