#!/usr/bin/env node
// Reads page views per page from the Google Analytics 4 Data API and writes them as Jekyll data
// (docs/_data/pageviews.json), so every page of the static site can show its own count at build time.
// Nothing runs in the visitor's browser beyond the Google Analytics tag the site already has.
//
// Needs two secrets (see dev/publishing.md); without them it exits quietly and the site builds without counts:
//   GA_PROPERTY_ID  numeric GA4 property id (Admin → Property settings), not the G-… measurement id
//   GA_CREDENTIALS  JSON key of a Google Cloud service account that has Viewer access to the property
import { createSign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const out = process.argv[2] ?? 'docs/_data/pageviews.json';
const BASEURL = process.env.SITE_BASEURL ?? '/localpilot';
const TOKEN_URL = process.env.GA_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
const DATA_URL = process.env.GA_DATA_URL ?? 'https://analyticsdata.googleapis.com/v1beta';
const START = process.env.GA_START_DATE ?? '2020-01-01';

const property = process.env.GA_PROPERTY_ID?.trim();
const credentials = process.env.GA_CREDENTIALS?.trim();
if (!property || !credentials) {
  console.log('page views: GA_PROPERTY_ID / GA_CREDENTIALS not set — building without view counts');
  process.exit(0);
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** OAuth access token for the service account (JWT bearer grant), read-only Analytics scope. */
async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) {
    throw new Error(`token: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()).access_token;
}

async function report(token, body) {
  const res = await fetch(`${DATA_URL}/properties/${encodeURIComponent(property)}:runReport`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ dateRanges: [{ startDate: START, endDate: 'today' }], ...body }),
  });
  if (!res.ok) {
    throw new Error(`runReport: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** `/localpilot/docs/models/index.html?x=1` → `/docs/models/`, matching Jekyll's `page.url`. */
export function normalizePath(raw) {
  let p = String(raw || '/').split(/[?#]/)[0];
  if (BASEURL && (p === BASEURL || p.startsWith(`${BASEURL}/`))) {
    p = p.slice(BASEURL.length);
  }
  p = p.replace(/\/index\.html$/, '/').replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) {
    p = `/${p}`;
  }
  // Pages are served as /docs/models/ but are sometimes requested without the slash.
  if (!/\.[a-z0-9]+$/i.test(p) && !p.endsWith('/')) {
    p += '/';
  }
  return p;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const label = (n) => compact.format(n);

const key = JSON.parse(credentials);
const token = await accessToken(key);
const [byPage, totals] = await Promise.all([
  report(token, { dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], limit: 100000 }),
  // Visitors are counted once for the whole site; summing per-page users would count them once per page.
  report(token, { metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }] }),
]);

const pages = {};
for (const row of byPage.rows ?? []) {
  const path = normalizePath(row.dimensionValues?.[0]?.value);
  const views = Number(row.metricValues?.[0]?.value) || 0;
  pages[path] = (pages[path] ?? 0) + views;
}
const views = Number(totals.rows?.[0]?.metricValues?.[0]?.value) || Object.values(pages).reduce((a, b) => a + b, 0);
const users = Number(totals.rows?.[0]?.metricValues?.[1]?.value) || 0;
const data = {
  updated: new Date().toISOString(),
  total: { views, users, views_label: label(views), users_label: label(users) },
  pages: Object.fromEntries(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b)).map(([p, v]) => [p, { views: v, label: label(v) }])),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
console.log(`page views: ${views} views by ${users} visitors across ${Object.keys(pages).length} pages → ${out}`);
