// A stand-in for the few Drive endpoints the app uses, for local tests only.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const files = new Map(); // id -> { meta, body, type }
const sessions = new Map();
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'Location',
};
const read = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const json = (res, code, obj) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const authed = Boolean(req.headers.authorization);
  let m;
  if (p === '/drive/v3/files' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const name = /name='([^']*)'/.exec(q)?.[1];
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    const hits = [...files.entries()].filter(([, f]) => f.meta.mimeType?.includes('folder') && f.meta.name === name
      && (!parent || f.meta.parents?.includes(parent))).map(([id]) => ({ id }));
    return json(res, 200, { files: hits });
  }
  if (p === '/drive/v3/files' && req.method === 'POST') {
    if (!authed) return json(res, 401, {});
    const id = randomUUID(); files.set(id, { meta: JSON.parse(await read(req)), body: null });
    return json(res, 200, { id });
  }
  if (p === '/upload/drive/v3/files' && req.method === 'POST') {
    if (!authed) return json(res, 401, {});
    const s = randomUUID(); sessions.set(s, JSON.parse(await read(req)));
    res.writeHead(200, { ...cors, Location: `http://${req.headers.host}/upload/session/${s}` }); return res.end();
  }
  if ((m = /^\/upload\/session\/(.+)$/.exec(p)) && req.method === 'PUT') {
    const meta = sessions.get(m[1]); const id = randomUUID();
    files.set(id, { meta, body: await read(req), type: req.headers['content-type'], shared: false });
    return json(res, 200, { id });
  }
  if ((m = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(p))) {
    const f = files.get(m[1]); if (!f) return json(res, 404, {});
    f.shared = true; return json(res, 200, { id: 'anyone' });
  }
  if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
    const f = files.get(m[1]); if (!f) return json(res, 404, {});
    if (req.method === 'DELETE') { files.delete(m[1]); res.writeHead(204, cors); return res.end(); }
    if (!f.shared && !authed) return json(res, 403, {});
    if (!url.searchParams.get('key') && !authed) return json(res, 403, {});
    res.writeHead(200, { ...cors, 'Content-Type': f.type || 'application/octet-stream' }); return res.end(f.body);
  }
  json(res, 404, { p });
}).listen(9300, () => console.log('fake drive on :9300'));
