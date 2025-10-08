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

  const { url, format = 'json', debug } = req.query;
  
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
    
    // Extract title and metadata
    let title = $('h1').first().text().trim() || 
                $('.page-title').text().trim() ||
                $('title').text().replace(/\s*[|\-].*$/i, '').trim() ||
                'Untitled Article';

    // Extract SEO metadata
    const seoTitle = $('meta[name="title"]').attr('content') || 
                     $('meta[property="og:title"]').attr('content') || 
                     $('title').text().trim() || 
                     title;

    const seoDescription = $('meta[name="description"]').attr('content') || 
                          $('meta[property="og:description"]').attr('content') || 
                          '';

    // Extract publish date - try multiple possible meta tag names
    const publishDate = $('meta[name="publishDate"]').attr('content') ||
                       $('meta[name="publishExternalUrl"]').attr('content') ||
                       $('meta[name="lastModifiedDate"]').attr('content') ||
                       $('meta[name="firstPublishedLive"]').attr('content') ||
                       $('meta[property="article:published_time"]').attr('content') ||
                       '';

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

    console.log(`Template detection: HelpNext=${helpNextIndicators}, LegacyHelpX=${legacyHelpXIndicators}`);

    if (helpNextIndicators) {
      templateType = 'HelpNext';
      console.log('Detected HelpNext template');
      
      // For HelpNext, try to get the main article content area
      let potentialElements = [
        $('#helpxNext-article-right-rail .responsivegrid'),
        $('.content .responsivegrid'),
        $('main .responsivegrid'),
        $('.aem-Grid .responsivegrid')
      ];
      
      // Find the element with the most substantial text content
      let bestElement = null;
      let maxTextLength = 0;
      
      potentialElements.forEach((element, index) => {
        if (element.length) {
          // Create a copy and clean it up to test content quality
          const testElement = element.clone();
          testElement.find('nav, .toc, .breadcrumb, .search, .titleBar, .globalnavheader').remove();
          const textLength = testElement.text().trim().length;
          
          console.log(`HelpNext selector ${index}: found ${element.length} elements, text length: ${textLength}`);
          
          if (textLength > maxTextLength && textLength > 200) {
            maxTextLength = textLength;
            bestElement = element;
            console.log(`New best element found with ${textLength} characters`);
          }
        }
      });
      
      if (bestElement && bestElement.length) {
        contentElement = bestElement;
        console.log(`Using HelpNext element with ${maxTextLength} characters`);
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
    
    // Remove footer-style content before conversion
    contentElement.find('h2, h3, h4').each(function() {
      const headerText = $(this).text().toLowerCase();
      if (headerText.includes('more like this') || 
          headerText.includes('talk to us') ||
          headerText.includes('have a question') ||
          headerText.includes('related resources') ||
          headerText.includes('share this page')) {
        // Remove this header and everything after it
        $(this).nextAll().remove();
        $(this).remove();
      }
    });

    let content = contentElement.html();
    
    // Convert to markdown
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      remove: ['style', 'script', 'img', 'picture', 'iframe', 'svg']
    });

    content = turndown.turndown(content);

    // Clean up footer sections - expanded patterns
    const footerCutoffPatterns = [
      // Standard Adobe Help footer patterns
      /^#{1,6}\s*Have a question or an idea.*/ms,
      /^#{1,6}\s*More like this.*/ms,
      /^#{1,6}\s*Share this page.*/ms,
      /^#{1,6}\s*Was this page helpful.*/ms,
      /^#{1,6}\s*Talk to us.*/ms,
      /^#{1,6}\s*Related resources.*/ms,
      
      // Without heading markers
      /^Have a question or an idea.*/ms,
      /^More like this.*/ms,
      /^Share this page.*/ms,
      /^Talk to us.*/ms,
      /^Related topics.*/ms,
      /^See also.*/ms,
      /^Related resources.*/ms,
      
      // HTML patterns that might leak through
      /<h[1-6][^>]*>.*More like this.*<\/h[1-6]>/ms,
      /<h[1-6][^>]*>.*Talk to us.*<\/h[1-6]>/ms,
      /<h[1-6][^>]*>.*Have a question.*<\/h[1-6]>/ms,
      
      // Span variations
      /More like this<\/span>/ms,
      /Talk to us<\/span>/ms
    ];

    for (const pattern of footerCutoffPatterns) {
      const match = content.match(pattern);
      if (match) {
        content = content.substring(0, match.index).trim();
        break;
      }
    }

    // Format output based on preference
    let outputAsMarkdown = (format === 'markdown');
    
    if (!outputAsMarkdown) {
      // Convert to plain text for both 'json' and 'text' formats
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
      // Keep as markdown
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

    // Build response based on requested format
    if (format === 'text') {
      // Pure text response for RAG systems
      let textResponse = `TITLE: ${title}\n\n`;
      
      if (seoTitle && seoTitle !== title) {
        textResponse += `SEO TITLE: ${seoTitle}\n\n`;
      }
      
      if (seoDescription) {
        textResponse += `DESCRIPTION: ${seoDescription}\n\n`;
      }
      
      if (publishDate) {
        textResponse += `PUBLISHED: ${publishDate}\n\n`;
      }
      
      textResponse += `CONTENT:\n${content}`;
      
      // Return plain text response
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(textResponse);
      
    } else if (format === 'markdown') {
      // Pure markdown with YAML front matter
      let markdownResponse = '---\n';
      markdownResponse += `title: "${title.replace(/"/g, '\\"')}"\n`;
      
      if (seoTitle && seoTitle !== title) {
        markdownResponse += `seoTitle: "${seoTitle.replace(/"/g, '\\"')}"\n`;
      }
      
      if (seoDescription) {
        markdownResponse += `description: "${seoDescription.replace(/"/g, '\\"')}"\n`;
      }
      
      if (publishDate) {
        markdownResponse += `publishDate: "${publishDate}"\n`;
      }
      
      markdownResponse += `url: "${fullUrl}"\n`;
      markdownResponse += '---\n\n';
      markdownResponse += content;
      
      // Return markdown response
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.send(markdownResponse);
      
    } else {
      // Default JSON response
      const response = { 
        title: title.substring(0, 200),
        metadata: {
          seoTitle: seoTitle.substring(0, 300),
          seoDescription: seoDescription.substring(0, 500),
          publishDate: publishDate
        },
        content: content
      };

      if (debug) {
        response.debug = {
          templateType,
          finalTextLength,
          url: fullUrl,
          helpNextIndicators,
          legacyHelpXIndicators,
          contentFoundLength: contentElement ? contentElement.length : 0,
          rawContentLength: contentElement ? contentElement.text().length : 0
        };
      }

      return res.json(response);
    }
    
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ 
      error: error.message,
      url: fullUrl
    });
  }
};
