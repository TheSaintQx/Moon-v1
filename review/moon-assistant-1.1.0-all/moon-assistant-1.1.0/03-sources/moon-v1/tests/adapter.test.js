'use strict';

// Проверка асинхронного адаптера навыка (moon-skill-index.js).
// Главный дефект, который здесь закреплён: адаптер искал токен только в
// адресе (?token=), а ядро с v10.0 шлёт его заголовком X-Moon-Token —
// из-за этого перехват не срабатывал и весь асинхронный путь был мёртвым.

const path = require('path');

// Подмена сети должна стоять ДО require адаптера: он запоминает fetch.
const calls = [];
let reply = { status: 202, body: { status: 'accepted' } };

globalThis.fetch = async function (input, init) {
  const options = init || {};
  const url = new URL(typeof input === 'string' ? input : input.url);

  calls.push({
    url: url.href,
    method: String(options.method || 'GET').toUpperCase(),
    headers: options.headers || {},
    body: String(options.body || '')
  });

  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json' }
  });
};

const adapter = require(path.join(__dirname, '..', 'moon-skill-index.js'));

const TOKEN = 'test-moon-token-0123456789';
const VISION = 'https://functions.yandexcloud.net/d4el6hpg7nh0cui52kd2';

const results = [];

function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name +
    (ok || !detail ? '' : ' -> ' + detail));
}

function reset() {
  calls.length = 0;
  reply = { status: 202, body: { status: 'accepted' } };
}

async function post(url, body, headers) {
  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: headers || {},
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch (e) { json = null; }
  return { status: res.status, body: json };
}

async function main() {
  // 1. Токен заголовком — перехват работает.
  reset();

  const byHeader = await post(VISION, { q: 'кто такая джуди', cid: 'c-1', game: 'Cyberpunk 2077' },
    { 'Content-Type': 'application/json', 'X-Moon-Token': TOKEN });

  check('адаптер: токен заголовком перехвачен',
    calls.length === 1 && /\?integration=async$/.test(calls[0].url),
    calls.map(c => c.url).join(' | '));
  check('адаптер: 202 превращается в принятую задачу',
    byHeader.status === 200 && byHeader.body &&
      byHeader.body.status === 'query' && byHeader.body.async === true,
    JSON.stringify(byHeader.body));
  check('адаптер: qid выводится из cid',
    byHeader.body && byHeader.body.qid === adapter._adapter.qidFromCid('c-1'),
    byHeader.body && byHeader.body.qid);
  check('адаптер: в асинхронный запрос уходит токен',
    calls.length === 1 && /"token":"test-moon-token/.test(calls[0].body),
    calls.length ? calls[0].body.slice(0, 160) : '');
  check('адаптер: в асинхронный запрос уходит действие ask',
    calls.length === 1 && /"action":"ask"/.test(calls[0].body),
    calls.length ? calls[0].body.slice(0, 160) : '');

  // 2. Совместимость: токен в адресе тоже работает.
  reset();

  await post(VISION + '?token=' + TOKEN, { q: 'что такое ночноголос', cid: 'c-2' });

  check('адаптер: токен в адресе тоже перехвачен',
    calls.length === 1 && /integration=async/.test(calls[0].url),
    calls.map(c => c.url).join(' | '));

  // 3. Без токена — прямой проход.
  reset();

  await post(VISION, { q: 'кто такая джуди', cid: 'c-3' });

  check('адаптер: без токена запрос идёт напрямую',
    calls.length === 1 && !/integration=async/.test(calls[0].url),
    calls.map(c => c.url).join(' | '));

  // 4. Выбор игры (только game) — прямой проход.
  reset();

  await post(VISION, { game: 'Minecraft' }, { 'X-Moon-Token': TOKEN });

  check('адаптер: выбор игры не перехватывается',
    calls.length === 1 && !/integration=async/.test(calls[0].url),
    calls.map(c => c.url).join(' | '));

  // 5. Собственный асинхронный вызов не перехватывается повторно.
  reset();

  await post(VISION + '?integration=async',
    { action: 'ask', q: 'кто такая джуди', cid: 'c-4', token: TOKEN },
    { 'X-Moon-Token': TOKEN });

  check('адаптер: собственный вызов не зацикливается',
    calls.length === 1 && !/\?integration=async\?/.test(calls[0].url) &&
      calls.filter(c => /integration=async/.test(c.url)).length === 1,
    calls.map(c => c.url).join(' | '));

  // 6. Ошибка платформы не выдаётся за принятую задачу.
  reset();
  reply = { status: 500, body: { error: 'platform down' } };

  const failed = await post(VISION, { q: 'кто такая джуди', cid: 'c-5' },
    { 'X-Moon-Token': TOKEN });

  check('адаптер: ошибка запуска не маскируется',
    failed.status === 500, failed.status + ' ' + JSON.stringify(failed.body));

  // 7. Заголовки в разных формах читаются одинаково.
  check('адаптер: заголовки объектом',
    adapter._adapter.headerValue({ 'x-moon-token': 'abc' }, 'X-Moon-Token') === 'abc',
    'object');
  check('адаптер: заголовки Headers',
    adapter._adapter.headerValue(new Headers({ 'X-Moon-Token': 'def' }), 'x-moon-token') === 'def',
    'headers');
  check('адаптер: заголовки массивом пар',
    adapter._adapter.headerValue([['X-Moon-Token', 'ghi']], 'x-moon-token') === 'ghi',
    'array');
  check('адаптер: пустые заголовки',
    adapter._adapter.headerValue(null, 'x-moon-token') === '',
    'null');

  const bad = results.filter(r => !r.ok);

  console.log('\n' + (results.length - bad.length) + '/' +
    results.length + ' проверок пройдено');

  if (bad.length) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
