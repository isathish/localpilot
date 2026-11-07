// AWS Signature Version 4 (the request signing of S3 and every S3-compatible storage: R2, MinIO, B2, Wasabi),
// implemented with node:crypto only. https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
// Pure Node.
import * as crypto from 'crypto';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  url: URL;
  /** Lower-case or any case; signed as given (every header passed here is signed). */
  headers: Record<string, string>;
  /** hex sha256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
  region: string;
  service: string;
  /** Request time (tests). */
  date?: Date;
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const sha256Hex = (b: Uint8Array | string): string => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as SigV4 wants it (`/` kept in paths when `keepSlash`). */
export function uriEncode(s: string, keepSlash = false): string {
  let out = '';
  for (const ch of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) {
      out += c;
    } else {
      out += `%${ch.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** `20150830T123600Z`. */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  url.searchParams.forEach((v, k) => pairs.push([uriEncode(k), uriEncode(v)]));
  pairs.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** The path as S3 signs it: each segment URI-encoded once (decoded first, so an already-encoded URL is not double-encoded). */
function canonicalPath(url: URL): string {
  const p = url.pathname || '/';
  return p
    .split('/')
    .map((seg) => uriEncode(safeDecode(seg)))
    .join('/');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface Signed {
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/** Signs a request: returns the headers to send (the input headers plus x-amz-date, x-amz-content-sha256 for S3, Authorization). */
export function signV4(req: SigV4Request, cred: SigV4Credentials): Signed {
  const date = req.date ?? new Date();
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k.toLowerCase()] = v;
  }
  headers.host ??= req.url.host;
  headers['x-amz-date'] = stamp;
  if (req.service === 's3') {
    headers['x-amz-content-sha256'] = req.payloadHash;
  }
  if (cred.sessionToken) {
    headers['x-amz-security-token'] = cred.sessionToken;
  }
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [req.method.toUpperCase(), canonicalPath(req.url), canonicalQuery(req.url), canonicalHeaders, signedHeaders, req.payloadHash].join('\n');
  const scope = `${day}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${cred.secretAccessKey}`, day);
  const kRegion = hmac(kDate, req.region);
  const kService = hmac(kRegion, req.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}

/** Parses an Authorization header (fake servers verify requests with it). */
export function parseAuthorization(h: string): { accessKeyId: string; scope: string; signedHeaders: string[]; signature: string } | undefined {
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(h.trim());
  return m ? { accessKeyId: m[1], scope: m[2], signedHeaders: m[3].split(';'), signature: m[4] } : undefined;
}
