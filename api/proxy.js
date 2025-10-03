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

  const { url, markdown, debug } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter required' });
  }
  
  const fullUrl = `https://helpx.adobe.com/${url}`;
  const SCRAPEOWL_API_KEY = process.env.SCRAPEOWL_API_KEY;
  
  if (!SCRAPEOWL_API_KEY) {
    return res.status(500).json({ 
      error: 'SCRAPEOWL_API_KEY not configured in Vercel environment variables' 
    });
  }

  try {
    console.log('Fetching URL:', fullUrl);
    const scrapeOwlUrl = `https://api.scrapeowl.com/v1/scrape?api_key=${SCRAPEOWL_API_KEY}&url=${encodeURIComponent(fullUrl)}`;
    
    const scrapeResponse = await fetch(scrapeOwlUrl);
    const scrapeData = await scrapeResponse.json();
    
    if (!scrapeData.html) {
      return res.status(500).json({
        error: 'ScrapeOwl returned no HTML',
        response: scrapeData
      });
    }

    const $ = cheerio.load(scrapeData.html);
    
    // Extract title
    let title = $('h1').first().text().trim() || 
                $('.page-title').text().trim() ||
                $('title').text().replace(/\s*[|\-].*$/i, '').trim() ||
                'Untitled Article';

    // Detect template type and extract content accordingly
    let contentElement;
    let templateType;

    // HelpNext template detection (Photoshop Web style)
    const helpNextIndicators = $('#helpxNext-article-right-rail').length || 
                               $('.helpxNext-article').length ||
                               $('.titleBar parbase').length;

    // Legacy HelpX template detection (InDesign FAQ style)  
    const legacyHelpXIndicators = $('.helpxMain-article').length ||
                                  $('#root_content_flex').length ||
                                  $('.TableOfContents').length;

    if (helpNextIndicators) {
      templateType = 'HelpNext';
      console.log('Detected HelpNext template');
      
      // Try HelpNext-specific selectors in order of preference
      const helpNextSelectors = [
        '#helpxNext-article-right-rail .responsivegrid',
        'main .content .responsivegrid', 
        '.titleBar ~ .responsivegrid',
        'main .responsivegrid'
      ];
      
      for (const selector of helpNextSelectors) {
        const element = $(selector).first();
        if (element.length && element.text().trim().length > 200) {
          contentElement = element;
          console.log(`Using HelpNext selector: ${selector}`);
          break;
        }
      }
      
    } else if (legacyHelpXIndicators) {
      templateType = 'Legacy HelpX';
      console.log('Detected Legacy HelpX template');
      
      // Try Legacy HelpX-specific selectors in order of preference
      const legacySelectors = [
        '#root_content_flex_items_position .responsivegrid',
        '.content .flex .position .responsivegrid',
        'main .flex .position .responsivegrid',
        '.titleBar ~ .flex .responsivegrid'
      ];
      
      for (const selector of legacySelectors) {
        const element = $(selector).first();
        if (element.length && element.text().trim().length > 200) {
          contentElement = element;
          console.log(`Using Legacy selector: ${selector}`);
          break;
        }
      }
    }

    // Fallback if template detection failed
    if (!contentElement) {
      templateType = 'Unknown - using fallback';
      console.log('Template detection failed, using fallback selectors');
      
      const fallbackSelectors = [
        '.dexter-FlexContainer-Items',
        'main .responsivegrid', 
        'main',
        '.content'
      ];
      
      for (const selector of fallbackSelectors) {
        const element = $(selector).first();
        if (element.length && element.text().trim().length > 100) {
          contentElement = element;
          console.log(`Using fallback selector: ${selector}`);
          break;
        }
      }
    }

    if (!contentElement || contentElement.length === 0) {
      return res.status(404).json({ 
        error: 'No suitable content found on this page',
        templateType,
        url: fullUrl
      });
    }

    // Template-specific cleanup
    if (templateType === 'HelpNext') {
      contentElement.find(`
        .titleBar, .globalnavheader, .globalNavHeader, .flex_top_nav,
        .xfreference, .experiencefragment, .feedbackV2, .socialmediashare, 
        .pagenavigationarrows, .lastUpdated, .planCard
      `).remove();
    } else if (templateType === 'Legacy HelpX') {
      contentElement.find(`
        .TableOfContents, .helpxFooter, .internalBanner,
        .rightRailXf, .HelpX_Personalization, .planCard
      `).remove();
    }
    
    // Universal cleanup for both templates
    contentElement.find(`
      nav, .nav, .toc, .breadcrumb, .search, .actionItems,
      .sidebar, .productbadge, img, picture, .image, .video, iframe,
      style, script, .dexter-Spacer, .viewportSpecificContainer,
      .feedback, .globalnavfooter, .evidon-notice-link,
      div:empty, p:empty, span:empty
    `).remove();

    let content = contentElement.html();
    
    // Convert to markdown
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      remove: ['style', 'script', 'img', 'picture', 'iframe', 'svg']
    });

    content = turndown.turndown(content);

    // Clean up footer sections
    const footerCutoffPatterns = [
      /^#{1,6}\s*Have a question or an idea.*/ms,
      /^#{1,6}\s*More like this.*/ms,
      /^#{1,6}\s*Share this page.*/ms,
      /^#{1,6}\s*Was this page helpful.*/ms,
      /^More like this.*/ms,
      /^Share this page.*/ms
    ];

    for (const pattern of footerCutoffPatterns) {
      const match = content.match(pattern);
      if (match) {
        content = content.substring(0, match.index).trim();
        break;
      }
    }

    // Format output based on preference
    if (!markdown) {
      // Convert to plain text
      content = content
        .replace(/^#{1,6}\s+(.+)$/gm, '\n\n--- $1 ---\n\n')
        .replace(/^\* (.+)$/gm, '• $1')
        .replace(/^\d+\.\s+(.+)$/gm, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\s+|\s+$/g, '')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ');
      
      content = ' ' + content;
    } else {
      content = content
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\s+|\s+$/g, '');
    }

    // Final validation
    const finalTextLength = content.replace(/\s/g, '').length;
    if (finalTextLength < 100) {
      return res.status(404).json({
        error: 'Extracted content appears to be too short',
        contentLength: finalTextLength,
        templateType
      });
    }

    const response = { 
      title: title.substring(0, 200),
      content: content
    };

    if (debug) {
      response.debug = {
        templateType,
        finalTextLength,
        url: fullUrl
      };
    }

    return res.json(response);
    
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ 
      error: error.message,
      url: fullUrl
    });
  }
};
