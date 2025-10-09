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
          .titleBar, .globalnavheader, .globalNav
