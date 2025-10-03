// /api/proxy.js
import * as cheerio from 'cheerio';
// import TurndownService from 'turndown'; // Comment out temporarily

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url, selector = '#position', markdown } = req.query;
  
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
      // Parse the HTML and extract the specific content
      const $ = cheerio.load(scrapeData.html);
      const contentElement = $(selector);
      
      if (contentElement.length === 0) {
        return res.status(404).json({ 
          error: `No content found with selector: ${selector}`,
          availableSelectors: $('div[id], div[class], main, article, section').map((i, el) => ({
            tag: el.tagName,
            id: el.attribs.id,
            class: el.attribs.class?.split(' ')[0] // Just first class
          })).get().slice(0, 15), // Show first 15 for debugging
          url: fullUrl,
          method: 'scrapeowl'
        });
      }
      
      let content = contentElement.html();
      
      // Convert to markdown if requested
      if (markdown) {
        // TODO: Add markdown conversion back
        return res.json({ 
          error: 'Markdown conversion temporarily disabled - install turndown first',
          content: content.substring(0, 500) + '...',
          instructions: 'Add turndown to package.json and redeploy'
        });
      }
      
      return res.json({ 
        success: true,
        url: fullUrl,
        selector,
        format: markdown ? 'markdown' : 'html',
        contentLength: content.length,
        content,
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
