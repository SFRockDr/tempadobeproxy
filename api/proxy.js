// /api/proxy.js
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import gfmPlugin from 'turndown-plugin-gfm';           // CJS default import
import { JSDOM } from 'jsdom';                          // top-level ESM import
import { Readability } from '@mozilla/readability';     // top-level ESM import

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, format = 'json', debug } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parameter required' });

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
    // Fetch HTML via ScrapeOwl
    const scrapeOwlUrl =
      `https://api.scrapeowl.com/v1/scrape?api_key=${SCRAPEOWL_API_KEY}&url=${encodeURIComponent(fullUrl)}`;
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

    // Extract title and metadata
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

    // Detect template type and select content region
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
      contentElement = $('main .aem-Grid').first();
    }

    // Extract HTML (selector path or Readability fallback)
    let htmlContent = '';
    let selectorUsed = null;

    if (contentElement && contentElement.length > 0) {
      selectorUsed =
        templateType === 'HelpNext'
          ? '#helpxNext-article-right-rail .responsivegrid > .aem-Grid'
          : templateType === 'Legacy HelpX'
          ? '#root_content_flex_items_position .aem-Grid'
          : 'main .aem-Grid';

      // Preserve experience fragments via placeholder round-trip
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
    } else {
      // Readability fallback
      const dom = new JSDOM(scrapeData.html, { url: fullUrl });
      const article = new Readability(dom.window.document).parse();
      if (article?.content) {
        htmlContent = article.content; // cleaned HTML
        selectorUsed = 'Readability';
      } else {
        return res.status(404).json({
          error: 'No suitable content found on this page',
          templateType,
          bodyClass,
          url: fullUrl
        });
      }
    }

    if (!htmlContent || !htmlContent.trim()) {
      return res.status(404).json({
        error: 'Extracted content appears to be empty',
        templateType,
        url: fullUrl
      });
    }

    // Post-extraction HTML normalization
    const $content = cheerio.load(htmlContent);

    // Transform helpx-note → <p><strong>Note:</strong> ...</p>
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

    // Secondary footer cutoff safety
    const cutoffHeaders = ['have a question', 'more like this', 'talk to us'];
    let cutoff = false;
    $content('h1,h2,h3,h4,h5,h6').each(function () {
      if (cutoff) return;
      const t = $content(this).text().toLowerCase().trim();
      if (cutoffHeaders.some((k) => t.includes(k))) {
        let node = $content(this);
        while (node.next().length) node.next().remove();
        node.remove();
        cutoff = true;
      }
    });

    // --- Hoist tables out of list items so GFM table → Markdown works ---
    $content('li table').each(function () {
    const $table = $content(this);
   
    const $li = $table.closest('li');
    $table.insertAfter($li); // keeps per-item order

    // Optional: leave a hint inside the list item
    const txt = $li.text().trim();
    if (!/table below\.?$/i.test(txt)) {
        $li.append(' — see table below.');
    }
    });

    // --- Normalize tables so GFM converter can emit Markdown tables ---
    function normalizeTables($content) {
    // 1) Unwrap trivial wrappers inside cells
    $content('table').each(function () {
        const t = $content(this);
        ['class','width','border','cellpadding','cellspacing','style']
            .forEach(a => t.removeAttr(a));
        t.find('thead, tbody').each(function () {
        const el = $content(this);
        // unwrap <tbody>/<thead> so rows are direct children (simplifies DOM)
        el.replaceWith(el.html());
        });

        // 2) For every cell, convert blocks to inline with <br> separators
        t.find('th, td').each(function () {
        const cell = $content(this);

        // lists -> bullet lines with <br>
        cell.find('ul, ol').each(function () {
            const list = $content(this);
            const bullet = list.is('ol') ? (i) => `${i + 1}. ` : () => '• ';
            const lines = [];
            list.children('li').each(function (i) {
            const liText = $content(this).text().trim();
            if (liText) lines.push(bullet(i) + liText);
            });
            list.replaceWith(lines.length ? lines.join('<br>') : '');
        });

        // paragraphs -> joined with <br>
        cell.find('p').each(function () {
            const p = $content(this);
            const txt = p.text().trim();
            p.replaceWith(txt ? `${txt}<br>` : '');
        });

        // trivial div/span wrappers -> keep text
        cell.find('div, span').each(function () {
            const el = $content(this);
            if (!el.children().length) el.replaceWith(el.text());
        });

        // collapse multiple <br> to single
        cell.html((cell.html() || '').replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br>'));

        // 3) Escape pipes so GFM doesn’t split columns inside text
        const plain = cell.html() || '';
        cell.html(
            plain
            // encode literal '|' that aren’t part of HTML
            .replace(/\|/g, '\\|')
            // remove leftover non-breaking spaces that confuse widths
            .replace(/&nbsp;/g, ' ')
        );

        // 4) Trim ending <br>
        cell.html((cell.html() || '').replace(/(<br\s*\/?>\s*)+$/i, ''));
        });
    });

    // add padding newlines so Markdown parsers recognize the table block
    $content('table').each(function () {
        const tbl = $content(this);
        tbl.before('\n\n');
        tbl.after('\n\n');
    });
    }

    normalizeTables($content);

    // Convert to Markdown (Turndown + GFM)
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-'
      // unknown options like `remove` are ignored by Turndown
    });

    // custom Turndown rule that converts any residual <table> to a pipe table
    turndown.addRule('pipeTablesForce', {
    filter: function (node) {
        return node.nodeName === 'TABLE';
    },
    replacement: function (content, node) {
        // Collect rows
        const rows = Array.from(node.querySelectorAll('tr')).map(tr =>
        Array.from(tr.children)
            .filter(td => td.nodeName === 'TD' || td.nodeName === 'TH')
            .map(td => {
            // cell text: collapse whitespace, strip inner tags
            const txt = td.textContent
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            // escape pipes
            return txt.replace(/\|/g, '\\|');
            })
        ).filter(cells => cells.length);

        if (!rows.length) return '\n\n'; // nothing useful

        // Header = first row if it contains any TH; else synthesize from first row
        const firstHasTH = Array.from(node.querySelectorAll('tr')[0]?.children || [])
        .some(c => c.nodeName === 'TH');

        const header = firstHasTH ? rows[0] : [];
        const body = firstHasTH ? rows.slice(1) : rows;

        const pad = (cells) => `| ${cells.join(' | ')} |`;
        const sep  = `| ${header.map(() => '---').join(' | ')} |`;

        const md = header.length
          ? [pad(header), sep, ...body.map(pad)].join('\n')
          : body.map(pad).join('\n');

        return `\n\n${md}\n\n`;
    }
    });


    const { strikethrough, taskListItems } = gfmPlugin;
    turndown.use([strikethrough, taskListItems]); // no table rule from plugin

    turndown.keep(['br']); // preserve <br> as hard line breaks

    let content = turndown.turndown($content.html() || '');
    content = content.replace(/\n{3,}/g, '\n\n').trim();

    // Clean up markdown footer sections (pattern-based)
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

    // Final validation
    const finalTextLength = content.replace(/\s/g, '').length;
    if (finalTextLength < 100) {
      return res.status(404).json({
        error: 'Extracted content appears to be too short',
        contentLength: finalTextLength,
        templateType
      });
    }

    // Respond by requested format

    if (format === 'text') {
    // Flatten Markdown tables to line-based text for LLM ingestion
    // Example:
    // | Tool | Windows | Mac OS |
    // | ---  | ---     | ---    |
    // | Selection tool | V, Esc | V, Esc |
    //
    // becomes:
    // Tool: Selection tool | Windows: V, Esc | Mac OS: V, Esc
    content = content.replace(
        /\n\|(.+?)\|\n\|(?:\s*[-:]+\s*\|)+\n([\s\S]+?)(?=\n{2,}|$)/g,
        (match, header, body) => {
        const headers = header.split('|').map(h => h.trim()).filter(Boolean);
        const rows = body
            .trim()
            .split('\n')
            .map(r => r.split('|').map(c => c.trim()).filter(Boolean))
            .filter(arr => arr.length);

        const lines = rows.map(cells => {
            if (headers.length && cells.length === headers.length) {
            return headers.map((h, i) => `${h}: ${cells[i]}`).join(' | ');
            }
            return cells.join(' | ');
        });

        return '\n' + lines.join('\n') + '\n';
        }
    );

    let textResponse = `TITLE: ${title}\n\n`;
    if (seoTitle && seoTitle !== title) textResponse += `SEO TITLE: ${seoTitle}\n\n`;
    if (seoDescription) textResponse += `DESCRIPTION: ${seoDescription}\n\n`;
    if (publishDate) textResponse += `PUBLISHED: ${publishDate}\n\n`;
    textResponse += `CONTENT:\n${content
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
      md += content;

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.send(md);
    }

    // Default JSON
    const response = {
      title: title.substring(0, 200),
      metadata: {
        seoTitle: (seoTitle || '').substring(0, 300),
        seoDescription: (seoDescription || '').substring(0, 500),
        publishDate
      },
      content
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
    return res.status(500).json({ error: error.message, url: fullUrl });
  }
}
