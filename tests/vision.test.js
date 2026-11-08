'use strict';

// Проверка moon-vision: answer_ready, подтверждение показа, быстрый state,
// кэш готовых ответов и контекст коротких уточнений.

process.env.AUTH_TOKEN = 'test-auth-token-01234';
process.env.BUCKET = 'moon-assistant';
process.env.ACCESS_KEY_ID = 'test-key-id';
process.env.SECRET_ACCESS_KEY = 'test-secret';
process.env.KB_URL = 'https://kb.test/search';
process.env.KB_TOKEN = 'test-kb-token';
process.env.YC_API_KEY = 'test-yc-key';
process.env.MODEL_URI = 'gpt://folder/qwen/latest';

const crypto = require('crypto');
const path = require('path');
const s3 = require('./fake-s3');

s3.install();

const mv = require(process.env.VISION_MODULE || path.join(__dirname, '..', 'moon-vision-core.js'));

const TOKEN = process.env.AUTH_TOKEN;
const UID = 'u-0123456789abcdef';
const GAME = 'Cyberpunk 2077';
const Q = 'когда основан найт сити';

// --- подмена базы знаний и модели ---
const kbState = { mode: 'empty', log: [], intent: null, comparison: null };
const modelState = { mode: 'ok', lastUser: '' };

s3.mount('kb.test', async function (url, init) {
  const body = JSON.parse(String(init.body || '{}'));

  if (body.action === 'warm') {
    kbState.log.push('warm');

    return {
      status: 200,
      body: {
        status: 'ok',
        gameId: 'cyberpunk-2077',
        game: 'Cyberpunk 2077',
        cached: false,
        pages: 6,
        pageCount: 120,
        sections: { main: [9], characters: [1, 2, 3], locations: [4] }
      }
    };
  }

  const fast = body.fast === true;

  kbState.log.push(fast ? 'fast' : 'full');

  if (kbState.mode === 'empty') {
    return {
      status: 200,
      body: { status: 'ok', game: 'Cyberpunk 2077', results: [] }
    };
  }

  return {
    status: 200,
    body: Object.assign({
      status: 'ok',
      game: 'Cyberpunk 2077',
      results: [{
        title: 'Найт-Сити',
        evidence: 'Найт-Сити был основан в мае 1994 года.'
      }]
    }, kbState.intent ? { intent: kbState.intent } : {},
    kbState.comparison ? { comparison: kbState.comparison } : {})
  };
});

s3.mount('ai.api.cloud.yandex.net', async function (url, init) {
  const sent = JSON.parse(String(init.body || '{}'));

  modelState.lastUser = String(
    (sent.messages && sent.messages[1] && sent.messages[1].content) || ''
  );
  const answer = modelState.mode === 'ok'
    ? {
        speech: 'Найт-Сити основан в мае 1994 года.',
        unk: false, conf: 0.9, clarify: null, marker: null
      }
    : {
        speech: 'В выдержках нет ответа.',
        unk: true, conf: 0, clarify: null, marker: null
      };

  return {
    status: 200,
    body: {
      choices: [{ message: { content: JSON.stringify(answer) } }]
    }
  };
});

function normalize(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[!.,?;:«»"()\-—–]/g, ' ').replace(/\s+/g, ' ').trim();
}

function qcacheKey(uid, game, q) {
  return crypto.createHash('sha256')
    .update(String(uid || '') + '\n' + normalize(game) + '\n' + normalize(q))
    .digest('hex').slice(0, 24);
}

function blank() {
  return {
    game: '', gameSetAt: 0, lastFrameTs: 0, lastFrameSize: 0, qid: 0,
    frameSeq: 0, ring: [], lastAnswerText: '', lastAnswerAt: 0,
    marker: null, markerSetAt: 0, answers: {}, qcache: {}, users: {}
  };
}

function doneRecord(extra) {
  const now = Math.floor(Date.now() / 1000);
  return Object.assign({
    status: 'done',
    q: normalize(Q),
    game: GAME,
    cid: 'c-test-1',
    uid: UID,
    show: false,
    createdAt: now - 5,
    createdAtMs: Date.now() - 5000,
    doneAt: now,
    doneAtMs: Date.now(),
    text: 'Найт-Сити был основан в мае 1994 года.',
    marker: null,
    unk: false,
    src: 'kb',
    frame_id: null,
    conf: 0.8,
    resultStatus: 'done'
  }, extra || {});
}

async function call(qp) {
  const res = await mv.handler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: Object.assign({ token: TOKEN }, qp),
    body: null
  });
  return { code: res.statusCode, body: JSON.parse(res.body) };
}

async function post(body) {
  const res = await mv.handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    queryStringParameters: { token: TOKEN },
    body: JSON.stringify(body),
    isBase64Encoded: false
  });
  return { code: res.statusCode, body: JSON.parse(res.body) };
}

const results = [];

function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name +
    (ok || !detail ? '' : ' -> ' + detail));
}

async function main() {
  // --- 1. answer_ready ---
  s3.reset();
  const st = blank();
  st.answers['111'] = doneRecord();
  s3.put('state.json', st);

  const cfg = await call({ config: '1' });
  check('config: ready приходит',
    cfg.body.ready && cfg.body.ready.type === 'answer_ready',
    JSON.stringify(cfg.body.ready));
  check('config: ready содержит текст',
    cfg.body.ready && /1994/.test(cfg.body.ready.text),
    cfg.body.ready && cfg.body.ready.text);
  check('config: qid верный',
    cfg.body.ready && cfg.body.ready.qid === 111,
    cfg.body.ready && cfg.body.ready.qid);

  // --- 2. ack ---
  const ack = await call({ ack: '1', qid: '111' });
  check('ack: подтверждён', ack.body.status === 'ok', ack.body.status);

  const cfg2 = await call({ config: '1' });
  check('ack: ready больше не повторяется', cfg2.body.ready === null,
    JSON.stringify(cfg2.body.ready));

  // --- 3. progress ---
  const pr = await call({ progress: '1', cid: 'c-test-1' });
  check('progress: находит по cid', pr.body.status === 'done', pr.body.status);
  check('progress: отдаёт текст', /1994/.test(String(pr.body.text || '')),
    String(pr.body.text || ''));

  // --- 4. кэш готовых ответов ---
  s3.reset();
  const st2 = blank();
  st2.qcache[qcacheKey(UID, GAME, Q)] = {
    text: 'Из кэша: Найт-Сити основан в мае 1994 года.',
    src: 'kb', conf: 0.9, at: Math.floor(Date.now() / 1000), qid: 0
  };
  s3.put('state.json', st2);

  const cached = await post({ q: Q, game: GAME, cid: 'c-cache-1', uid: UID });
  check('кэш: ответ сразу', cached.body.status === 'done', cached.body.status);
  check('кэш: источник cache', cached.body.src === 'cache', cached.body.src);
  check('кэш: текст из кэша', /Из кэша/.test(String(cached.body.text || '')),
    String(cached.body.text || ''));

  const pr2 = await call({ progress: '1', cid: 'c-cache-1' });
  check('кэш: опрос по cid находит ответ', pr2.body.status === 'done',
    pr2.body.status);

  // --- 5. контекст короткого уточнения ---
  s3.reset();
  const st3 = blank();
  st3.answers['222'] = doneRecord({ cid: 'c-prev', qid: 222 });
  s3.put('state.json', st3);

  await post({ q: 'а кем основан', game: GAME, cid: 'c-ctx-1', uid: UID });

  const after = s3.get('state.json') || {};
  const rec = (after.answers || {})['0'] || null;
  const ids = Object.keys(after.answers || {});
  const ctxRec = ids
    .map(id => after.answers[id])
    .filter(r => r && r.cid === 'c-ctx-1')[0];

  check('контекст: запись создана', !!ctxRec, 'ids=' + ids.join(','));
  check('контекст: поисковый запрос расширен',
    ctxRec && /найт/.test(String(ctxRec.searchQ || '')),
    ctxRec && ctxRec.searchQ);
  check('контекст: сохранён исходный вопрос',
    ctxRec && String(ctxRec.ctx || '').indexOf('найт') !== -1,
    ctxRec && ctxRec.ctx);

  // --- 6. быстрый поиск ответил сразу: полного поиска нет ---
  s3.reset();
  s3.put('state.json', blank());
  kbState.mode = 'hit';
  modelState.mode = 'ok';
  kbState.log = [];

  const fastAnswer = await post({
    q: 'когда основан найт сити', game: GAME, cid: 'c-kb-1', uid: UID
  });

  check('быстрый поиск: ответ из базы',
    /1994/.test(String(fastAnswer.body.text || '')),
    String(fastAnswer.body.text || ''));
  check('быстрый поиск: источник kb', fastAnswer.body.src === 'kb',
    fastAnswer.body.src);
  check('быстрый поиск: без полного обхода',
    kbState.log.join(',') === 'fast', kbState.log.join(','));

  // --- 7. быстрый дал материалы, но ответа нет — идём в полный поиск ---
  s3.reset();
  s3.put('state.json', blank());
  modelState.mode = 'unk';
  kbState.log = [];

  const escalated = await post({
    q: 'сколько жителей в найт сити', game: GAME, cid: 'c-kb-2', uid: UID
  });

  check('недостаточно выдержек: полный поиск выполнен',
    kbState.log.join(',') === 'fast,full', kbState.log.join(','));
  check('недостаточно выдержек: ответ всё равно есть',
    !!escalated.body.text, JSON.stringify(escalated.body));

  // --- 8. быстрый пуст — полный поиск тоже выполняется ---
  s3.reset();
  s3.put('state.json', blank());
  kbState.mode = 'empty';
  modelState.mode = 'ok';
  kbState.log = [];

  await post({
    q: 'какие банды есть в найт сити', game: GAME, cid: 'c-kb-3', uid: UID
  });

  check('пустой быстрый поиск: полный выполнен',
    kbState.log.join(',') === 'fast,full', kbState.log.join(','));

  // --- 9. прогрев базы при выборе игры ---
  s3.reset();
  s3.put('state.json', blank());
  kbState.log = [];

  const warm = await call({ warm: '1', game: GAME, uid: UID });

  check('прогрев: статус ok', warm.body.status === 'ok',
    JSON.stringify(warm.body).slice(0, 120));
  check('прогрев: вызов дошел до базы', kbState.log.join(',') === 'warm',
    kbState.log.join(','));
  check('прогрев: количество статей',
    warm.body.warm && warm.body.warm.pages === 6,
    JSON.stringify(warm.body.warm));
  check('прогрев: разбивка по разделам',
    warm.body.warm && warm.body.warm.sections &&
    warm.body.warm.sections.characters === 3,
    JSON.stringify(warm.body.warm && warm.body.warm.sections));

  const savedWarm = (s3.get('state.json') || {}).warm;
  check('прогрев: итог записан в состояние',
    savedWarm && savedWarm.game === GAME && savedWarm.pages === 6,
    JSON.stringify(savedWarm));

  const cfgWarm = await call({ config: '1' });
  check('прогрев: виден в ответе config',
    cfgWarm.body.warm && cfgWarm.body.warm.game === GAME,
    JSON.stringify(cfgWarm.body.warm));

  // --- 10. намерение вопроса уходит в модель ---
  s3.reset();
  s3.put('state.json', blank());
  kbState.mode = 'hit';
  modelState.mode = 'ok';
  kbState.log = [];
  kbState.intent = { name: 'characters', section: 'characters' };
  modelState.lastUser = '';

  await post({
    q: 'кто главные герои игры', game: GAME, cid: 'c-intent-1', uid: UID
  });

  check('намерение: подсказка о персонажах в запросе к модели',
    /персонаж/i.test(modelState.lastUser),
    modelState.lastUser.slice(0, 140));

  kbState.intent = { name: 'compare', section: '' };
  kbState.comparison = { entities: ['Джонни', 'Джеки'] };
  modelState.lastUser = '';

  await post({
    q: 'кто лучше джонни или джеки', game: GAME, cid: 'c-intent-2', uid: UID
  });

  check('намерение: сравнение доходит до модели',
    /Джонни/.test(modelState.lastUser) && /Джеки/.test(modelState.lastUser),
    modelState.lastUser.slice(0, 160));

  kbState.intent = null;
  kbState.comparison = null;

  const failed = results.filter(r => !r.ok);

  console.log('\n' + (results.length - failed.length) + '/' +
    results.length + ' проверок пройдено');

  if (failed.length) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
