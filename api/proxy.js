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

  const { url, markdown } = req.query;
  
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
      // Parse the HTML and extract Adobe Help article content
      const $ = cheerio.load(scrapeData.html);
      const contentElement = $('.dexter-FlexContainer-Items'); // Hardcoded Adobe Help selector
      
      if (contentElement.length === 0) {
        return res.status(404).json({ 
          error: 'No Adobe Help article content found on this page',
          url: fullUrl,
          method: 'scrapeowl'
        });
      }
      
      // Remove table of contents, navigation, images, and other unwanted elements
      contentElement.find('.toc, .TableOfContents, nav, .nav, .breadcrumb, style, .dexter-Spacer, .planCard, .plan-card, .xfreference, .rightRailXf, .viewportSpecificContainer, img, picture, .image, .video, iframe').remove();
      
      let content = contentElement.html();
      
      // Convert to markdown if requested
      if (markdown) {
        const turndown = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
          bulletListMarker: '-',
          // Remove style tags, scripts, and images
          remove: ['style', 'script', 'img', 'picture', 'iframe']
        });
        
        content = turndown.turndown(content);
        
        // Cut off content at common footer sections
        const cutoffPatterns = [
          /^## Have a question or an idea.*/ms,
          /^## More like this.*/ms,
          /^### Talk to us.*/ms,
          /^Have a question or an idea.*/ms,
          /^More like this.*/ms
        ];
        
        for (const pattern of cutoffPatterns) {
          const match = content.match(pattern);
          if (match) {
            content = content.substring(0, match.index).trim();
            break;
          }
        }
        
        // Convert markdown to plain text with explicit separators
        content = content.replace(/^#+ (.+)$/gm, '\n\n--- $1 ---\n\n'); // Convert headers to section dividers
        content = content.replace(/^\* (.+)$/gm, '• $1'); // Convert bullet points
        content = content.replace(/^\d+\. (.+)$/gm, '$1'); // Remove numbering, keep text
        content = content.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // Remove markdown links, keep text
        content = content.replace(/\*\*([^*]+)\*\*/g, '$1'); // Remove bold markdown
        content = content.replace(/\*([^*]+)\*/g, '$1'); // Remove italic markdown
        content = content.replace(/`([^`]+)`/g, '$1'); // Remove code markdown
        
        // Clean up spacing
        content = content.replace(/\n{3,}/g, '\n\n'); // Collapse excessive newlines
        content = content.replace(/^\s+|\s+$/g, ''); // Trim whitespace
        
        // Replace newlines with space for systems that strip formatting
        content = content.replace(/\n/g, ' ');
        content = content.replace(/\s+/g, ' '); // Normalize multiple spaces
        
      }
      
      // Return simplified payload - just the clean text content
      return res.json({ 
        content: content
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
