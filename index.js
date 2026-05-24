require('dotenv').config();

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const PORT = process.env.PORT || 4042;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const MONGO_URI = process.env.MONGO_URI;
const PUQ_SYNC_HOST = process.env.PUQ_SYNC_HOST || 'api.puq.ai';
const PUQ_SYNC_PATH = process.env.PUQ_SYNC_PATH || '';
const MONGO_DB = 'insightmap';
const MONGO_COLLECTION = 'detections';

// Oturum ayarları
const SESSION_COOKIE = 'insightmap_session';
const SESSION_DAYS   = 30;

// Çoklu kamera yapısı:
// - Slot 0, üstten bakış görüntüsüdür ve ısı haritasının alt katmanı olarak kullanılır.
// - Slot 0, kullanıcıya yalnızca "Isı Haritası" görünümü olarak sunulur.
// - Diginova bu slottan okuma yapar ve detection bu görüntü üzerinden çalışır.
// - Slot 1..4, yan açılı kameralar olarak galeride gösterilir.
// - /api/snapshot alias'ı geri uyumluluk için camId=0'a karşılık gelir.
const VALID_CAM_IDS  = new Set([0, 1, 2, 3, 4]);
const VALID_VIEW_IDS = new Set([0, 1, 2, 3, 4]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

// camId -> { mime, data: Buffer, receivedAt: number }
const snapshots = {};
// Seçili görünüm. 0 ısı haritası, 1..4 ise kamera görünümleridir.
// Unity client bu değeri 2-3 saniyede bir poll ederek kalite ayarını yapar.
let selectedViewId = 0;

let detectionsCollection = null;
let usersCollection = null;
let sessionsCollection = null;

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseSnapshotPayload(buf, contentType) {
  let raw;
  if (contentType && contentType.includes('application/json')) {
    const obj = JSON.parse(buf.toString('utf8'));
    raw = obj.data || obj.base64 || obj.image || obj.payload;
  } else {
    raw = buf.toString('utf8').trim();
  }
  if (!raw || typeof raw !== 'string') throw new Error('missing base64 payload');

  let mime = 'image/png';
  let b64 = raw;
  const m = raw.match(/^data:([^;]+);base64,(.+)$/s);
  if (m) {
    mime = m[1];
    b64 = m[2];
  }
  const data = Buffer.from(b64, 'base64');
  if (!data.length) throw new Error('invalid base64');
  return { mime, data, receivedAt: Date.now() };
}

function normalizeBoundingBoxes(boxes) {
  if (!Array.isArray(boxes)) throw new Error('boundingBoxes must be an array');
  return boxes.map((b, i) => {
    if (!b || typeof b !== 'object') {
      throw new Error(`boundingBoxes[${i}] must be an object`);
    }
    const x = Number(b.x);
    const y = Number(b.y);
    const w = Number(b.width != null ? b.width : b.w);
    const h = Number(b.height != null ? b.height : b.h);
    if (![x, y, w, h].every(Number.isFinite)) {
      throw new Error(`boundingBoxes[${i}] needs numeric x, y, width, height`);
    }
    const box = { x, y, width: w, height: h };
    if (b.confidence != null) {
      const c = Number(b.confidence);
      if (Number.isFinite(c)) box.confidence = c;
    }
    if (b.label != null) box.label = String(b.label);
    if (b.trackId != null) box.trackId = String(b.trackId);
    if (b.classId != null) box.classId = Number(b.classId);
    return box;
  });
}

// "24h", "7d", "30m" veya "1y" gibi pencere değerlerini geçmişe ait bir Date nesnesine çevirir.
function parseWindow(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+)\s*([smhdwy])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const factors = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    y: 31_557_600_000,
  };
  return new Date(Date.now() - n * factors[unit]);
}

// Oturum yardımcıları
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(res, token, maxAgeSec) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'SameSite=Lax',
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function publicUser(user) {
  if (!user) return null;
  return { id: user._id.toString(), name: user.name, email: user.email };
}

async function readJsonBody(req) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) {
    throw new Error('Content-Type must be application/json');
  }
  const buf = await readBody(req, MAX_BODY_BYTES);
  return JSON.parse(buf.toString('utf8'));
}

async function getUserFromRequest(req) {
  if (!sessionsCollection || !usersCollection) return null;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = await sessionsCollection.findOne({ token });
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < new Date()) return null;
  return usersCollection.findOne({ _id: session.userId });
}

async function connectMongo() {
  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
  });
  await client.connect();
  const db = client.db(MONGO_DB);

  detectionsCollection = db.collection(MONGO_COLLECTION);
  await detectionsCollection.createIndex({ receivedAt: -1 });

  usersCollection = db.collection('users');
  await usersCollection.createIndex({ email: 1 }, { unique: true });

  sessionsCollection = db.collection('sessions');
  await sessionsCollection.createIndex({ token: 1 }, { unique: true });
  await sessionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  console.log(`  Mongo bagli -> ${MONGO_DB} (detections, users, sessions)`);
  return client;
}

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Kimlik doğrulama endpoint'leri

  if (req.method === 'POST' && urlPath === '/api/auth/register') {
    if (!usersCollection || !sessionsCollection) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'database not ready' }));
    }
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (!name) throw new Error('Ad zorunlu');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Gecerli bir e-posta gir');
      if (password.length < 6) throw new Error('Sifre en az 6 karakter olmali');

      const existing = await usersCollection.findOne({ email });
      if (existing) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'Bu e-posta zaten kayitli' }));
      }

      const now = new Date();
      const insert = await usersCollection.insertOne({
        name,
        email,
        passwordHash: hashPassword(password),
        createdAt: now,
      });

      const token = newSessionToken();
      const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86400_000);
      await sessionsCollection.insertOne({ token, userId: insert.insertedId, createdAt: now, expiresAt });
      setSessionCookie(res, token, SESSION_DAYS * 86400);

      const user = { _id: insert.insertedId, name, email };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, user: publicUser(user) }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  if (req.method === 'POST' && urlPath === '/api/auth/login') {
    if (!usersCollection || !sessionsCollection) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'database not ready' }));
    }
    try {
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      const user = await usersCollection.findOne({ email });
      if (!user || !verifyPassword(password, user.passwordHash)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'E-posta veya sifre hatali' }));
      }

      const now = new Date();
      const token = newSessionToken();
      const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86400_000);
      await sessionsCollection.insertOne({ token, userId: user._id, createdAt: now, expiresAt });
      setSessionCookie(res, token, SESSION_DAYS * 86400);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, user: publicUser(user) }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  if (req.method === 'POST' && urlPath === '/api/auth/logout') {
    try {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token && sessionsCollection) {
        await sessionsCollection.deleteOne({ token });
      }
      clearSessionCookie(res);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  if (req.method === 'GET' && urlPath === '/api/auth/me') {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, user: publicUser(user) }));
  }

  // Snapshot ve detection endpoint'leri
  // - /api/snapshot[/info], camId=0 alias'ıdır.
  // - /api/snapshot/<n>[/info] yapısı 0..4 arası kamera slotlarını hedefler.

  let snapCamId = null;
  let snapIsInfo = false;
  if (urlPath === '/api/snapshot') {
    snapCamId = 0;
  } else if (urlPath === '/api/snapshot/info') {
    snapCamId = 0;
    snapIsInfo = true;
  } else {
    const m = urlPath.match(/^\/api\/snapshot\/(\d+)(?:\/(info))?$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (VALID_CAM_IDS.has(n)) {
        snapCamId = n;
        snapIsInfo = m[2] === 'info';
      }
    }
  }

  if (snapCamId !== null) {
    const camId = snapCamId;
    const isInfo = snapIsInfo;

    if (req.method === 'POST' && !isInfo) {
      try {
        const body = await readBody(req, MAX_BODY_BYTES);
        snapshots[camId] = parseSnapshotPayload(body, req.headers['content-type'] || '');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          ok: true,
          camId,
          mime: snapshots[camId].mime,
          sizeBytes: snapshots[camId].data.length,
          receivedAt: snapshots[camId].receivedAt,
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    if (req.method === 'GET' && !isInfo) {
      const snap = snapshots[camId];
      if (!snap) { res.writeHead(204); return res.end(); }
      res.writeHead(200, {
        'Content-Type': snap.mime,
        'Cache-Control': 'no-store',
        'Content-Length': snap.data.length,
      });
      return res.end(snap.data);
    }

    if (req.method === 'GET' && isInfo) {
      const snap = snapshots[camId];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        camId,
        hasSnapshot: !!snap,
        mime: snap ? snap.mime : null,
        sizeBytes: snap ? snap.data.length : 0,
        receivedAt: snap ? snap.receivedAt : null,
      }));
    }
  }

  // Görünüm seçimi:
  // - Unity client, GET /api/view ile seçili viewId değerini poll eder.
  // - UI, POST /api/view { viewId } ile seçimi günceller.

  if (req.method === 'GET' && urlPath === '/api/view') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, viewId: selectedViewId }));
  }

  if (req.method === 'POST' && urlPath === '/api/view') {
    try {
      const body = await readJsonBody(req);
      const viewId = parseInt(body.viewId, 10);
      if (!VALID_VIEW_IDS.has(viewId)) throw new Error('invalid viewId');
      selectedViewId = viewId;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, viewId }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // Galeri için tüm görünümlerin durumunu tek istekte döndürür.
  if (req.method === 'GET' && urlPath === '/api/views') {
    const views = [];
    for (const camId of [0, 1, 2, 3, 4]) {
      const snap = snapshots[camId];
      views.push({
        viewId: camId,
        type: camId === 0 ? 'heatmap' : 'camera',
        hasSnapshot: !!snap,
        receivedAt: snap ? snap.receivedAt : null,
        sizeBytes: snap ? snap.data.length : 0,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, selectedViewId, views }));
  }

  if (req.method === 'GET' && urlPath === '/api/detections/recent') {
    if (!detectionsCollection) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'database not ready' }));
    }
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const windowStr = url.searchParams.get('window') || '24h';
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 1000, 10000);

      const query = {};
      const since = parseWindow(windowStr);
      if (since) query.receivedAt = { $gte: since };

      const docs = await detectionsCollection
        .find(query, { projection: { boundingBoxes: 1, imageSize: 1, timestamp: 1, receivedAt: 1, personCount: 1 } })
        .sort({ receivedAt: -1 })
        .limit(limit)
        .toArray();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        ok: true,
        count: docs.length,
        window: windowStr,
        since: since ? since.getTime() : null,
        detections: docs,
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // Bugüne ait detection verisini Puq.ai webhook'una sunucu tarafında iletir.
  // Tarayıcıdan doğrudan çağrı CORS'a takılacağı için proxy olarak backend kullanılır.
  if (req.method === 'POST' && urlPath === '/api/puq/sync') {
    if (!detectionsCollection) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'database not ready' }));
    }
    if (!PUQ_SYNC_PATH) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'puq sync not configured' }));
    }
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const docs = await detectionsCollection
        .find({ receivedAt: { $gte: startOfDay } }, {
          projection: { boundingBoxes: 1, imageSize: 1, timestamp: 1, receivedAt: 1, personCount: 1 },
        })
        .sort({ receivedAt: 1 })
        .toArray();

      const totalPersonDetections = docs.reduce((sum, d) => sum + (d.personCount || 0), 0);

      const payload = {
        store: 'kadikoy-merkez',
        source: 'insightmap',
        generatedAt: new Date().toISOString(),
        windowStart: startOfDay.toISOString(),
        windowEnd: new Date().toISOString(),
        frameCount: docs.length,
        totalPersonDetections,
        detections: docs.map(d => ({
          id: d._id ? d._id.toString() : undefined,
          timestamp: d.timestamp,
          receivedAt: d.receivedAt,
          personCount: d.personCount,
          imageSize: d.imageSize,
          boundingBoxes: d.boundingBoxes,
        })),
      };

      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      // Puq.ai workflow'u, LLM çıkarımı dahil, genellikle 30-90 saniye sürer.
      // Timeout değeri yüksek tutulur; böylece header geldikten sonra body beklenirken istek düşmez.
      const PUQ_TIMEOUT_MS = 120000;
      const puqResult = await new Promise((resolve, reject) => {
        let settled = false;
        let headersReceived = false;
        const done = (val) => { if (!settled) { settled = true; resolve(val); } };
        const fail = (err) => { if (!settled) { settled = true; reject(err); } };

        const r = https.request({
          method: 'POST',
          hostname: PUQ_SYNC_HOST,
          path: PUQ_SYNC_PATH,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': body.length,
            'User-Agent': 'InsightMap/1.0',
            'Connection': 'close',
            'Accept': 'application/json, text/plain;q=0.9, */*;q=0.5',
          },
          timeout: PUQ_TIMEOUT_MS,
        }, (resp) => {
          headersReceived = true;
          resp.setTimeout(PUQ_TIMEOUT_MS);
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => done({
            status: resp.statusCode,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 4000),
          }));
          resp.on('error', fail);
          resp.on('timeout', () => {
            // Header geldikten sonra body akışı durursa eldeki parçalı veriyi döndür.
            resp.destroy();
            done({
              status: resp.statusCode,
              body: Buffer.concat(chunks).toString('utf8').slice(0, 4000),
              partial: true,
            });
          });
        });
        r.on('error', fail);
        r.on('timeout', () => {
          r.destroy(new Error(headersReceived
            ? 'puq.ai response body timeout'
            : 'puq.ai connect/headers timeout'));
        });
        r.write(body);
        r.end();
      });

      const ok = puqResult.status >= 200 && puqResult.status < 300;
      res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok,
        forwardedStatus: puqResult.status,
        forwardedBody: puqResult.body,
        partial: puqResult.partial === true,
        frameCount: docs.length,
        totalPersonDetections,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  if (req.method === 'POST' && urlPath === '/api/snapshot/save') {
    if (!detectionsCollection) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'database not ready' }));
    }
    try {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('application/json')) {
        throw new Error('Content-Type must be application/json');
      }
      const body = await readBody(req, MAX_BODY_BYTES);
      const payload = JSON.parse(body.toString('utf8'));
      const rawBoxes = payload.boundingBoxes != null ? payload.boundingBoxes : payload.boxes;
      if (rawBoxes == null) throw new Error('boundingBoxes is required');
      const boxes = normalizeBoundingBoxes(rawBoxes);

      const now = new Date();
      const doc = {
        timestamp: payload.timestamp ? new Date(payload.timestamp) : now,
        imageSize: payload.imageSize && typeof payload.imageSize === 'object'
          ? {
              width: Number(payload.imageSize.width) || null,
              height: Number(payload.imageSize.height) || null,
            }
          : null,
        boundingBoxes: boxes,
        personCount: boxes.length,
        meta: payload.meta && typeof payload.meta === 'object' ? payload.meta : null,
        receivedAt: now,
      };

      const result = await detectionsCollection.insertOne(doc);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: true,
        id: result.insertedId.toString(),
        personCount: doc.personCount,
        savedAt: doc.receivedAt.getTime(),
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? '/index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 - Sayfa bulunamadi');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=0',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

connectMongo().catch((err) => {
  console.error('  Mongo baglantisi kurulamadi:', err.message);
  console.error('  Sunucu yine de baslayacak; /api/snapshot/save 503 donecek.');
});

server.listen(PORT, () => {
  if (!PUQ_SYNC_PATH) {
    console.warn('  Uyari: PUQ_SYNC_PATH tanimli degil; /api/puq/sync devre disi.');
  }
  console.log(`\n  InsightMap calisiyor -> http://localhost:${PORT}`);
});
