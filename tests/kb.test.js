'use strict';

// Проверка быстрого режима базы знаний:
//   * fast:true отвечает по локальному индексу и не ходит в вики;
//   * fast:true не перезаписывает индекс;
//   * повторный запрос отдаётся из кэша тёплого экземпляра;
//   * обычный режим по-прежнему доходит до вики.

process.env.KB_TOKEN = 'test-kb-token-0123456789';
process.env.KB_BUCKET = 'moon-assistant';
process.env.ACCESS_KEY_ID = 'test-key-id';
process.env.SECRET_ACCESS_KEY = 'test-secret';
process.env.S3_REGION = 'ru-central1';

const fs = require('fs');
const path = require('path');
const s3 = require('./fake-s3');

s3.install();

const kb = require(process.env.KB_MODULE || path.join(__dirname, '..', 'moon-knowledge-index.js'));

const GAME = 'cyberpunk-2077';
// В бакете всё лежит под префиксом KB_PREFIX (по умолчанию kb).
const ROOT = 'kb/games/' + GAME;

const EXTRACT =
  'Найт-Сити — город будущего в Калифорнии. ' +
  'Найт-Сити был основан в мае 1994 года усилиями пяти корпораций. ' +
  'Инициатором создания стал Ричард Найт.';

function seed() {
  s3.reset();

  s3.put(ROOT + '/manifest.json', {
    game: 'Cyberpunk 2077',
    gameId: GAME,
    status: 'complete',
    complete: true,
    pageCount: 1,
    source: {
      siteName: 'Cyberpunk Wiki',
      language: 'ru',
      api: 'https://cyberpunk.fandom.com/api.php'
    },
    createdAt: '2026-01-01T00:00:00.000Z'
  });

  s3.put(ROOT + '/index.json', {
    items: [
      {
        pageId: 101,
        title: 'Найт-Сити',
        url: 'https://cyberpunk.fandom.com/wiki/Night_City',
        revisionId: 1,
        categories: ['Города'],
        lead: EXTRACT.slice(0, 300),
        tail: EXTRACT.slice(-200),
        tokens: [
          'найт', 'сити', 'город', 'основан', 'май', 'мае',
          '1994', 'корпорац', 'калифорн'
        ]
      }
    ]
  });

  s3.put(ROOT + '/pages/101.json', {
    pageId: 101,
    title: 'Найт-Сити',
    url: 'https://cyberpunk.fandom.com/wiki/Night_City',
    revisionId: 1,
    categories: ['Города'],
    extract: EXTRACT,
    contentLength: EXTRACT.length,
    contentSource: 'stored'
  });
}

function event(body) {
  return {
    httpMethod: 'POST',
    headers: { 'x-kb-token': process.env.KB_TOKEN },
    queryStringParameters: {},
    body: JSON.stringify(body),
    isBase64Encoded: false
  };
}

async function search(extra) {
  const res = await kb.handler(event(Object.assign({
    action: 'search',
    game: 'Cyberpunk 2077',
    query: 'когда основан найт сити'
  }, extra)));

  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const results = [];

function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name +
    (ok || !detail ? '' : ' -> ' + detail));
}

async function main() {
  seed();

  const fast = await search({ fast: true });

  check('fast: статус ok', fast.body.status === 'ok', fast.body.status);
  check('fast: режим local-fast',
    fast.body.search && fast.body.search.mode === 'local-fast',
    JSON.stringify(fast.body.search && fast.body.search.mode));
  check('fast: есть выдержки',
    Array.isArray(fast.body.results) && fast.body.results.length > 0,
    'results=' + (fast.body.results || []).length);
  check('fast: выдержка содержит ответ',
    (fast.body.results[0] || {}).evidence &&
    /1994/.test(fast.body.results[0].evidence),
    String((fast.body.results[0] || {}).evidence || '').slice(0, 80));
  check('fast: ни одного внешнего запроса',
    s3.foreign.length === 0, s3.foreign.join(' | '));

  const before = s3.stats().puts;
  const fast2 = await search({ fast: true });

  check('fast: повтор из кэша', fast2.body.cached === true,
    String(fast2.body.cached));
  check('fast: кэш не пишет в S3', s3.stats().puts === before,
    before + ' -> ' + s3.stats().puts);

  seed();

  const full = await search({});
  check('полный режим: статус ok', full.body.status === 'ok',
    full.body.status);
  check('полный режим: вика вызывается', s3.foreign.length > 0,
    'foreign=' + s3.foreign.length);
  check('полный режим: режим local+wiki',
    full.body.search && full.body.search.mode === 'local+wiki',
    JSON.stringify(full.body.search && full.body.search.mode));

  const failed = results.filter(r => !r.ok);

  console.log('\n' + (results.length - failed.length) + '/' +
    results.length + ' проверок пройдено');

  if (failed.length) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
