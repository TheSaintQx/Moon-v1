'use strict';

// Moon-skill async adapter v1.1
// Entry point: index.handler
// Keep the skill core separate as moon-skill-core.js.
// Question POSTs are converted to asynchronous Yandex Cloud invocations.
// GET answer/progress/ping/stats and game-selection POSTs remain synchronous.
//
// v1.1:
// - токен ищется и в заголовке X-Moon-Token (так его шлёт ядро с v10.0),
//   и в ?token= (совместимость со старыми сборками). В v1.0 проверялся только
//   ?token=, поэтому при переходе на заголовок перехват перестал срабатывать
//   и весь асинхронный путь молча выключился;
// - собственный вызов (?integration=async) никогда не перехватывается —
//   иначе адаптер зациклился бы сам на себя;
// - ошибка асинхронного запуска не выдаётся за принятую задачу.

const crypto = require('crypto');
const CLOUD_URL = String(
  process.env.VISION_URL ||
  'https://functions.yandexcloud.net/d4el6hpg7nh0cui52kd2'
).replace(/\/+$/, '');
const nativeFetch = globalThis.fetch.bind(globalThis);

function getRequestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) {
    try { return new URL(input); } catch (e) { return null; }
  }
  if (input && typeof input.url === 'string') {
    try { return new URL(input.url); } catch (e) { return null; }
  }
  return null;
}

function parseJsonBody(body) {
  if (typeof body !== 'string') return null;
  try { return JSON.parse(body); } catch (e) { return null; }
}

// Заголовки могут прийти как объект, как Headers или как массив пар.
function headerValue(headers, name) {
  if (!headers) return '';
  const want = String(name).toLowerCase();

  if (typeof headers.get === 'function') {
    const v = headers.get(name);
    return v === null || v === undefined ? '' : String(v);
  }

  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && String(pair[0]).toLowerCase() === want) {
        return String(pair[1] || '');
      }
    }
    return '';
  }

  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) {
      return String(headers[k] === undefined ? '' : headers[k]);
    }
  }

  return '';
}

function tokenOf(requestUrl, options) {
  const fromHeader = headerValue(options && options.headers, 'x-moon-token').trim();
  if (fromHeader) return fromHeader;

  const fromQuery = requestUrl.searchParams.get('token');
  return fromQuery ? String(fromQuery).trim() : '';
}

function qidFromCid(cid) {
  return parseInt(
    crypto.createHash('sha256').update(String(cid)).digest('hex').slice(0, 12),
    16
  ) || 1;
}

// Intercept only the existing Moon-vision question POST with q + cid.
// Game-selection POSTs contain game only and therefore pass through unchanged.
globalThis.fetch = async function (input, init) {
  const options = init || {};
  const method = String(options.method ||
    (input && input.method) || 'GET').toUpperCase();

  if (method !== 'POST') return nativeFetch(input, init);

  let requestUrl = null;

  try {
    requestUrl = getRequestUrl(input);
  } catch (e) {
    requestUrl = null;
  }

  if (!requestUrl) return nativeFetch(input, init);

  const sameOrigin = requestUrl.origin + requestUrl.pathname === CLOUD_URL;

  // Собственный асинхронный вызов адаптера не перехватываем.
  if (!sameOrigin || requestUrl.searchParams.has('integration')) {
    return nativeFetch(input, init);
  }

  const token = tokenOf(requestUrl, options);

  if (!token) return nativeFetch(input, init);

  const payload = parseJsonBody(options.body);

  if (!payload || typeof payload.q !== 'string' || !payload.q.trim() ||
      typeof payload.cid !== 'string' || !payload.cid) {
    return nativeFetch(input, init);
  }

  const asyncPayload = Object.assign({}, payload, {
    action: 'ask',
    token: token
  });

  const response = await nativeFetch(CLOUD_URL + '?integration=async',
    Object.assign({}, options, { body: JSON.stringify(asyncPayload) }));

  if (response.status === 202) {
    const cid = payload.cid;
    const qid = qidFromCid(cid);

    console.log(JSON.stringify({
      component: 'moon-skill-async',
      status: 'accepted',
      qid: qid
    }));

    // The unchanged core expects {status:'query', qid, cid}.
    // The async invocation stores the real job; the core polls it by CID.
    return new Response(JSON.stringify({
      status: 'query',
      qid: qid,
      cid: cid,
      async: true
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  // Preserve real errors; never disguise a rejected invocation as accepted.
  return response;
};

const core = require('./moon-skill-core.js');
module.exports.handler = core.handler;
module.exports._adapter = {
  headerValue: headerValue,
  tokenOf: tokenOf,
  qidFromCid: qidFromCid
};
