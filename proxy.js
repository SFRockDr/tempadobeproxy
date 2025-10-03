// /api/proxy.js
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

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
  
  try {
    // Fetch the Adobe page
    const response = await fetch(`https://helpx.adobe.com/${url}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Adobe Internal Tool)'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Extract content from specified selector
    const contentElement = $(selector);
    
    if (contentElement.length === 0) {
      return res.status(404).json({ 
        error: `No content found with selector: ${selector}`,
        availableSelectors: $('div[id], div[class]').map((i, el) => ({
          tag: el.tagName,
          id: el.attribs.id,
          class: el.attribs.class
        })).get().slice(0, 10) // Show first 10 for debugging
      });
    }
    
    let content = contentElement.html();
    
    // Convert to markdown if requested
    if (markdown) {
      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced'
      });
      content = turndown.turndown(content);
    }
    
    res.json({ 
      content,
      url: `https://helpx.adobe.com/${url}`,
      selector,
      format: markdown ? 'markdown' : 'html'
    });
    
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: error.message,
      url: `https://helpx.adobe.com/${url}`
    });
  }
}