'use strict';

// Общий стенд: подменяет Object Storage в памяти и запрещает любой другой сетевой выход.
// Нужен, чтобы проверять функции локально без облака и без секретов.

const objects = new Map();
const foreign = [];
const routes = new Map();
let puts = 0;
let gets = 0;
let etagSeq = 0;

// Позволяет подменить внешний сервис (базу знаний, модель) в тестах.
function mount(hostname, handler) {
  routes.set(String(hostname), handler);
}

function header(headers, name) {
  const h = headers || {};
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === name.toLowerCase()) return String(h[k]);
  }
  return '';
}

function keyFrom(pathname) {
  const parts = pathname.replace(/^\//, '').split('/');
  parts.shift();
  return decodeURIComponent(parts.join('/'));
}

function install() {
  globalThis.fetch = async function (input, init) {
    const options = init || {};
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(options.method || 'GET').toUpperCase();

    if (url.hostname !== 'storage.yandexcloud.net') {
      const route = routes.get(url.hostname);

      if (route) {
        const out = await route(url, options, method);
        return new Response(JSON.stringify(out.body), {
          status: out.status || 200,
          headers: { 'content-type': 'application/json' }
        });
      }

      foreign.push(method + ' ' + url.href);
      throw new Error('network blocked in tests: ' + url.href);
    }

    const key = keyFrom(url.pathname);

    if (method === 'GET') {
      gets++;
      const cur = objects.get(key);
      if (!cur) return new Response('', { status: 404 });
      return new Response(cur.body, {
        status: 200,
        headers: { etag: cur.etag }
      });
    }

    if (method === 'PUT') {
      const ifMatch = header(options.headers, 'If-Match');
      const ifNone = header(options.headers, 'If-None-Match');
      const cur = objects.get(key);

      if (ifMatch && (!cur || cur.etag !== ifMatch)) {
        return new Response('', { status: 412 });
      }
      if (ifNone && cur) return new Response('', { status: 412 });

      const body = Buffer.from(
        options.body === undefined ? '' : options.body
      );
      const etag = 'e' + (++etagSeq);
      objects.set(key, { body: body, etag: etag });
      puts++;
      return new Response('', { status: 200, headers: { etag: etag } });
    }

    return new Response('', { status: 405 });
  };
}

function put(key, value) {
  const body = Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value)
  );
  objects.set(key, { body: body, etag: 'seed' + (++etagSeq) });
}

function get(key) {
  const cur = objects.get(key);
  if (!cur) return null;
  try {
    return JSON.parse(cur.body.toString('utf8'));
  } catch (e) {
    return null;
  }
}

function reset() {
  objects.clear();
  foreign.length = 0;
  puts = 0;
  gets = 0;
  etagSeq = 0;
}

module.exports = {
  install: install,
  mount: mount,
  put: put,
  get: get,
  reset: reset,
  foreign: foreign,
  stats: function () {
    return { puts: puts, gets: gets };
  }
};
