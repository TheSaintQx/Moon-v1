'use strict';

// Moon-skill async adapter v1.0
// Entry point: index.handler
// Keep the skill core separate as moon-skill-core.js.
// Question POSTs are converted to asynchronous Yandex Cloud invocations.
// GET answer/ping/stats and game-selection POSTs remain synchronous.

const crypto = require('crypto');
const CLOUD_URL = 'https://functions.yandexcloud.net/d4el6hpg7nh0cui52kd2';
const nativeFetch = globalThis.fetch.bind(globalThis);

function getRequestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return new URL(input);
  if (input && typeof input.url === 'string') return new URL(input.url);
  return null;
}

function parseJsonBody(body) {
  if (typeof body !== 'string') return null;
  try { return JSON.parse(body); } catch (e) { return null; }
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

  if (method === 'POST') {
    let requestUrl = null;
    try { requestUrl = getRequestUrl(input); } catch (e) { requestUrl = null; }

    if (requestUrl && requestUrl.origin + requestUrl.pathname === CLOUD_URL &&
        requestUrl.searchParams.has('token')) {
      const payload = parseJsonBody(options.body);

      if (payload && typeof payload.q === 'string' && payload.q.trim() &&
          typeof payload.cid === 'string' && payload.cid) {
        const token = requestUrl.searchParams.get('token');
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
      }
    }
  }

  return nativeFetch(input, init);
};

const core = require('./moon-skill-core.js');
module.exports.handler = core.handler;
