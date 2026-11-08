'use strict';

// Moon Knowledge Engine v0.6.0
// Standalone Yandex Cloud Function. Node.js 22+, zero npm dependencies.
// Stores MediaWiki pages and a compact search index in the existing Yandex Object Storage bucket.
//
// v0.6.0 — быстрый локальный режим поиска:
//   (1) search с fast:true не ходит в вики, не переводит запрос в сеть,
//       не читает лишние страницы и не перезаписывает индекс;
//   (2) результат быстрого поиска кэшируется в памяти тёплого экземпляра.
//       Это нужно, чтобы ответ укладывался в реплику Алисы (~4,5 с).
//   (3) обычный режим (без fast) работает как раньше, без изменений.

const crypto = require('crypto');

const KB_VERSION = '0.6.0';

// Быстрый режим: только локальный индекс, без сети и без записи в S3.
const FAST_CANDIDATE_LIMIT = 10;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 240;
const SEARCH_CACHE = new Map();
const TOKEN = process.env.KB_TOKEN || '';
const BUCKET = process.env.KB_BUCKET || process.env.BUCKET || 'moon-assistant';
const S3_ID = process.env.ACCESS_KEY_ID || '';
const S3_SECRET = process.env.SECRET_ACCESS_KEY || '';
const REGION = process.env.S3_REGION || 'ru-central1';
const PREFIX = (process.env.KB_PREFIX || 'kb').replace(/^\/+|\/+$/g, '');
const FETCH_TIMEOUT_MS = Number(process.env.KB_FETCH_TIMEOUT_MS || 12000);
const MAX_BATCH = Math.min(50, Math.max(1, Number(process.env.KB_BATCH_SIZE || 20)));
const MAX_PAGES = Math.min(50000, Math.max(100, Number(process.env.KB_MAX_PAGES || 12000)));
const MAX_QUERY = 240;
const ON_DEMAND_SEARCH_LIMIT = 5;
const MAX_QUERY_VARIANTS = 4;
const MAX_PAGE_TEXT = Math.min(50000, Math.max(5000, Number(process.env.KB_MAX_PAGE_TEXT || 30000)));
const MAX_ENRICH_PAGES = Math.min(8, Math.max(1, Number(process.env.KB_MAX_ENRICH_PAGES || 5)));
const MAX_PARSE_FALLBACK_PAGES = 2;

const UA = 'MoonKnowledgeEngine/0.5.3 (universal multilingual game knowledge; contact: configure KB_CONTACT)';
const TRANSLATION_TIMEOUT_MS = Math.min(9000, Math.max(2000, Number(process.env.KB_TRANSLATION_TIMEOUT_MS || 5500)));
const DISCOVERY_TIMEOUT_MS = Number(process.env.KB_DISCOVERY_TIMEOUT_MS || 9000);
const DISCOVERY_MAX_CANDIDATES = 6;
const CATALOG = [];

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));

  return x.length === y.length &&
    x.length > 0 &&
    crypto.timingSafeEqual(x, y);
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
const SEARCH_STOP_WORDS = new Set((
  'а без более бы был была были было быть в вам вас весь во вот все всего всех вы где да даже для до его ее если есть еще же за здесь и из или им их к как ко когда кто ли либо мне может мы на над надо наш не него нее нет ни них но ну о об один она они оно от потому по под при про с со так также такой там те тем то того тоже той только том ты у уже чем что чтобы эта эти это я этот эту ' +
  'a an and are as at be been being but by can could did do does doing for from had has have he her hers him his how i if in into is it its may me might mine my no nor not of off on once only or other our ours she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which who whom why will with would you your yours'
).split(/\s+/));

function stemSearchToken(raw) {
  let token=normalize(raw);
  if(token.length<5)return token;

  if(/[а-я]/i.test(token)){
    const suffixes=['иями','ями','ами','иях','ией','ию','ии','ия','ого','ему','ому','ыми','ими','его','ую','юю','ая','яя','ое','ее','ые','ие','ым','им','ом','ем','ов','ев','ей','ья','ах','ях','ам','ям','ы','и','а','я','у','ю','е','о'];
    for(const suffix of suffixes){
      if(token.endsWith(suffix)&&token.length-suffix.length>=3){
        token=token.slice(0,-suffix.length);
        break;
      }
    }
  }else{
    const suffixes=['ingly','edly','ments','ment','ation','ations','ing','ers','ies','ied','ed','es','s'];
    for(const suffix of suffixes){
      if(token.endsWith(suffix)&&token.length-suffix.length>=3){
        token=token.slice(0,-suffix.length);
        if(suffix==='ies'||suffix==='ied')token+='y';
        break;
      }
    }
  }

  return token;
}

function searchTokens(value){
  const raw=normalize(value).split(' ').filter(Boolean);
  const out=[];
  const seen=new Set();

  for(const token of raw){
    if(token.length<2||SEARCH_STOP_WORDS.has(token))continue;

    for(const candidate of [token,stemSearchToken(token)]){
      if(candidate.length<2||seen.has(candidate))continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }

  return out;
}

function isRealNameIntent(query){
  const q=normalize(query);

  return /(?:\breal name\b|\bbirth name\b|\bfull name\b|\bgiven name\b|\blegal name\b|\bborn as\b|настоящ[\p{L}]*\s+им[\p{L}]*|полны[\p{L}]*\s+им[\p{L}]*|им[\p{L}]*\s+при\s+рожд[\p{L}]*|как\s+зовут|как\s+звали|реальн[\p{L}]*\s+им[\p{L}]*)/u.test(q);
}

function isEpitaphIntent(query) {
  const q = normalize(query);
  return /\b(epitaph|inscription|tombstone|gravestone)\b|эпитаф|надпис/u.test(q);
}

function queryHintTerms(query) {
  const hints = [];

  if (isRealNameIntent(query)) {
    hints.push(
      'real name', 'birth name', 'full name', 'given name', 'legal name',
      'born as', 'настоящее имя', 'полное имя'
    );
  }

  if (isEpitaphIntent(query)) {
    hints.push(
      'epitaph', 'inscription', 'tombstone', 'gravestone',
      'memorial plaque', 'эпитафия', 'эпитафии', 'надпись'
    );
  }

  return hints;
}

function slug(s) {
  return normalize(s).replace(/ /g, '-').slice(0, 80) || 'unknown-game';
}

function enc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function s3Key(key) {
  return PREFIX + '/' + key.split('/').map(enc).join('/');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

async function s3(method, key, body, contentType) {
  if (!S3_ID || !S3_SECRET || !BUCKET) {
    throw new Error('Object Storage credentials are not configured');
  }

  const host = 'storage.yandexcloud.net';
  const payload = body || Buffer.alloc(0);
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const uri = '/' + enc(BUCKET) + '/' + s3Key(key);
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders =
    'host:' + host +
    '\nx-amz-content-sha256:' + payloadHash +
    '\nx-amz-date:' + amzDate + '\n';

  const canonicalRequest = [
    method,
    uri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const scope = dateStamp + '/' + REGION + '/s3/aws4_request';

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');

  const kDate = hmac('AWS4' + S3_SECRET, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');

  const headers = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'Authorization':
      'AWS4-HMAC-SHA256 Credential=' + S3_ID + '/' + scope +
      ', SignedHeaders=' + signedHeaders +
      ', Signature=' + hmac(kSigning, stringToSign, 'hex')
  };

  if (method === 'PUT') {
    headers['Content-Type'] = contentType || 'application/octet-stream';
  }

  const res = await fetch('https://' + host + uri, {
    method,
    headers,
    body: method === 'PUT' ? payload : undefined,
    signal: AbortSignal.timeout(8000)
  });

  return {
    status: res.status,
    etag: res.headers.get('etag') || '',
    body: Buffer.from(await res.arrayBuffer())
  };
}

async function readJson(key) {
  const r = await s3('GET', key);

  if (r.status === 404) return null;

  if (r.status !== 200) {
    throw new Error('Object Storage GET ' + r.status + ' for ' + key);
  }

  return JSON.parse(r.body.toString('utf8'));
}

async function writeJson(key, value) {
  const r = await s3(
    'PUT',
    key,
    Buffer.from(JSON.stringify(value), 'utf8'),
    'application/json; charset=utf-8'
  );

  if (r.status < 200 || r.status >= 300) {
    throw new Error('Object Storage PUT ' + r.status + ' for ' + key);
  }
}

function gameRoot(id) {
  return 'games/' + id;
}

function manifestKey(id) {
  return gameRoot(id) + '/manifest.json';
}

function indexKey(id) {
  return gameRoot(id) + '/index.json';
}

function aliasesKey(id) {
  return gameRoot(id) + '/aliases.json';
}

function pageKey(id, pageId) {
  return gameRoot(id) + '/pages/' + String(pageId) + '.json';
}

function allowedWikiHost(host) {
  const h = String(host || '').toLowerCase();

  const extra = String(process.env.KB_ALLOWED_WIKI_HOSTS || '')
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);

  const allow = [
    'fandom.com',
    'wiki.gg',
    'minecraft.wiki',
    'stardewvalleywiki.com',
    'mediawiki.org',
    'fextralife.com',
    'strategywiki.org',
    'bulbagarden.net'
  ];

  return extra.some(x => h === x || h.endsWith('.' + x)) ||
    allow.some(x => h === x || h.endsWith('.' + x));
}

function validateApiUrl(raw) {
  const u = new URL(raw);

  if (u.protocol !== 'https:' || !allowedWikiHost(u.hostname)) {
    throw new Error('Wiki API host is not on the HTTPS allowlist');
  }

  if (u.username || u.password || u.port) {
    throw new Error('Wiki API URL must not contain credentials or a custom port');
  }

  return u;
}

async function wikiGet(apiUrl, params, timeoutMs = FETCH_TIMEOUT_MS) {
  const u = validateApiUrl(apiUrl);

  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, String(v));
  }

  const res = await fetch(u.toString(), {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error'
  });

  if (!res.ok) {
    throw new Error('Wiki API HTTP ' + res.status);
  }

  const data = await res.json();

  if (data && data.error) {
    throw new Error(
      'Wiki API: ' +
      String(data.error.info || data.error.code || 'unknown error').slice(0, 180)
    );
  }

  return data;
}

async function verifyWiki(apiUrl) {
  const data = await wikiGet(apiUrl, {
    action: 'query',
    meta: 'siteinfo',
    siprop: 'general',
    format: 'json',
    formatversion: 2
  });

  const general = data && data.query && data.query.general;

  if (!general || !general.server || !general.sitename) {
    throw new Error('This endpoint did not identify itself as a MediaWiki API');
  }

  return {
    siteName: String(general.sitename).slice(0, 160),
    server: String(general.server).slice(0, 300),
    generator: String(general.generator || '').slice(0, 100),
    language: String(general.lang || '').slice(0, 20)
  };
}

function extraCatalog() {
  try {
    const value = JSON.parse(process.env.KB_WIKI_CATALOG_JSON || '[]');

    return Array.isArray(value)
      ? value.filter(x => x && x.api && (x.game || x.id || x.names))
      : [];
  } catch {
    return [];
  }
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function unwrapSearchUrl(raw) {
  try {
    let u = new URL(decodeHtml(raw), 'https://html.duckduckgo.com');

    if (u.hostname.endsWith('duckduckgo.com') && u.pathname.includes('/l/')) {
      const target = u.searchParams.get('uddg');
      if (target) u = new URL(target);
    }

    return u;
  } catch {
    return null;
  }
}

async function discoverWikiCandidates(game) {
  const query = encodeURIComponent(
    '"' + game + '" game wiki MediaWiki API Fandom wiki.gg'
  );

  const response = await fetch(
    'https://html.duckduckgo.com/html/?q=' + query,
    {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html'
      },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      redirect: 'follow'
    }
  );

  if (!response.ok) {
    throw new Error('Wiki discovery search HTTP ' + response.status);
  }

  const html = await response.text();
  const hrefs = [];

  const re = /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["']/gi;
  let match;

  while ((match = re.exec(html)) && hrefs.length < 30) {
    hrefs.push(match[1]);
  }

  if (!hrefs.length) {
    const fallback = /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*result__a[^"']*["']/gi;

    while ((match = fallback.exec(html)) && hrefs.length < 30) {
      hrefs.push(match[1]);
    }
  }

  const hosts = [];

  for (const href of hrefs) {
    const u = unwrapSearchUrl(href);

    if (!u || u.protocol !== 'https:' ||
        !allowedWikiHost(u.hostname)) {
      continue;
    }

    if (!hosts.includes(u.hostname.toLowerCase())) {
      hosts.push(u.hostname.toLowerCase());
    }
  }

  const candidates = [];

  for (const host of hosts.slice(0, DISCOVERY_MAX_CANDIDATES)) {
    const paths = [
      '/api.php',
      '/w/api.php',
      '/mediawiki/api.php'
    ];

    for (const path of paths) {
      const api = 'https://' + host + path;

      try {
        const info = await verifyWiki(api);

        const search = await wikiGet(api, {
          action: 'query',
          list: 'search',
          srsearch: game,
          srlimit: 8,
          srprop: 'size|wordcount',
          format: 'json',
          formatversion: 2
        });

        const hits = (
          search && search.query && search.query.search || []
        ).map(x => String(x.title || '')).slice(0, 8);

        const tokens = normalize(game).split(' ').filter(x => x.length > 1);
        const siteText = normalize(host + ' ' + info.siteName);
        const siteMatches = tokens.filter(t => siteText.includes(t)).length;

        const titleMatches = hits.filter(title =>
          tokens.filter(t => normalize(title).includes(t)).length >=
          Math.max(1, Math.min(2, tokens.length))
        ).length;

        const score = siteMatches * 3 + titleMatches * 2;

        if (score >= 2) {
          candidates.push({
            api,
            ...info,
            discovery: 'web-search',
            score,
            matchingPages: hits.slice(0, 5)
          });
        }

        break;
      } catch (e) {
        // Пробуем следующий общепринятый путь MediaWiki API.
      }
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function discoverWiki(game) {
  const name = String(game || '').trim().slice(0, 100);

  if (name.length < 2) {
    throw new Error('game is required');
  }

  const n = normalize(name);

  const allCatalog = CATALOG.concat(
    extraCatalog().map(x => ({
      id: x.id || slug(x.game || (x.names || [])[0]),
      names: Array.isArray(x.names)
        ? x.names
        : [x.game || x.id],
      api: x.api,
      language: x.language || 'unknown'
    }))
  );

  const known = allCatalog.find(x =>
    x.names.some(alias => normalize(alias) === n)
  );

  if (known) {
    try {
      const info = await verifyWiki(known.api);

      return {
        status: 'found',
        game: name,
        source: {
          api: known.api,
          ...info,
          discovery: 'catalog',
          catalogId: known.id,
          language: known.language
        }
      };
    } catch (e) {
      // Устаревший элемент каталога: продолжаем автоматический поиск.
    }
  }

  const cache = await readJson('wiki-catalog.json')
    .catch(() => null) || { games: {} };

  const cached = cache.games && cache.games[n];

  if (cached && cached.api) {
    try {
      const info = await verifyWiki(cached.api);

      return {
        status: 'found',
        game: name,
        source: {
          ...cached,
          ...info,
          discovery: 'saved-catalog'
        }
      };
    } catch (e) {
      // Проверяем источник заново.
    }
  }

  let candidates;

  try {
    candidates = await discoverWikiCandidates(name);
  } catch (e) {
    return {
      status: 'discovery_unavailable',
      game: name,
      message: String(e.message || e).slice(0, 180),
      candidates: []
    };
  }

  if (!candidates.length) {
    return {
      status: 'not_found',
      game: name,
      candidates: [],
      message: 'Не удалось автоматически подтвердить подходящую MediaWiki. Можно передать wikiApi вручную.'
    };
  }

  if (candidates.length > 1 &&
      candidates[0].score === candidates[1].score) {
    return {
      status: 'needs_choice',
      game: name,
      candidates: candidates.map(({
        api,
        siteName,
        server,
        score,
        matchingPages
      }) => ({
        api,
        siteName,
        server,
        score,
        matchingPages
      }))
    };
  }

  const best = candidates[0];

  cache.games = cache.games || {};
  cache.games[n] = {
    api: best.api,
    siteName: best.siteName,
    server: best.server,
    savedAt: new Date().toISOString()
  };

  cache.updatedAt = new Date().toISOString();

  await writeJson('wiki-catalog.json', cache);

  return {
    status: 'found',
    game: name,
    source: best,
    alternatives: candidates.slice(1).map(x => ({
      api: x.api,
      siteName: x.siteName,
      score: x.score
    }))
  };
}

async function resolveWiki(game, explicitApi) {
  if (explicitApi) {
    const info = await verifyWiki(explicitApi);

    return {
      api: validateApiUrl(explicitApi).toString(),
      ...info,
      discovery: 'manual'
    };
  }

  const result = await discoverWiki(game);

  if (result.status === 'found') {
    return result.source;
  }

  if (result.status === 'needs_choice') {
    throw new Error(
      'Найдено несколько подходящих Wiki. Сначала вызови discover и выбери источник: ' +
      result.candidates.map(x => x.api).join('; ')
    );
  }

  throw new Error(
    result.message ||
    'Не удалось автоматически найти и проверить Wiki. База не создавалась.'
  );
}

function emptyManifest(game, id, wiki) {
  return {
    schemaVersion: 1,
    gameId: id,
    game,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'registered',
    source: wiki,
    pageCount: 0,
    cursor: null,
    complete: false,
    lastSyncAt: null,
    errors: [],
    policy: 'MediaWiki API; page text and revision metadata retained with source URL; no model-generated facts are treated as source data.'
  };
}

async function updateRegistry(gameId) {
  const registry = await readJson('registry.json') || {
    schemaVersion: 1,
    gameIds: []
  };

  if (!registry.gameIds.includes(gameId)) {
    registry.gameIds.push(gameId);
  }

  registry.updatedAt = new Date().toISOString();

  await writeJson('registry.json', registry);
}

async function syncNextGame() {
  const registry = await readJson('registry.json') || {
    gameIds: []
  };

  for (const id of registry.gameIds || []) {
    const m = await readJson(manifestKey(id));

    if (m && !m.complete) {
      return syncGame({
        gameId: id,
        limit: MAX_BATCH
      });
    }
  }

  return {
    status: 'idle',
    message: 'No pending game databases.'
  };
}

async function registerGame(body) {
  const game = String(body.game || '').trim().slice(0, 100);

  if (game.length < 2) {
    throw new Error('game is required');
  }

  const id = slug(body.gameId || game);
  const old = await readJson(manifestKey(id));

  if (old) {
    return {
      status: 'exists',
      gameId: id,
      game: old.game,
      pageCount: old.pageCount,
      complete: old.complete,
      source: old.source
    };
  }

  const wiki = await resolveWiki(game, body.wikiApi || '');
  const manifest = emptyManifest(game, id, wiki);

  await writeJson(manifestKey(id), manifest);
  await writeJson(indexKey(id), {
    schemaVersion: 1,
    items: []
  });

  await updateRegistry(id);

  return {
    status: 'registered',
    gameId: id,
    game,
    source: wiki,
    next: 'sync'
  };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (m, n) => {
      const v = Number(n);
      return v > 0 && v <= 0x10ffff
        ? String.fromCodePoint(v)
        : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => {
      const v = parseInt(n, 16);
      return v > 0 && v <= 0x10ffff
        ? String.fromCodePoint(v)
        : ' ';
    });
}

function removeBalancedTemplates(input, depth = 0) {
  const s = String(input || '');

  if (depth > 8) return ' ';

  let out = '';

  for (let i = 0; i < s.length;) {
    if (s.slice(i, i + 2) === '{{') {
      let level = 1;
      let j = i + 2;

      while (j < s.length && level > 0) {
        if (s.slice(j, j + 2) === '{{') {
          level++;
          j += 2;
        } else if (s.slice(j, j + 2) === '}}') {
          level--;
          j += 2;
        } else {
          j++;
        }
      }

      const body = s.slice(i + 2, Math.max(i + 2, j - 2));
      const lines = body.split(/\r?\n/);
      let key = '';
      let valueLines = [];
      const values = [];

      const excluded = /^(?:image\w*|file|icon|color|colour|background|bg|map|coordinates|coord|width|height|size|align|sort|id|class|style|border|css|logo|sound|audio|video|portrait|screenshot|tracking|nocat)$/i;

      const cleanValue = raw => {
        let value = String(raw || '')
          .replace(/<ref\b[^>]*\/?\s*>[\s\S]*?(?:<\/ref\s*>|$)/gi, ' ');

        value = removeBalancedTemplates(value, depth + 1)
          .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
          .replace(/\[\[([^\]]+)\]\]/g, '$1')
          .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1');

        return stripHtml(value)
          .replace(/[{}|]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      };

      const flush = () => {
        if (!key || excluded.test(key.trim())) {
          key = '';
          valueLines = [];
          return;
        }

        const value = cleanValue(valueLines.join(' '));

        if (value.length >= 2 &&
            value.length <= 220 &&
            /[\p{L}\p{N}]/u.test(value) &&
            !values.some(x => normalize(x) === normalize(value))) {
          values.push(value);
        }

        key = '';
        valueLines = [];
      };

      for (const line of lines) {
        const m = line.match(/^\s*\|\s*([^=|]{1,80}?)\s*=\s*(.*)$/);

        if (m) {
          flush();
          key = m[1].trim();
          valueLines = [m[2]];
        } else if (key) {
          valueLines.push(line);
        }
      }

      flush();

      out += values.slice(0, 24).join('. ') || ' ';
      i = j;
    } else {
      out += s[i];
      i++;
    }
  }

  return out;
}

function stripWikitext(input) {
  let s = String(input || '');

  s = s
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<ref\b[^>]*\/?\s*>[\s\S]*?<\/ref\s*>/gi, ' ')
    .replace(/<ref\b[^>]*\/>/gi, ' ')
    .replace(/<(nowiki|pre|source|syntaxhighlight)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, '$2')
    .replace(/<(gallery|timeline)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/\[\[(?:File|Image|Category|Категория|Файл|Изображение):[^\]]*\]\]/gi, ' ');

  s = removeBalancedTemplates(s);

  s = s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[(?:https?:\/\/\S+)(?:\s+([^\]]+))?\]/g, '$1')
    .replace(/^\s*\|[-|\s]+\|\s*$/gm, ' ')
    .replace(/^\s*[{|}]\s*$/gm, ' ')
    .replace(/^\s*[|!].*$/gm, ' ')
    .replace(/^\s*={1,6}\s*(.*?)\s*={1,6}\s*$/gm, '\n$1\n')
    .replace(/^\s*[*#;:]+\s?/gm, '• ')
    .replace(/'{2,5}/g, '')
    .replace(/__[A-Z]+__/g, ' ');

  return stripHtml(s);
}

function stripHtml(s) {
  return decodeEntities(String(s || '')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\t\r]+/g, ' ')
    .replace(/[ \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function makeChunks(text) {
  const clean = stripHtml(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!clean) return [];

  // Overlapping windows cover the complete stored article, including its end.
  // At the configured 50,000-character maximum this produces fewer than 50 chunks.
  const chunks = [];
  const maxChars = 1400;
  const overlap = 220;
  let start = 0;

  while (start < clean.length && chunks.length < 100) {
    let end = Math.min(clean.length, start + maxChars);

    if (end < clean.length) {
      const boundary = clean.lastIndexOf('\n', end);
      if (boundary > start + 850) end = boundary;
    }

    const part = clean.slice(start, end).trim();
    if (part) chunks.push(part);

    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}

function wikiPages(data) {
  const pagesObj = data && data.query && data.query.pages;

  return Array.isArray(pagesObj)
    ? pagesObj
    : (pagesObj ? Object.values(pagesObj) : []);
}

function revisionContent(p) {
  const r = p && Array.isArray(p.revisions) && p.revisions[0];

  if (!r) return '';

  const slot = r.slots && r.slots.main;

  return String(
    (slot && (slot.content || slot['*'])) ||
    r.content ||
    r['*'] ||
    ''
  );
}

function makePageRecord(p, manifest) {
  const extractText = stripHtml(p.extract || '');
  const rawRevision = revisionContent(p);
  const revisionText = rawRevision ? stripWikitext(rawRevision) : '';

  const content = (
    extractText.length >= revisionText.length
      ? extractText
      : revisionText
  ).slice(0, MAX_PAGE_TEXT);

  const contentSource = extractText
    ? (
        extractText.length >= revisionText.length
          ? 'mediawiki-extract'
          : 'revision-wikitext'
      )
    : (
        revisionText
          ? 'revision-wikitext'
          : 'missing'
      );

  return {
    pageId: Number(p.pageid),
    title: String(p.title).slice(0, 300),
    url: String(
      p.fullurl ||
      (
        manifest.source.server.replace(/\/$/, '') +
        '/wiki/' +
        encodeURIComponent(p.title.replace(/ /g, '_'))
      )
    ).slice(0, 1000),
    revisionId: p.lastrevid ||
      (p.revisions && p.revisions[0] && p.revisions[0].revid) ||
      null,
    namespace: p.ns || 0,
    categories: (p.categories || [])
      .map(c => String(c.title || '').replace(/^Category:/, ''))
      .slice(0, 40),
    fetchedAt: new Date().toISOString(),
    extract: content,
    chunks: makeChunks(content),
    contentSource,
    contentLength: content.length
  };
}

function makeIndexItem(rec){
  const extract=String(rec.extract||'');
  const head=extract.slice(0,7000);
  const tail=extract.slice(-12000);
  const common=rec.title+' '+(rec.categories||[]).join(' ')+' ';
  const headTokens=searchTokens(common+head).slice(0,400);
  // Keep tokens closest to the actual end of the article as well.
  const tailTokens=searchTokens(tail).slice(-700);

  return {
    pageId:rec.pageId,
    title:rec.title,
    url:rec.url,
    revisionId:rec.revisionId,
    categories:rec.categories,
    lead:extract.slice(0,900),
    tail:extract.slice(-900),
    tokens:Array.from(new Set(headTokens.concat(tailTokens))).slice(0,1100)
  };
}

async function storeWikiPages(id, manifest, index, pages) {
  let added = 0;

  for (const p of pages) {
    if (!p || p.pageid === undefined || !p.title) continue;

    const rec = makePageRecord(p, manifest);
    const key = pageKey(id, rec.pageId);

    if (!rec.extract) {
      const old = await readJson(key).catch(() => null);

      if (old && old.extract) {
        rec.extract = old.extract;
        rec.chunks = old.chunks || makeChunks(old.extract);
        rec.contentSource = old.contentSource || 'preserved-existing';
        rec.contentLength = rec.extract.length;
      }
    }

    await writeJson(key, rec);

    const at = index.items.findIndex(x => x.pageId === rec.pageId);
    const item = makeIndexItem(rec);

    if (at >= 0) {
      index.items[at] = item;
    } else {
      index.items.push(item);
      added++;
    }
  }

  return added;
}

// Fetch actual revision source when the Wiki's extracts module returns no usable text.
async function enrichWikiPages(id, manifest, index, pageIds) {
  const requested = Array.from(
    new Set((pageIds || []).map(Number).filter(Number.isFinite))
  );

  const ids = [];

  for (const pageId of requested) {
    const existing = await readJson(pageKey(id, pageId)).catch(() => null);

    if (!existing || !existing.extract) {
      ids.push(pageId);
    }

    if (ids.length >= MAX_ENRICH_PAGES) break;
  }

  if (!ids.length) {
    return {
      enriched: 0,
      missing: 0,
      errors: []
    };
  }

  const errors = [];
  let enriched = 0;
  let missing = 0;
  const groups = [];

  for (let i = 0; i < ids.length; i += 8) {
    groups.push(ids.slice(i, i + 8));
  }

  for (const group of groups) {
    try {
      const data = await wikiGet(manifest.source.api, {
        action: 'query',
        pageids: group.join('|'),
        prop: 'extracts|revisions|info|categories',
        exintro: 0,
        explaintext: 1,
        exsectionformat: 'plain',
        exchars: MAX_PAGE_TEXT,
        rvprop: 'content',
        rvslots: 'main',
        inprop: 'url',
        cllimit: 30,
        format: 'json',
        formatversion: 2
      });

      const pages = wikiPages(data);

      await storeWikiPages(id, manifest, index, pages);

      for (const p of pages) {
        const rec = makePageRecord(p, manifest);

        if (rec.extract) {
          enriched++;
        } else {
          missing++;
        }
      }
    } catch (e) {
      errors.push(String(e && e.message || e).slice(0, 160));
    }
  }

  // Last-resort parser path for APIs that omit revision content in a multi-page query.
  let fallbackAttempts = 0;

  for (const pageId of ids) {
    const current = await readJson(pageKey(id, pageId)).catch(() => null);

    if (current && current.extract) continue;

    if (fallbackAttempts >= MAX_PARSE_FALLBACK_PAGES) {
      missing++;
      continue;
    }

    fallbackAttempts++;

    try {
      const parsed = await wikiGet(
        manifest.source.api,
        {
          action: 'parse',
          pageid: pageId,
          prop: 'wikitext|text',
          format: 'json',
          formatversion: 2
        },
        6000
      );

      const raw = parsed && parsed.parse && parsed.parse.wikitext;

      const wikitext = typeof raw === 'string'
        ? raw
        : (raw && (raw['*'] || raw.content)) || '';

      let text = wikitext ? stripWikitext(wikitext) : '';
      let source = 'parse-wikitext';

      if (!text) {
        const html = parsed && parsed.parse && parsed.parse.text;

        text = stripHtml(
          typeof html === 'string'
            ? html
            : (html && html['*']) || ''
        );

        source = 'parse-html';
      }

      if (text) {
        const rec = Object.assign({}, current || {}, {
          extract: text.slice(0, MAX_PAGE_TEXT),
          chunks: makeChunks(text),
          contentSource: source,
          contentLength: Math.min(text.length, MAX_PAGE_TEXT),
          fetchedAt: new Date().toISOString()
        });

        await writeJson(pageKey(id, pageId), rec);

        const at = index.items.findIndex(x => x.pageId === pageId);
        const item = makeIndexItem(rec);

        if (at >= 0) {
          index.items[at] = item;
        } else {
          index.items.push(item);
        }

        enriched++;
        missing = Math.max(0, missing - 1);
      }
    } catch (e) {
      errors.push(String(e && e.message || e).slice(0, 160));
    }
  }

  if (enriched) {
    await writeJson(indexKey(id), index);

    const m = await readJson(manifestKey(id)).catch(() => null) || manifest;

    m.pageCount = index.items.length;
    m.updatedAt = new Date().toISOString();

    await writeJson(manifestKey(id), m);

    manifest.pageCount = m.pageCount;
    manifest.updatedAt = m.updatedAt;
  }

  return {
    enriched,
    missing,
    errors
  };
}

function queryVariants(gameId, query, aliasMap) {
  const out = [String(query || '').trim()];
  const aliases = aliasMap && typeof aliasMap === 'object' ? aliasMap : {};
  const n = normalize(query);

  for (const [label, values] of Object.entries(aliases)) {
    const key = normalize(label);

    if (!key || !(n === key || (' ' + n + ' ').includes(' ' + key + ' '))) {
      continue;
    }

    const list = Array.isArray(values) ? values : [values];

    for (const value of list) {
      const v = String(value || '').trim().slice(0, MAX_QUERY);

      if (v && !out.some(x => normalize(x) === normalize(v))) {
        out.push(v);
      }

      if (out.length >= MAX_QUERY_VARIANTS) break;
    }

    if (out.length >= MAX_QUERY_VARIANTS) break;
  }

  return out.filter(Boolean).slice(0, MAX_QUERY_VARIANTS);
}

function translationLanguage(manifest) {
  const candidate = String(
    manifest && manifest.source && manifest.source.language ||
    process.env.KB_DEFAULT_WIKI_LANGUAGE ||
    'en'
  ).toLowerCase();

  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(candidate)
    ? candidate
    : 'en';
}

async function translateQueryToLanguage(query, targetLanguage, opts) {
  const q = String(query || '').trim();
  const target = String(targetLanguage || 'en').toLowerCase();
  // В быстром режиме перевод берём только из уже сохранённого кэша:
  // сетевой вызов переводчика не должен задерживать ответ Алисе.
  const cacheOnly = !!(opts && opts.cacheOnly);

  if (!q || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(target)) {
    return null;
  }

  const hasCyrillic = /[а-яё]/i.test(q);
  const hasNonAscii = /[^\x00-\x7F]/.test(q);

  if ((target === 'en' && !hasNonAscii) ||
      (target === 'ru' && hasCyrillic)) {
    return null;
  }

  const cacheKey = crypto.createHash('sha256')
    .update(target + '\n' + normalize(q))
    .digest('hex');

  const cachePath = 'translation-cache/' + cacheKey + '.json';

  try {
    const cached = await readJson(cachePath);

    if (cached &&
        cached.translation &&
        Date.now() - Date.parse(cached.savedAt || 0) <
          30 * 24 * 60 * 60 * 1000) {
      return cached.translation;
    }
  } catch {
    // Необязательный кэш перевода.
  }

  if (cacheOnly) return null;

  try {
    const u = new URL('https://translate.googleapis.com/translate_a/t');

    u.searchParams.set('client', 'dict-chrome-ex');
    u.searchParams.set('sl', 'auto');
    u.searchParams.set('tl', target);
    u.searchParams.set('dt', 't');
    u.searchParams.set('q', q.slice(0, MAX_QUERY));

    const response = await fetch(u.toString(), {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
      redirect: 'error'
    });

    if (!response.ok) {
      throw new Error('Translation HTTP ' + response.status);
    }

    const data = await response.json();
    let translated = '';

    if (Array.isArray(data) && Array.isArray(data[0])) {
      if (Array.isArray(data[0][0])) {
        translated = data[0]
          .map(x => Array.isArray(x) ? String(x[0] || '') : '')
          .join('');
      } else {
        translated = data
          .map(x => Array.isArray(x) ? String(x[0] || '') : '')
          .join('');
      }
    } else if (data && Array.isArray(data.sentences)) {
      translated = data.sentences
        .map(x => String(x.trans || ''))
        .join('');
    }

    translated = translated.trim().slice(0, MAX_QUERY);

    if (!translated || normalize(translated) === normalize(q)) {
      return null;
    }

    await writeJson(cachePath, {
      query: q,
      language: target,
      translation: translated,
      savedAt: new Date().toISOString()
    }).catch(() => {});

    return translated;
  } catch (e) {
    return null;
  }
}

async function buildQueryVariants(gameId, query, manifest, opts) {
  let aliasFile = null;

  try {
    aliasFile = await readJson(aliasesKey(gameId));
  } catch {
    // Необязательный файл псевдонимов.
  }

  const aliases = aliasFile &&
    aliasFile.aliases &&
    typeof aliasFile.aliases === 'object'
    ? aliasFile.aliases
    : {};

  const out = queryVariants(gameId, query, aliases);
  const target = translationLanguage(manifest);

  for (const candidate of out.slice(0, 2)) {
    const translated = await translateQueryToLanguage(candidate, target, opts);

    if (translated &&
        !out.some(x => normalize(x) === normalize(translated))) {
      out.push(translated);
    }

    if (out.length >= MAX_QUERY_VARIANTS) break;
  }

  return out.slice(0, MAX_QUERY_VARIANTS);
}

async function setGameAliases(body) {
  const id = slug(body.gameId || body.game || '');

  if (id === 'unknown-game') {
    throw new Error('gameId is required');
  }

  if (!(await readJson(manifestKey(id)))) {
    throw new Error('Game is not registered; call register first');
  }

  const input = body.aliases;

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      'aliases must be an object: {"Russian name":"source-language name"}'
    );
  }

  const current = await readJson(aliasesKey(id)) || {
    schemaVersion: 1,
    aliases: {}
  };

  current.aliases = current.aliases || {};

  let saved = 0;

  for (const [label, raw] of Object.entries(input).slice(0, 200)) {
    const key = String(label || '').trim().slice(0, 100);

    const values = (Array.isArray(raw) ? raw : [raw])
      .map(x => String(x || '').trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 4);

    if (key && values.length) {
      current.aliases[key] = values;
      saved++;
    }
  }

  current.updatedAt = new Date().toISOString();

  await writeJson(aliasesKey(id), current);

  return {
    status: 'ok',
    gameId: id,
    saved,
    totalAliases: Object.keys(current.aliases).length
  };
}

async function searchWikiOnDemand(id, manifest, index, variants) {
  let added = 0;
  let fetched = 0;
  const errors = [];
  const fetchedIds = [];

  // Обычно это исходный запрос и один перевод.
  for (const query of variants.slice(0, 2)) {
    try {
      const data = await wikiGet(manifest.source.api, {
        action: 'query',
        generator: 'search',
        gsrsearch: query,
        gsrnamespace: 0,
        gsrwhat: 'text',
        gsrlimit: ON_DEMAND_SEARCH_LIMIT,
        prop: 'extracts|info|categories',
        exintro: 0,
        explaintext: 1,
        exsectionformat: 'plain',
        exchars: MAX_PAGE_TEXT,
        inprop: 'url',
        cllimit: 20,
        format: 'json',
        formatversion: 2
      });

      const pages = wikiPages(data);

      fetched += pages.length;

      for (const p of pages) {
        if (p && p.pageid !== undefined) {
          fetchedIds.push(Number(p.pageid));
        }
      }

      added += await storeWikiPages(id, manifest, index, pages);
    } catch (e) {
      errors.push(String(e && e.message || e).slice(0, 140));
    }
  }

  const enriched = await enrichWikiPages(
    id,
    manifest,
    index,
    fetchedIds.slice(0, MAX_ENRICH_PAGES)
  );

  errors.push(...enriched.errors);

  if (fetched || enriched.enriched) {
    manifest.pageCount = index.items.length;
    manifest.updatedAt = new Date().toISOString();
    manifest.lastSearchFetchAt = manifest.updatedAt;

    await writeJson(indexKey(id), index);
    await writeJson(manifestKey(id), manifest);
  }

  return {
    added,
    fetched,
    enriched: enriched.enriched,
    missingContent: enriched.missing,
    errors
  };
}

async function syncGame(body) {
  const id = slug(body.gameId || body.game || '');

  if (id === 'unknown-game') {
    throw new Error('gameId is required');
  }

  const manifest = await readJson(manifestKey(id));

  if (!manifest) {
    throw new Error('Game is not registered; call register first');
  }

  if (manifest.complete) {
    return {
      status: 'complete',
      gameId: id,
      pageCount: manifest.pageCount,
      complete: true
    };
  }

  const index = await readJson(indexKey(id)) || {
    schemaVersion: 1,
    items: []
  };

  if ((index.items || []).length >= MAX_PAGES) {
    return {
      status: 'limit_reached',
      gameId: id,
      pageCount: index.items.length,
      complete: false,
      hasMore: !!manifest.cursor
    };
  }

  const limit = Math.min(
    MAX_BATCH,
    Math.max(1, Number(body.limit || MAX_BATCH)),
    MAX_PAGES - index.items.length
  );

  const params = {
    action: 'query',
    generator: 'allpages',
    gapnamespace: 0,
    gaplimit: limit,
    gapfilterredir: 'nonredirects',
    prop: 'extracts|info|categories',
    exintro: 0,
    explaintext: 1,
    exsectionformat: 'plain',
    exchars: MAX_PAGE_TEXT,
    inprop: 'url',
    cllimit: 20,
    format: 'json',
    formatversion: 2
  };

  if (manifest.cursor) {
    params.gapcontinue = manifest.cursor;
  }

  const data = await wikiGet(manifest.source.api, params);
  const pages = wikiPages(data);
  const added = await storeWikiPages(id, manifest, index, pages);

  const next = data && data.continue && data.continue.gapcontinue
    ? data.continue.gapcontinue
    : null;

  manifest.cursor = next;
  manifest.pageCount = index.items.length;
  manifest.complete = !next;
  manifest.status = manifest.complete
    ? 'complete'
    : (index.items.length >= MAX_PAGES ? 'limit_reached' : 'indexing');

  manifest.updatedAt = new Date().toISOString();
  manifest.lastSyncAt = manifest.updatedAt;

  if (index.items.length >= MAX_PAGES && next) {
    manifest.errors = (manifest.errors || [])
      .concat([
        'KB_MAX_PAGES reached. Increase the environment limit and call sync again to continue from the saved cursor.'
      ])
      .slice(-10);
  }

  await writeJson(indexKey(id), index);
  await writeJson(manifestKey(id), manifest);

  return {
    status: manifest.status,
    gameId: id,
    batchAdded: added,
    pageCount: manifest.pageCount,
    complete: manifest.complete,
    hasMore: !!next,
    nextAction: manifest.complete ? 'ready' : 'sync'
  };
}

function scoreItem(item,terms){
  const title=new Set(searchTokens(item.title)),lead=new Set(searchTokens(item.lead));
  const tail=new Set(searchTokens(item.tail||'')),tokens=new Set(item.tokens||[]);
  let score=0,matched=0;

  for(const t of terms){
    let hit=false;
    if(title.has(t)){
      score+=16;
      hit=true;
    }else if(tokens.has(t)){
      score+=4;
      hit=true;
    }
    if(lead.has(t))score+=2;
    if(tail.has(t))score+=3;
    if(hit)matched++;
  }

  if(terms.length&&matched>=Math.min(2,terms.length))score+=4;
  return score;
}

function scoreEvidenceChunk(chunk,terms,query) {
  const text = normalize(chunk);
  const tokens = new Set(searchTokens(chunk));
  let score = 0;
  let matched = 0;

  for (const term of terms) {
    if (tokens.has(term)) {
      score += 2;
      matched++;
    }
  }

  if (terms.length && matched >= Math.min(2, terms.length)) score += 3;

  const hasEpitaphEvidence =
    /\b(epitaph|inscription|tombstone|gravestone|memorial plaque)\b/u.test(text) ||
    /эпитаф|надпис/u.test(text);

  const hasNameEvidence =
    /\b(real name|birth name|full name|given name|born as|legal name)\b/u.test(text) ||
    /настоящ[\p{L}]*\s+имя|полное имя|имени при рождении/u.test(text);

  if (isEpitaphIntent(query) && hasEpitaphEvidence) score += 55;
  if (isRealNameIntent(query) && hasNameEvidence) score += 28;
  if (isEpitaphIntent(query) && isRealNameIntent(query) &&
      hasEpitaphEvidence && hasNameEvidence) score += 25;

  return score;
}

function bestEvidenceChunk(page,terms,query) {
  // Rebuild chunks from the full saved article instead of trusting legacy chunks,
  // which may have been created by an older parser and may omit relevant passages.
  const rebuilt = makeChunks(page.extract || '');
  const chunks = rebuilt.length
    ? rebuilt
    : (Array.isArray(page.chunks) ? page.chunks : []);

  let best = '';
  let bestScore = -1;

  for(const chunk of chunks){
    const score=scoreEvidenceChunk(chunk,terms,query);
    if(score>bestScore){
      bestScore=score;
      best=chunk;
    }
  }

  return {
    evidence:best||page.extract||'',
    score:Math.max(0,bestScore)
  };
}

function searchCacheGet(key) {
  const hit = SEARCH_CACHE.get(key);

  if (!hit) return null;

  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    SEARCH_CACHE.delete(key);
    return null;
  }

  return hit.value;
}

function searchCacheSet(key, value) {
  if (SEARCH_CACHE.size >= SEARCH_CACHE_MAX) {
    const oldest = SEARCH_CACHE.keys().next();
    if (!oldest.done) SEARCH_CACHE.delete(oldest.value);
  }

  SEARCH_CACHE.set(key, { at: Date.now(), value });
}

async function searchGame(body) {
  const id = slug(body.gameId || body.game || '');
  const q = String(body.query || body.q || '').trim().slice(0, MAX_QUERY);
  // fast: только локальный индекс. Нужен для короткого ответа в реплику Алисы.
  const fast = body.fast === true || body.fast === 1 ||
    body.fast === '1' || body.fast === 'true';
  const cacheKey = id + '|' + (fast ? 'fast|' : 'full|') + normalize(q);

  if (!q) {
    throw new Error('query is required');
  }

  const cached = searchCacheGet(cacheKey);

  if (cached) {
    return Object.assign({}, cached, {
      cached: true,
      search: Object.assign({}, cached.search, { cache: 'warm' })
    });
  }

  let manifest = await readJson(manifestKey(id));

  if (!manifest) {
    try {
      await registerGame({
        game: body.game || body.gameId,
        gameId: id,
        wikiApi: body.wikiApi || ''
      });
    } catch (e) {
      return {
        status: 'needs_wiki',
        gameId: id,
        message: String(e && e.message || 'Wiki source is not configured')
      };
    }

    manifest = await readJson(manifestKey(id));
  }

  if (manifest &&
      !manifest.complete &&
      (manifest.status === 'registered' || manifest.status === 'indexing')) {
    try {
      await syncGame({
        gameId: id,
        limit: Math.min(10, MAX_BATCH)
      });
    } catch (e) {
      console.error('kb auto-sync:', e && e.message);
    }

    manifest = await readJson(manifestKey(id));
  }

  let index = await readJson(indexKey(id)) || {
    items: []
  };

  const variants = await buildQueryVariants(id, q, manifest, {
    cacheOnly: fast
  });

  const terms = Array.from(new Set(
    variants.flatMap(v => searchTokens(v))
      .concat(queryHintTerms(q).flatMap(v => searchTokens(v)))
  ));

  const rank = () => (index.items || [])
    .map(x => ({
      item: x,
      score: scoreItem(x, terms)
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  let ranked = rank();

  const hasNonLatin =
    /[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}]/u.test(q);

  const needsLiveSearch =
    !fast && (
      !ranked.length ||
      ranked[0].score < 15 ||
      hasNonLatin ||
      variants.length > 1
    );

  let liveSearch = {
    added: 0,
    fetched: 0,
    enriched: 0,
    missingContent: 0,
    errors: []
  };

  if (needsLiveSearch) {
    liveSearch = await searchWikiOnDemand(
      id,
      manifest,
      index,
      variants
    );

    if (liveSearch.fetched || liveSearch.enriched) {
      ranked = rank();
    }
  }

  // Re-rank a wider set so relevant passages near article ends are not missed.
  const candidateLimit=fast
    ? Math.min(FAST_CANDIDATE_LIMIT,Math.max(4,Number(body.candidateLimit||FAST_CANDIDATE_LIMIT)))
    : Math.min(30,Math.max(10,Number(body.candidateLimit||30)));
  let candidates=ranked.slice(0,candidateLimit);
  const needsContent=[];

  for(const hit of candidates){
    const page=await readJson(pageKey(id,hit.item.pageId)).catch(()=>null);
    if(!page||!page.extract)needsContent.push(hit.item.pageId);
  }

  if(needsContent.length&&!fast){
    const extra=await enrichWikiPages(
      id,
      manifest,
      index,
      needsContent.slice(0,MAX_ENRICH_PAGES)
    );

    liveSearch.enriched+=extra.enriched;
    liveSearch.missingContent+=extra.missing;
    liveSearch.errors.push(...extra.errors);

    if(extra.enriched){
      ranked=rank();
      candidates=ranked.slice(0,candidateLimit);
    }
  }

  const evaluated=[];
  let indexChanged=false;

  for(let offset=0;offset<candidates.length;offset+=8){
    const group=candidates.slice(offset,offset+8);

    const loaded=await Promise.all(group.map(async hit=>{
      const page=await readJson(
        pageKey(id,hit.item.pageId)
      ).catch(()=>null);

      if(!page||!page.extract)return null;

      const refreshed=makeIndexItem(page);
      const at=index.items.findIndex(x=>x.pageId===page.pageId);

      if(at>=0){
        if(JSON.stringify(index.items[at])!==JSON.stringify(refreshed)){
          index.items[at]=refreshed;
          indexChanged=true;
        }
      }else{
        index.items.push(refreshed);
        indexChanged=true;
      }

      const picked=bestEvidenceChunk(page,terms,q);

      return {
        item:refreshed,
        page,
        evidence:String(picked.evidence||'').slice(0,2000),
        evidenceScore:picked.score,
        score:hit.score+Math.min(90,picked.score*3)
      };
    }));

    evaluated.push(...loaded.filter(Boolean));
  }

  if(indexChanged&&!fast)await writeJson(indexKey(id),index);

  evaluated.sort((a,b)=>
    b.score-a.score||b.evidenceScore-a.evidenceScore
  );

  const requestedLimit=Math.min(8,Math.max(1,Number(body.limit||5)));
  const selected=evaluated
    .filter(x=>x.evidenceScore>0)
    .slice(0,requestedLimit);

  const results=selected.map(hit=>{
    const page=hit.page;
    const evidence=hit.evidence;
    const isRussian=/[а-яё]/i.test(page.title+' '+evidence);

    return {
      title:page.title,
      url:page.url,
      revisionId:page.revisionId,
      categories:page.categories,
      score:hit.score,
      evidenceScore:hit.evidenceScore,
      evidence,
      contentAvailable:!!page.extract,
      contentLength:page.contentLength||(page.extract||'').length,
      contentSource:page.contentSource||(page.extract?'stored':'missing'),
      source:manifest.source.siteName,
      language:isRussian?'ru':(manifest.source.language||'unknown')
    };
  });

  const payload = {
    status: results.length
      ? 'ok'
      : (manifest.complete ? 'no_evidence' : 'indexing'),
    gameId: id,
    game: manifest.game,
    gameVersion: manifest.gameVersion || 'unspecified',
    edition: manifest.edition || 'unspecified',
    database: {
      status: manifest.status,
      pages: manifest.pageCount,
      complete: manifest.complete,
      note: 'complete means the current initial all-pages scan reached its end; it does not mean every article on the Wiki has been downloaded.'
    },
    search: {
      mode: fast
        ? 'local-fast'
        : (needsLiveSearch ? 'local+wiki' : 'local'),
      fast: fast === true,
      queryVariants: variants,
      fetchedPages: liveSearch.fetched,
      addedPages: liveSearch.added,
      enrichedPages: liveSearch.enriched,
      missingContentPages: liveSearch.missingContent,
      translationTarget: translationLanguage(manifest),
      errors: liveSearch.errors
    },
    results
  };

  // Кэшируем только содержательные ответы: пустой быстрый поиск не должен
  // блокировать более полный поиск с обращением к вики.
  if (results.length) searchCacheSet(cacheKey, payload);

  return payload;
}

async function statusGame(body) {
  const id = slug(body.gameId || body.game || '');
  const m = await readJson(manifestKey(id));

  if (!m) {
    return {
      status: 'not_found',
      gameId: id
    };
  }

  return {
    status: 'ok',
    gameId: id,
    game: m.game,
    databaseStatus: m.status,
    pageCount: m.pageCount,
    complete: m.complete,
    completeMeaning: 'Initial scan cursor has reached the end; on-demand search can still add articles.',
    source: m.source,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastSyncAt: m.lastSyncAt,
    errors: m.errors || []
  };
}

async function route(event) {
  const q = event.queryStringParameters || {};
  const headers = event.headers || {};

  // HTTP-заголовки регистронезависимы.
  const normalizedHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[String(key).toLowerCase()] = value;
  }

  const authorization = String(
    normalizedHeaders.authorization || ''
  ).replace(/^Bearer\s+/i, '').trim();

  const headerToken = String(
    normalizedHeaders['x-kb-token'] || ''
  ).trim();

  // query token оставлен для совместимости с прежними клиентами.
  const auth = q.token || authorization || headerToken;

  if (!TOKEN || !safeEqual(auth, TOKEN)) {
    return json(403, { status: 'forbidden' });
  }

  if (event.httpMethod === 'GET' && q.ping === '1') {
    return json(200, {
      status: 'pong',
      version: KB_VERSION
    });
  }

  let body = {};

  if (event.body) {
    try {
      body = JSON.parse(
        event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf8')
          : event.body
      );
    } catch {
      return json(400, { status: 'bad_json' });
    }
  }

  const input = Object.assign({}, q, body);
  const action = String(input.action || '').toLowerCase();

  try {
    if (action === 'register') {
      return json(200, await registerGame(input));
    }

    if (action === 'sync') {
      return json(200, await syncGame(input));
    }

    if (action === 'syncall') {
      return json(200, await syncNextGame());
    }

    if (action === 'search') {
      return json(200, await searchGame(input));
    }

    if (action === 'setaliases') {
      return json(200, await setGameAliases(input));
    }

    if (action === 'status') {
      return json(200, await statusGame(input));
    }

    if (action === 'discover') {
      const game = String(input.game || '').trim();

      if (input.wikiApi) {
        const wiki = await resolveWiki(game, input.wikiApi);

        return json(200, {
          status: 'found',
          game,
          source: wiki
        });
      }

      return json(200, await discoverWiki(game));
    }

    return json(400, {
      status: 'bad_request',
      allowedActions: [
        'discover',
        'register',
        'sync',
        'syncAll',
        'status',
        'search',
        'setAliases'
      ]
    });
  } catch (e) {
    console.error('kb error:', e && e.message);

    return json(502, {
      status: 'error',
      message: String(e && e.message || 'unknown error').slice(0, 240)
    });
  }
}

module.exports.handler = async function (event) {
  try {
    return await route(event || {});
  } catch (e) {
    console.error('kb fatal:', e && e.message);
    return json(500, { status: 'server_error' });
  }
};

module.exports._test = {
  normalize,
  searchTokens,
  stemSearchToken,
  isRealNameIntent,
  isEpitaphIntent,
  queryHintTerms,
  scoreEvidenceChunk,
  bestEvidenceChunk,
  slug,
  stripHtml,
  stripWikitext,
  removeBalancedTemplates,
  makeChunks,
  scoreItem,
  queryVariants,
  translationLanguage,
  translateQueryToLanguage,
  wikiPages,
  revisionContent,
  makePageRecord,
  makeIndexItem,
  allowedWikiHost,
  validateApiUrl,
  decodeHtml,
  unwrapSearchUrl,
  CATALOG,
  KB_VERSION
};
