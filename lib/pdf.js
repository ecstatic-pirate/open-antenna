'use strict';

/**
 * Markdown → PDF conversion using md-to-pdf.
 *
 * md-to-pdf is a pure-npm solution — no pandoc or wkhtmltopdf required.
 * Suitable for npm global installs where system deps aren't guaranteed.
 */

const path = require('path');
const fs = require('fs');

/**
 * Convert a markdown file to PDF.
 *
 * @param {string} markdownPath - Absolute path to the .md file
 * @param {object} options
 * @param {string} [options.outputPath] - Override output path (default: same dir, .pdf extension)
 * @param {string} [options.cssPath] - Path to a custom CSS file for styling
 * @returns {Promise<string>} - Absolute path to the generated PDF
 */
async function convert(markdownPath, options = {}) {
  const { mdToPdf } = require('md-to-pdf');

  const resolved = path.resolve(markdownPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Markdown file not found: ${resolved}`);
  }

  const outputPath = options.outputPath
    ? path.resolve(options.outputPath)
    : resolved.replace(/\.md$/, '.pdf');

  const pdfOptions = {
    dest: outputPath,
    pdf_options: {
      format: 'A4',
      margin: {
        top: '20mm',
        bottom: '20mm',
        left: '18mm',
        right: '18mm',
      },
      printBackground: true,
    },
    stylesheet_encoding: 'utf-8',
  };

  // Apply custom CSS if provided
  if (options.cssPath && fs.existsSync(options.cssPath)) {
    pdfOptions.stylesheet = options.cssPath;
  } else {
    // Minimal default styles — clean, readable
    pdfOptions.css = `
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        line-height: 1.6;
        color: #1a1a1a;
        max-width: 100%;
      }
      h1 { font-size: 1.8em; border-bottom: 2px solid #333; padding-bottom: 0.3em; }
      h2 { font-size: 1.3em; margin-top: 1.5em; border-bottom: 1px solid #ccc; }
      h3 { font-size: 1.1em; margin-top: 1.2em; }
      a { color: #0066cc; text-decoration: none; }
      code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.9em; }
      pre { background: #f4f4f4; padding: 1em; border-radius: 4px; overflow-x: auto; }
      blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1em; color: #555; }
      table { border-collapse: collapse; width: 100%; margin: 1em 0; }
      th, td { border: 1px solid #ddd; padding: 0.5em 0.8em; text-align: left; }
      th { background: #f0f0f0; font-weight: 600; }
      hr { border: none; border-top: 1px solid #e0e0e0; margin: 1.5em 0; }
      ul, ol { padding-left: 1.5em; }
      li { margin: 0.3em 0; }
      em { font-style: italic; }
      strong { font-weight: 600; }
    `;
  }

  try {
    await mdToPdf({ path: resolved }, pdfOptions);
  } catch (err) {
    throw new Error(`PDF conversion failed: ${err.message}`);
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error(`PDF conversion appeared to succeed but file not found: ${outputPath}`);
  }

  return outputPath;
}

module.exports = { convert };
