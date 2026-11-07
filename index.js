'use strict';

// Moon-skill async adapter v1.0
// Entry point: index.handler
// Keep the current v9.6-a-v3.7 skill implementation unchanged as
// moon-skill-core.js. This adapter transparently converts only question POSTs
// into Yandex Cloud Functions asynchronous invocations. GET answer/ping/stats
// calls and game-selection POSTs remain ordinary synchronous HTTPS requests.

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

// Intercept exactly the existing Moon-vision POST /?token=... request whose
// JSON body contains q. setGame POSTs have only game and are not intercepted.
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

        const asyncUrl = CLOUD_URL + '?integration=async';
        const response = await nativeFetch(asyncUrl, Object.assign({}, options, {
          body: JSON.stringify(asyncPayload)
        }));

        if (response.status === 202) {
          const cid = payload.cid;
          const qid = qidFromCid(cid);

          console.log(JSON.stringify({
            component: 'moon-skill-async',
            status: 'accepted',
            qid: qid
          }));

          // The unchanged skill core expects a synchronous {status:'query',
          // qid, cid} response. Return that internally after Yandex accepted
          // the async invocation; the user still sees the normal skill reply.
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

        // Preserve any real error response; do not disguise it as accepted.
        return response;
      }
    }
  }

  return nativeFetch(input, init);
};

const core = require('./moon-skill-core.js');
module.exports.handler = core.handler;
