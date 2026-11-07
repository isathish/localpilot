// A fake S3-compatible server for sync tests (no network beyond 127.0.0.1): path-style bucket, ListObjectsV2 with
// continuation tokens (small pages), GET / HEAD / PUT / DELETE, `If-None-Match: *` (or 501 NotImplemented when
// conditional writes are switched off, like some S3-compatible stores), `If-Match`. Every request's SigV4 signature
// is recomputed with the shared secret; a mismatch answers 403 SignatureDoesNotMatch. Pure Node.
import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { parseAuthorization, sha256Hex, signV4 } from '../../continuity/sync/backends/sigv4';

export interface FakeS3 {
  url: string;
  keys(): string[];
  listCalls(): number;
  badSignatures(): number;
  setConditional(on: boolean): void;
  denyAll(on: boolean): void;
  close(): Promise<void>;
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function startFakeS3(o: { accessKeyId: string; secretAccessKey: string; bucket: string; pageSize?: number }): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; etag: string }>();
  let lists = 0;
  let bad = 0;
  let conditional = true;
  let deny = false;
  const pageSize = o.pageSize ?? 1000;
  const err = (res: http.ServerResponse, status: number, code: string, message = code) => {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`);
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      // ---- signature
      const auth = parseAuthorization(String(req.headers.authorization ?? ''));
      const amzDate = String(req.headers['x-amz-date'] ?? '');
      const payload = String(req.headers['x-amz-content-sha256'] ?? '');
      if (!auth || auth.accessKeyId !== o.accessKeyId || !/^\d{8}T\d{6}Z$/.test(amzDate)) {
        bad++;
        return err(res, 403, 'InvalidAccessKeyId');
      }
      const [, region, service] = auth.scope.split('/');
      const headers: Record<string, string> = {};
      for (const h of auth.signedHeaders) {
        if (h !== 'x-amz-date' && h !== 'x-amz-content-sha256') {
          headers[h] = String(req.headers[h] ?? '');
        }
      }
      const date = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
      const want = signV4({ method: req.method ?? 'GET', url, headers, payloadHash: payload, region, service, date }, { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey });
      if (want.signature !== auth.signature || (payload !== 'UNSIGNED-PAYLOAD' && payload !== sha256Hex(body))) {
        bad++;
        return err(res, 403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.');
      }
      if (deny) {
        return err(res, 403, 'AccessDenied', 'Access Denied');
      }
      // ---- routing (path style)
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const bucket = parts.shift();
      if (bucket !== o.bucket) {
        return err(res, 404, 'NoSuchBucket');
      }
      const key = parts.join('/');
      const method = req.method ?? 'GET';
      if (method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
        lists++;
        const prefix = url.searchParams.get('prefix') ?? '';
        const after = url.searchParams.get('continuation-token') ?? url.searchParams.get('start-after') ?? '';
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix) && (!after || k > after)).sort();
        const page = all.slice(0, pageSize);
        const truncated = all.length > pageSize;
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${o.bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>` +
            page.map((k) => `<Contents><Key>${xmlEscape(k)}</Key><LastModified>2024-01-01T00:00:00.000Z</LastModified><ETag>${xmlEscape(objects.get(k)!.etag)}</ETag><Size>${objects.get(k)!.body.length}</Size></Contents>`).join('') +
            (truncated ? `<NextContinuationToken>${xmlEscape(page[page.length - 1])}</NextContinuationToken>` : '') +
            '</ListBucketResult>'
        );
        return;
      }
      const cur = objects.get(key);
      switch (method) {
        case 'GET':
        case 'HEAD':
          if (!cur) {
            return method === 'HEAD' ? (res.writeHead(404), res.end()) : err(res, 404, 'NoSuchKey');
          }
          res.writeHead(200, { etag: cur.etag, 'content-length': String(cur.body.length) });
          res.end(method === 'HEAD' ? undefined : cur.body);
          return;
        case 'PUT': {
          if (req.headers['if-none-match'] === '*') {
            if (!conditional) {
              return err(res, 501, 'NotImplemented', 'A header you provided implies functionality that is not implemented');
            }
            if (cur) {
              return err(res, 412, 'PreconditionFailed');
            }
          }
          if (req.headers['if-match'] && req.headers['if-match'] !== cur?.etag) {
            return err(res, 412, 'PreconditionFailed');
          }
          const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;
          objects.set(key, { body, etag });
          res.writeHead(200, { etag });
          res.end();
          return;
        }
        case 'DELETE':
          objects.delete(key);
          res.writeHead(204);
          res.end();
          return;
        default:
          return err(res, 405, 'MethodNotAllowed');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        keys: () => [...objects.keys()].sort(),
        listCalls: () => lists,
        badSignatures: () => bad,
        setConditional: (on) => (conditional = on),
        denyAll: (on) => (deny = on),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
