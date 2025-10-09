// /api/proxy.js
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import turndownPluginGfm from 'turndown-plugin-gfm';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // --- Params ---
  const { url, format = 'json', debug } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parameter required' });

  // Accept both absolute and relative HelpX paths
  const fullUrl = url.startsWith('http')
    ? url
    : `https://helpx.adobe.com/${url.replace(/^\/+/, '')}`;

  const SCRAPEOWL_API_KEY = process.env.SCRAPEOWL_API_KEY;
  if (!SCRAPEOWL_API_KEY) {
    return res.status(500).json({
      error: 'SCRAPEOWL_API_KEY not configured in Vercel environment variables'
    });
  }

  try {
    // --- Fetch HTML via ScrapeOwl ---
    const scrapeOwlUrl = `https://api.scrapeowl.com/v1/scrape?api_key=${SCRAPEOWL_API_KEY}&url=${encodeURIComponent(fullUrl)}`;
    const scrapeResponse = await fetch(scrapeOwlUrl);
    if (!scrapeResponse.ok) {
      return res.status(scrapeResponse.status).json({
        error: `ScrapeOwl request failed (${scrapeResponse.status})`
      });
    }
    const scrapeData = await scrapeResponse.json();
    if (!scrapeData?.html) {
      return res.status(502).json({ error: 'ScrapeOwl returned no HTML', response: scrapeData });
    }

    const $ = cheerio.load(scrapeData.html);

    // --- Metadata ---
    let title =
      $('h1').first().text().trim() ||
      $('.page-title').text().trim() ||
      $('title').text().replace(/\s*[|\-].*$/i, '').trim() ||
      'Untitled Article';

    const seoTitle =
      $('meta[name="title"]').attr('content') ||
      $('meta[property="og:title"]').attr('content') ||
      $('title').text().trim() ||
      title;

    const seoDescription =
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      '';

    const publishDate =
      $('meta[name="publishDate"]').attr('content') ||
      $('meta[name="publishExternalUrl"]').attr('content') ||
      $('meta[name="lastModifiedDate"]').attr('content') ||
      $('meta[name="firstPublishedLive"]').attr('content') ||
      $('meta[property="article:published_time"]').attr('content') ||
      '';

    // --- Template detection ---
    let templateType = 'Unknown';
    let contentElement = null;
    const bodyClass = $('body').attr('class') || '';

    if (bodyClass.includes('helpxNext-article')) {
      templateType = 'HelpNext';
      contentElement = $('#helpxNext-article-right-rail .responsivegrid > .aem-Grid').first();
    } else if (bodyClass.includes('helpxMain-article')) {
      templateType = 'Legacy HelpX';
      contentElement = $('#root_content_flex_items_position .aem-Grid').first();
    } else {
      // Generic fallback selector try
      contentElement = $('main .aem-Grid').first();
    }

    // --- Primary extraction OR Readability fallback ---
    let htmlContent = '';
    let selectorUsed = null;

    if (contentElement && contentElement.length > 0) {
      selectorUsed =
        templateType === 'HelpNext'
          ? '#helpxNext-article-right-rail .responsivegrid > .aem-Grid'
          : templateType === 'Legacy HelpX'
          ? '#root_content_flex_items_position .aem-Grid'
          : 'main .aem-Grid';
    }

    if (!contentElement || contentElement.length === 0) {
      // Readability fallback on entire document
      const dom = new JSDOM(scrapeData.html, { url: fullUrl });
      const article = new Readability(dom.window.document).parse();
      if (article?.content) {
        htmlContent = article.content; // already a cleaned HTML chunk
        selectorUsed = 'Readability';
      } else {
        return res.status(404).json({
          error: 'No suitable content found on this page',
          templateType,
          bodyClass,
          url: fullUrl
        });
      }
    } else {
      // --- Pre-extraction cleanup on the selected region ---
      // Preserve experience fragments content via placeholder round-trip (avoid losing body when stripping)
      const xfReferenceContent = [];
      contentElement.find('.xfreference.experiencefragment').each(function () {
        const $this = $(this);
        const $clone = $this.clone();
        $clone.find('style, script, img, picture, iframe, svg').remove();
        $clone.find('[class*="dexter-"]').removeAttr('class');
        $clone.find('[id]').removeAttr('id');
        $clone.find('[style]').removeAttr('style');
        const xf = $clone.html();
        if (xf && xf.trim()) {
          xfReferenceContent.push(xf);
          $this.replaceWith(`<!--XF_REFERENCE_${xfReferenceContent.length - 1}-->`);
        } else {
          $this.remove();
        }
      });

      // Remove chrome, media, UI, trackers, empties
      contentElement
        .find(`
          nav, .nav, .toc, .TableOfContents, .breadcrumb, .search,
          .titleBar, .globalnavheader, .globalNavHeader, .globalnavfooter,
          .feedbackV2, .socialmediashare, .pagenavigationarrows, .lastUpdated,
          .planCard, .productbadge, .sidebar, .actionItems, .rightRailXf,
          .HelpX_Personalization, img, picture, .image, video, iframe, svg,
          style, script, .dexter-Spacer, .viewportSpecificContainer,
          .feedback, .evidon-notice-link, .internalBanner,
          div:empty, p:empty, span:empty
        `)
        .remove();

      // Footer cutoff (remove everything after common footer headers)
      let cutoffFound = false;
      contentElement.find('h1, h2, h3, h4, h5, h6').each(function () {
        if (cutoffFound) return;
        const headerText = $(this).text().toLowerCase().trim();
        if (
          headerText.includes('more like this') ||
          headerText.includes('talk to us') ||
          headerText.includes('have a question') ||
          headerText.includes('related resources') ||
          headerText.includes('share this page') ||
          headerText.includes('was this helpful')
        ) {
          $(this).nextAll().remove();
          $(this).remove();
          cutoffFound = true;
        }
      });

      htmlContent = contentElement.html() || '';

      // Restore experience fragments
      if (xfReferenceContent.length > 0) {
        for (let i = 0; i < xfReferenceContent.length; i++) {
          htmlContent = htmlContent.replace(
            `<!--XF_REFERENCE_${i}-->`,
            xfReferenceContent[i]
          );
        }
      }
    }

    if (!htmlContent || !htmlContent.trim()) {
      return res.status(404).json({
        error: 'Extracted content appears to be empty',
        templateType,
        url: fullUrl
      });
    }

    // --- Post-extraction HTML normalization ---
    const $content = cheerio.load(htmlContent);

    // Normalize HelpX notes → strong + paragraph
    $content('.helpx-note').each(function () {
      const $note = $content(this);
      const noteTitle = $note.find('.note-title').text().trim() || 'Note';
      const noteText =
        $note.find('.cmp-text').text().trim() ||
        $note.find('p').text().trim();
      if (noteText) {
        $note.replaceWith(`<p><strong>${noteTitle}:</strong> ${noteText}</p>`);
      } else {
        $note.remove();
      }
    });

    // Canonicalize internal links and strip tracking params
    $content('a[href]').each(function () {
      const a = $content(this);
      const href = a.attr('href') || '';
      // Canonicalize internal HelpX links to absolute
      if (href.startsWith('/')) a.attr('href', `https://helpx.adobe.com${href}`);
      try {
        const u = new URL(a.attr('href'));
        ['utm_source', 'utm_medium', 'utm_campaign', 'scid'].forEach((p) =>
          u.searchParams.delete(p)
        );
        a.attr('href', u.toString());
      } catch {
        // ignore invalid URLs
      }
    });

    // Remove exact duplicate adjacent paragraphs (fragment merges)
    $content('p').each(function () {
      const cur = $content(this);
      const prev = cur.prev('p');
      if (prev.length && prev.text().trim() === cur.text().trim()) cur.remove();
    });

    // Footer cutoff in HTML (second pass safety)
    const cutoffHeaders = [
      'have a question',
      'more like this',
      'talk to us'
    ];
    let cutoff = false;
    $content('h1,h2,h3,h4,h5,h6').each(function () {
      if (cutoff) return;
      const t = $content(this).text().toLowerCase().trim();
      if (cutoffHeaders.some((k) => t.includes(k))) {
        // remove this header and everything after
        let node = $content(this);
        while (node.next().length) node.next().remove();
        node.remove();
        cutoff = true;
      }
    });

    // --- HTML → Markdown (Turndown + GFM) ---
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-'
      // NB: we rely on keep(['br']) for hard breaks
    });
    turndown.use([
      turndownPluginGfm.gfm,
      turndownPluginGfm.tables,
      turndownPluginGfm.strikethrough,
      turndownPluginGfm.taskListItems
    ]);
    turndown.keep(['br']); // preserve hard line breaks

    let markdown = turndown.turndown($content.html() || '');
    // Normalize whitespace
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

    // --- Final validation ---
    const finalTextLength = markdown.replace(/\s/g, '').length;
    if (finalTextLength < 100) {
      return res.status(404).json({
        error: 'Extracted content appears to be too short',
        contentLength: finalTextLength,
        templateType
      });
    }

    // --- Format responses ---
    if (format === 'text') {
      let textResponse = `TITLE: ${title}\n\n`;
      if (seoTitle && seoTitle !== title) textResponse += `SEO TITLE: ${seoTitle}\n\n`;
      if (seoDescription) textResponse += `DESCRIPTION: ${seoDescription}\n\n`;
      if (publishDate) textResponse += `PUBLISHED: ${publishDate}\n\n`;
      textResponse += `CONTENT:\n${markdown
        .replace(/^#{1,6}\s+(.+)$/gm, '\n\n--- $1 ---\n\n')
        .replace(/^\* (.+)$/gm, '• $1')
        .replace(/^\d+\.\s+(.+)$/gm, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim()}`;

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(textResponse);
    }

    if (format === 'markdown') {
      let md = '---\n';
      md += `title: "${title.replace(/"/g, '\\"')}"\n`;
      if (seoTitle && seoTitle !== title) md += `seoTitle: "${seoTitle.replace(/"/g, '\\"')}"\n`;
      if (seoDescription) md += `description: "${seoDescription.replace(/"/g, '\\"')}"\n`;
      if (publishDate) md += `publishDate: "${publishDate}"\n`;
      md += `url: "${fullUrl}"\n`;
      md += '---\n\n';
      md += markdown;

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.send(md);
    }

    // Default: JSON
    const response = {
      title: title.substring(0, 200),
      metadata: {
        seoTitle: (seoTitle || '').substring(0, 300),
        seoDescription: (seoDescription || '').substring(0, 500),
        publishDate
      },
      content: markdown
    };

    if (debug) {
      response.debug = {
        templateType,
        bodyClass,
        finalTextLength,
        url: fullUrl,
        selectorUsed
      };
    }

    return res.json(response);
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: error.message, url: url });
  }
}
