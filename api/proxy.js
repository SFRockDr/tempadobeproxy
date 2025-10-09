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

    const seoTitle = $('meta[name="title"]').attr('content') || 
                     $('meta[property="og:title"]').attr('content') || 
                     $('title').text().trim() || 
                     title;

    const seoDescription = $('meta[name="description"]').attr('content') || 
                          $('meta[property="og:description"]').attr('content') || 
                          '';

    const publishDate = $('meta[name="publishDate"]').attr('content') ||
                       $('meta[name="publishExternalUrl"]').attr('content') ||
                       $('meta[name="lastModifiedDate"]').attr('content') ||
                       $('meta[name="firstPublishedLive"]').attr('content') ||
                       $('meta[property="article:published_time"]').attr('content') ||
                       '';

    // Detect template type
    let contentElement;
    let templateType;
    const bodyClass = $('body').attr('class') || '';

    if (bodyClass.includes('helpxNext-article')) {
      templateType = 'HelpNext';
      console.log('Detected HelpNext template');
      contentElement = $('#helpxNext-article-right-rail .responsivegrid > .aem-Grid').first();
      
    } else if (bodyClass.includes('helpxMain-article')) {
      templateType = 'Legacy HelpX';
      console.log('Detected Legacy HelpX template');
      contentElement = $('#root_content_flex_items_position .aem-Grid').first();
      
    } else {
      templateType = 'Unknown';
      console.log('Unknown template, attempting fallback');
      // Fallback to generic selectors
      contentElement = $('main .aem-Grid').first();
    }

    if (!contentElement || contentElement.length === 0) {
      return res.status(404).json({ 
        error: 'No suitable content found on this page',
        templateType,
        bodyClass,
        url: fullUrl
      });
    }

    // Extract and preserve xfreference content BEFORE general cleanup
    const xfReferenceContent = [];
    contentElement.find('.xfreference.experiencefragment').each(function() {
      const $this = $(this);
      
      // Clone the element so we can clean it without affecting the original yet
      const $clone = $this.clone();
      
      // Clean up the cloned content
      $clone.find('style, script, img, picture, iframe, svg').remove();
      $clone.find('[class*="dexter-"]').removeAttr('class');
      $clone.find('[id]').removeAttr('id');
      $clone.find('[style]').removeAttr('style');
      
      // Get the cleaned content
      const xfContent = $clone.html();
      if (xfContent && xfContent.trim()) {
        xfReferenceContent.push(xfContent);
        // Replace the original element with a placeholder
        $this.replaceWith(`<!--XF_REFERENCE_${xfReferenceContent.length - 1}-->`);
      } else {
        // If nothing left after cleanup, just remove it
        $this.remove();
      }
    });

    // Universal cleanup - remove navigation, images, and UI elements
    contentElement.find(`
    nav, .nav, .toc, .TableOfContents, .breadcrumb, .search, 
    .titleBar, .globalnavheader, .globalNavHeader, .globalnavfooter,
    .feedbackV2, .socialmediashare,
    .pagenavigationarrows, .lastUpdated, .planCard, .productbadge,
    .sidebar, .actionItems, .rightRailXf, .HelpX_Personalization,
    img, picture, .image, video, iframe, svg,
    style, script, .dexter-Spacer, .viewportSpecificContainer,
    .feedback, .evidon-notice-link, .internalBanner,
    div:empty, p:empty, span:empty
    `).remove();    
    
    // Remove footer-style content - hard cutoff at common footer headers
    let cutoffFound = false;
    contentElement.find('h1, h2, h3, h4, h5, h6').each(function() {
      if (cutoffFound) return;
      
      const headerText = $(this).text().toLowerCase().trim();
      
      if (headerText.includes('more like this') || 
          headerText.includes('talk to us') ||
          headerText.includes('have a question') ||
          headerText.includes('related resources') ||
          headerText.includes('share this page') ||
          headerText.includes('was this helpful')) {
        
        console.log(`Found footer cutoff at: ${headerText}`);
        $(this).nextAll().remove();
        $(this).remove();
        cutoffFound = true;
      }
    });

    let content = contentElement.html();

    // Restore xfreference content
    xfReferenceContent.forEach((xfContent, index) => {
    content = content.replace(
        `<!--XF_REFERENCE_${index}-->`,
        xfContent
    );
    });

    // Convert to markdown
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      remove: ['style', 'script', 'img', 'picture', 'iframe', 'svg']
    });

    content = turndown.turndown(content);

    // Clean up markdown footer sections
    const footerCutoffPatterns = [
      /^#{1,6}\s*Have a question or an idea.*/ms,
      /^#{1,6}\s*More like this.*/ms,
      /^#{1,6}\s*Talk to us.*/ms
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
      // Convert to plain text - keep paragraph breaks
      content = content
        .replace(/^#{1,6}\s+(.+)$/gm, '\n\n--- $1 ---\n\n')
        .replace(/^\* (.+)$/gm, '• $1')
        .replace(/^\d+\.\s+(.+)$/gm, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\n{3,}/g, '\n\n')  // Normalize to double line breaks
        .replace(/^\s+|\s+$/g, '');
      
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
      
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(textResponse);
      
    } else if (format === 'markdown') {
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
          bodyClass,
          finalTextLength,
          url: fullUrl,
          selectorUsed: templateType === 'HelpNext' 
            ? '#helpxNext-article-right-rail .responsivegrid > .aem-Grid'
            : '#root_content_flex_items_position .aem-Grid'
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
}

