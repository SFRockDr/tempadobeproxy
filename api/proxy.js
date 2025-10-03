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
  
  try {
    const fullUrl = `https://helpx.adobe.com/${url}`;
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
    console.error('Direct fetch failed, trying proxy:', error.message);
    
    // Fallback: Try using a public proxy
    try {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(fullUrl)}`;
      const proxyResponse = await fetch(proxyUrl);
      const proxyData = await proxyResponse.json();
      
      if (proxyData.contents) {
        const html = proxyData.contents;
        return res.json({ 
          success: true,
          url: fullUrl,
          htmlLength: html.length,
          preview: html.substring(0, 200),
          method: 'proxy'
        });
      }
    } catch (proxyError) {
      console.error('Proxy also failed:', proxyError.message);
    }
    
    res.status(500).json({ 
      error: error.message,
      stack: error.stack,
      url: fullUrl,
      suggestion: "Adobe may be blocking server requests. Try using a headless browser service like Puppeteer."
    });
  }
};;
