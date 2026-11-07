// A fake WebDAV server for sync tests (127.0.0.1 only): an in-memory tree with PROPFIND (Depth 0/1, multistatus),
// GET / HEAD / PUT (409 when the parent folder is missing), MKCOL (405 when it exists), MOVE with `Overwrite: F|T`,
// DELETE, and Basic auth (401 otherwise). Counts calls per method. Pure Node.
import * as http from 'http';
import type { AddressInfo } from 'net';

export interface FakeWebDav {
  url: string;
  calls(method: string): number;
  /** Every file path. */
  paths(): string[];
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function startFakeWebDav(o: { username: string; password: string }): Promise<FakeWebDav> {
  const files = new Map<string, { body: Buffer; etag: string; mtime: number }>();
  const dirs = new Set<string>(['/', '/remote.php/', '/remote.php/dav/', '/remote.php/dav/files/', '/remote.php/dav/files/me/']);
  const counts = new Map<string, number>();
  let n = 0;
  const want = `Basic ${Buffer.from(`${o.username}:${o.password}`).toString('base64')}`;
  const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, '/') || '/';
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const method = req.method ?? 'GET';
      counts.set(method, (counts.get(method) ?? 0) + 1);
      if (req.headers.authorization !== want) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="fake"' });
        res.end();
        return;
      }
      const body = Buffer.concat(chunks);
      const p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      const dirPath = p.endsWith('/') ? p : `${p}/`;
      switch (method) {
        case 'PROPFIND': {
          const depth = String(req.headers.depth ?? '1');
          const entry = (href: string, dir: boolean, f?: { body: Buffer; etag: string; mtime: number }) =>
            `<d:response><d:href>${esc(encodeURI(href))}</d:href><d:propstat><d:prop>${dir ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${f!.body.length}</d:getcontentlength><d:getetag>${f!.etag}</d:getetag><d:getlastmodified>${new Date(f!.mtime).toUTCString()}</d:getlastmodified>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
          let out = '';
          if (dirs.has(dirPath)) {
            out += entry(dirPath, true);
            if (depth !== '0') {
              for (const d of dirs) {
                if (d !== dirPath && d.startsWith(dirPath) && !d.slice(dirPath.length, -1).includes('/')) {
                  out += entry(d, true);
                }
              }
              for (const [f, v] of files) {
                if (f.startsWith(dirPath) && !f.slice(dirPath.length).includes('/')) {
                  out += entry(f, false, v);
                }
              }
            }
          } else if (files.has(p)) {
            out += entry(p, false, files.get(p));
          } else {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
          res.end(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${out}</d:multistatus>`);
          return;
        }
        case 'MKCOL':
          if (dirs.has(dirPath) || files.has(p)) {
            res.writeHead(405);
          } else if (!dirs.has(parentOf(dirPath))) {
            res.writeHead(409);
          } else {
            dirs.add(dirPath);
            res.writeHead(201);
          }
          res.end();
          return;
        case 'GET':
        case 'HEAD': {
          const f = files.get(p);
          if (!f) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { etag: f.etag, 'content-length': String(f.body.length) });
          res.end(method === 'HEAD' ? undefined : f.body);
          return;
        }
        case 'PUT':
          if (!dirs.has(parentOf(p))) {
            res.writeHead(409);
            res.end();
            return;
          }
          files.set(p, { body, etag: `"${++n}"`, mtime: Date.now() });
          res.writeHead(201);
          res.end();
          return;
        case 'MOVE': {
          const f = files.get(p);
          const dest = decodeURIComponent(new URL(String(req.headers.destination ?? ''), 'http://x').pathname);
          if (!f) {
            res.writeHead(404);
            res.end();
            return;
          }
          if (files.has(dest) && String(req.headers.overwrite ?? 'T').toUpperCase() === 'F') {
            res.writeHead(412);
            res.end();
            return;
          }
          const existed = files.has(dest);
          files.delete(p);
          files.set(dest, { ...f, etag: `"${++n}"` });
          res.writeHead(existed ? 204 : 201, { etag: files.get(dest)!.etag });
          res.end();
          return;
        }
        case 'DELETE':
          if (files.delete(p) || dirs.delete(dirPath)) {
            res.writeHead(204);
          } else {
            res.writeHead(404);
          }
          res.end();
          return;
        default:
          res.writeHead(405);
          res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls: (m) => counts.get(m) ?? 0,
        paths: () => [...files.keys()].sort(),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
