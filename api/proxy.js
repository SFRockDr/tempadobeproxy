// /api/proxy.js
const cheerio = require('cheerio');

module.exports = async function handler(req, res) {
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
    
    // Simple fetch first
    const response = await fetch(fullUrl);
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
    console.error('Error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack,
      url: `https://helpx.adobe.com/${url}`
    });
  }
};
