#!/usr/bin/env node
/**
 * Builds media/localpilot.woff — the icon font behind `$(localpilot-logo)` (contributes.icons).
 * Fonts need filled outlines, so the glyph is a solid version of media/icon.svg: speech bubble with
 * two cut-out eyes and an antenna. Run `npm run icons` after changing the glyph.
 */
const fs = require('fs');
const path = require('path');
const { SVGIcons2SVGFontStream } = require('svgicons2svgfont');
const svg2ttf = require('svg2ttf');
const ttf2woff = require('ttf2woff');

const GLYPHS = {
  // Bubble (clockwise) + eyes drawn counter-clockwise so nonzero winding punches holes; antenna stem + dot.
  'localpilot-logo': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path fill="#000" fill-rule="nonzero" d="M6.5 3h11A3.5 3.5 0 0 1 21 6.5v7a3.5 3.5 0 0 1-3.5 3.5h-4.1l-4.9 4.3V17H6.5A3.5 3.5 0 0 1 3 13.5v-7A3.5 3.5 0 0 1 6.5 3z
    M9 8.1a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z M15 8.1a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z
    M11.2 1.4h1.6v2.2h-1.6z M12 0a1.1 1.1 0 1 1 0 2.2A1.1 1.1 0 0 1 12 0z"/>
</svg>`,
  // Amber spark used for "thinking"/highlights.
  'localpilot-spark': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path fill="#000" d="M12 1.5l2.4 6.1L20.5 10l-6.1 2.4L12 18.5l-2.4-6.1L3.5 10l6.1-2.4z M19 15l1.1 2.9L23 19l-2.9 1.1L19 23l-1.1-2.9L15 19l2.9-1.1z"/>
</svg>`,
};

// Codepoints are stable so saved layouts/settings keep working.
const CODEPOINTS = { 'localpilot-logo': 0xe900, 'localpilot-spark': 0xe901 };

async function main() {
  const out = path.join(__dirname, '..', 'media', 'localpilot.woff');
  const fontStream = new SVGIcons2SVGFontStream({ fontName: 'localpilot', fontHeight: 1000, normalize: true, log: () => {} });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    fontStream.on('data', (c) => chunks.push(c));
    fontStream.on('end', resolve);
    fontStream.on('error', reject);
  });
  for (const [name, svg] of Object.entries(GLYPHS)) {
    const { Readable } = require('stream');
    const glyph = Readable.from([svg]);
    glyph.metadata = { name, unicode: [String.fromCodePoint(CODEPOINTS[name])] };
    fontStream.write(glyph);
  }
  fontStream.end();
  await done;
  const svgFont = chunks.map((c) => (typeof c === 'string' ? c : c.toString('utf8'))).join('');
  const ttf = svg2ttf(svgFont, { description: 'LocalPilot icon font', url: 'https://isathish.github.io/localpilot/' });
  const woff = ttf2woff(new Uint8Array(ttf.buffer));
  fs.writeFileSync(out, Buffer.from(woff.buffer));
  console.log(`wrote ${path.relative(process.cwd(), out)} (${woff.buffer.byteLength} bytes): ${Object.keys(GLYPHS).map((g) => `${g}=\\${CODEPOINTS[g].toString(16)}`).join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
