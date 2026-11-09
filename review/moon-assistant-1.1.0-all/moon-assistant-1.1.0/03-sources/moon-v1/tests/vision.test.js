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
const modelState = { mode: 'ok', lastUser: '', failNext: 0 };
// Собственный адрес vision: туда уходит фоновый ?warm=1.
const selfCalls = [];

s3.mount('functions.yandexcloud.net', async function (url) {
  selfCalls.push(url.href);

  return { status: 200, body: { status: 'ok' } };
});

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
  if (modelState.failNext > 0) {
    modelState.failNext--;

    return { status: 500, body: { error: 'boom' } };
  }

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

async function postFrame() {
  const res = await mv.handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    queryStringParameters: { token: TOKEN },
    body: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]),
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

  // --- 11. первый вопрос по новой игре сам запускает прогрев в фоне ---
  s3.reset();
  s3.put('state.json', blank());
  kbState.mode = 'hit';
  modelState.mode = 'ok';
  selfCalls.length = 0;

  await post({
    q: 'кто главные герои игры', game: GAME, cid: 'c-auto-1', uid: UID
  });

  const autoState = s3.get('state.json') || {};
  const warmCalls1 = selfCalls.filter(u => /warm=1/.test(u));
  const deepCalls1 = selfCalls.filter(u => /deep=1/.test(u));

  check('фон: прогрев поставлен после первого вопроса',
    autoState.warm && autoState.warm.status === 'scheduled',
    JSON.stringify(autoState.warm));
  check('фон: self-вызов ?warm=1 отправлен',
    warmCalls1.length === 1, selfCalls.join(' | '));
  check('фон: в self-вызове передана игра',
    warmCalls1.length === 1 &&
      /Cyberpunk/.test(decodeURIComponent(warmCalls1[0])),
    selfCalls.join(' | '));
  check('фон: разбор запущен отдельным вызовом ?deep=1',
    deepCalls1.length === 1 && /qid=\d+/.test(deepCalls1[0]),
    selfCalls.join(' | '));

  // --- 12. повторный вопрос не дублирует прогрев ---
  selfCalls.length = 0;

  await post({
    q: 'что это за персонаж', game: GAME, cid: 'c-auto-2', uid: UID
  });

  check('фон: повторный вопрос не греет повторно',
    selfCalls.filter(u => /warm=1/.test(u)).length === 0,
    selfCalls.join(' | '));

  // --- 13. другая игра — новый прогрев ---
  selfCalls.length = 0;

  await post({
    q: 'кто главные герои', game: 'Minecraft', cid: 'c-auto-3', uid: UID
  });

  const warmCalls3 = selfCalls.filter(u => /warm=1/.test(u));

  check('фон: смена игры запускает новый прогрев',
    warmCalls3.length === 1 &&
      /Minecraft/.test(decodeURIComponent(warmCalls3[0])),
    selfCalls.join(' | '));

  // --- 14. уже тёплая база заново не греется ---
  s3.reset();
  const warmState = blank();
  warmState.warm = {
    game: GAME,
    status: 'ok',
    at: Date.now(),
    startedAt: Date.now(),
    pages: 6
  };
  s3.put('state.json', warmState);
  selfCalls.length = 0;

  await post({
    q: 'кто главные герои игры', game: GAME, cid: 'c-auto-4', uid: UID
  });

  check('фон: тёплая база не перегревается',
    selfCalls.filter(u => /warm=1/.test(u)).length === 0,
    selfCalls.join(' | '));

  // --- 15. начало стрима: первый ?poll=1 греет базу до вопросов ---
  s3.reset();
  const streamState = blank();
  streamState.game = GAME;
  streamState.gameSetAt = Date.now();
  s3.put('state.json', streamState);
  selfCalls.length = 0;

  const poll = await call({ poll: '1' });

  check('стрим: опрос отвечает как раньше', poll.body.status === 'ok',
    JSON.stringify(poll.body).slice(0, 100));
  check('стрим: прогрев стартовал без вопроса',
    selfCalls.length === 1 && /warm=1/.test(selfCalls[0]),
    selfCalls.join(' | '));
  check('стрим: прогрев записан в состояние',
    (s3.get('state.json') || {}).warm &&
    s3.get('state.json').warm.status === 'scheduled',
    JSON.stringify((s3.get('state.json') || {}).warm));

  selfCalls.length = 0;
  await call({ poll: '1' });
  check('стрим: следующий опрос не греет повторно',
    selfCalls.length === 0, selfCalls.join(' | '));

  // --- 16. первый кадр нового стрима тоже запускает прогрев ---
  s3.reset();
  const frameState = blank();
  frameState.game = GAME;
  frameState.gameSetAt = Date.now();
  s3.put('state.json', frameState);
  selfCalls.length = 0;

  const frame = await postFrame();

  check('кадр: загружен', frame.body.status === 'ok',
    JSON.stringify(frame.body).slice(0, 100));
  check('кадр: прогрев стартовал от первого кадра',
    selfCalls.length === 1 && /warm=1/.test(selfCalls[0]),
    selfCalls.join(' | '));
  check('кадр: прогрев записан в состояние',
    (s3.get('state.json') || {}).warm &&
    s3.get('state.json').warm.status === 'scheduled',
    JSON.stringify((s3.get('state.json') || {}).warm));

  // --- 17. игра без свежей привязки стрим не греет ---
  s3.reset();
  s3.put('state.json', blank());
  selfCalls.length = 0;

  await call({ poll: '1' });

  check('стрим: без названной игры прогрева нет',
    selfCalls.length === 0, selfCalls.join(' | '));

  // --- 18. смена игры: ответ и ready прошлой игры не всплывают ---
  s3.reset();
  const gA = blank();
  gA.game = 'Minecraft';
  gA.gameSetAt = Date.now();
  gA.answers['301'] = doneRecord({ game: GAME, cid: 'c-old-1' });
  s3.put('state.json', gA);

  const cfgOld = await call({ config: '1' });
  const rdOld = await call({ ready: '1' });

  check('смена игры: готовый ответ прошлой игры не всплывает',
    cfgOld.body.ready === null, JSON.stringify(cfgOld.body.ready));
  check('смена игры: ?ready тоже молчит',
    rdOld.body.ready === null, JSON.stringify(rdOld.body.ready));

  // --- 19. смена игры отменяет незавершённый вопрос и снимает маркер ---
  s3.reset();
  const gC = blank();
  gC.game = GAME;
  gC.gameSetAt = Date.now();
  gC.marker = { type: 'rect', x1: 10, y1: 10, x2: 20, y2: 20 };
  gC.markerSetAt = Date.now();
  gC.answers['302'] = {
    status: 'pending', q: 'что за персонаж', game: GAME, uid: UID,
    createdAt: Math.floor(Date.now() / 1000), createdAtMs: Date.now()
  };
  s3.put('state.json', gC);

  const swGame = await post({ game: 'Minecraft' });
  const gAfter = s3.get('state.json') || {};

  check('смена игры: принято', swGame.body.status === 'ok', swGame.body.status);
  check('смена игры: старый вопрос отменён',
    gAfter.answers && gAfter.answers['302'] &&
    gAfter.answers['302'].status === 'cancelled',
    JSON.stringify(gAfter.answers && gAfter.answers['302']));
  check('смена игры: маркер снят', gAfter.marker === null,
    JSON.stringify(gAfter.marker));
  check('смена игры: игра записана', gAfter.game === 'Minecraft', gAfter.game);

  // --- 20. та же игра не трогает незавершённый вопрос ---
  s3.reset();
  const gD = blank();
  gD.game = GAME;
  gD.gameSetAt = Date.now();
  gD.answers['303'] = {
    status: 'pending', q: 'где найти аптечку', game: GAME, uid: UID,
    createdAt: Math.floor(Date.now() / 1000), createdAtMs: Date.now()
  };
  s3.put('state.json', gD);

  await post({ game: GAME });

  const gSame = s3.get('state.json') || {};

  check('та же игра: вопрос не отменён',
    gSame.answers && gSame.answers['303'] &&
    gSame.answers['303'].status === 'pending',
    JSON.stringify(gSame.answers && gSame.answers['303']));

  // --- 21. прогрев прошлой игры не затирает статус новой ---
  const mergedWarm = mv.__test.mergeState(
    {
      game: GAME, gameSetAt: 1, answers: {}, qcache: {}, users: {},
      warm: { game: GAME, status: 'ok', at: 99 }
    },
    {
      game: 'Minecraft', gameSetAt: 5, answers: {}, qcache: {}, users: {},
      warm: { game: 'Minecraft', status: 'scheduled', at: 5 }
    },
    Date.now()
  );

  check('прогрев: игра берётся новая', mergedWarm.game === 'Minecraft',
    mergedWarm.game);
  check('прогрев: статус новой игры не затёрт старой',
    mergedWarm.warm && mergedWarm.warm.game === 'Minecraft' &&
    mergedWarm.warm.status === 'scheduled',
    JSON.stringify(mergedWarm.warm));

  // --- 22. сбой модели: один повтор возвращает ответ ---
  s3.reset();
  kbState.mode = 'empty';
  modelState.mode = 'ok';
  modelState.failNext = 1;
  selfCalls.length = 0;

  const fst = blank();
  fst.game = GAME;
  fst.gameSetAt = Date.now();
  fst.lastFrameTs = Math.floor(Date.now() / 1000);
  fst.warm = {
    game: GAME, status: 'ok', at: Date.now(), startedAt: Date.now(), pages: 6
  };
  fst.ring = [{ ts: fst.lastFrameTs, size: 8, key: 'frames/f1.jpg' }];
  s3.put('state.json', fst);
  s3.put('frames/f1.jpg', 'jpegdata');

  const retried = await post({
    q: 'что видно на экране сейчас', game: GAME, cid: 'c-retry-1', uid: UID
  });

  check('модель: повтор после 5xx дал ответ',
    retried.body.status === 'done' && !!retried.body.text,
    JSON.stringify(retried.body).slice(0, 140));
  check('модель: ответ по кадру', retried.body.src === 'screen',
    retried.body.src);

  // --- 23. два сбоя подряд: ошибка видна в диагностике ---
  s3.reset();
  kbState.mode = 'empty';
  modelState.mode = 'ok';
  modelState.failNext = 2;

  const fst2 = blank();
  fst2.game = GAME;
  fst2.gameSetAt = Date.now();
  fst2.lastFrameTs = Math.floor(Date.now() / 1000);
  fst2.warm = {
    game: GAME, status: 'ok', at: Date.now(), startedAt: Date.now(), pages: 6
  };
  fst2.ring = [{ ts: fst2.lastFrameTs, size: 8, key: 'frames/f1.jpg' }];
  s3.put('state.json', fst2);
  s3.put('frames/f1.jpg', 'jpegdata');

  const failedCall = await post({
    q: 'какой сейчас уровень', game: GAME, cid: 'c-retry-2', uid: UID
  });

  check('модель: после двух сбоев честный unk',
    failedCall.body.status === 'done' && failedCall.body.unk === true,
    JSON.stringify(failedCall.body).slice(0, 140));

  const dg = await call({ diag: '1' });

  check('диагностика: версия', dg.body.ver === '4.1.0', dg.body.ver);
  check('диагностика: игра и прогрев',
    dg.body.game === GAME && dg.body.warm && dg.body.warm.game === GAME,
    JSON.stringify(dg.body.warm));
  check('диагностика: последние ответы',
    Array.isArray(dg.body.recent) && dg.body.recent.length > 0,
    JSON.stringify(dg.body.recent).slice(0, 120));
  check('диагностика: время ответа считается',
    dg.body.recent.some(r => typeof r.ms === 'number' && r.ms >= 0),
    JSON.stringify(dg.body.recent).slice(0, 160));
  check('диагностика: размер состояния оценён',
    dg.body.state_bytes > 100, dg.body.state_bytes);
  check('диагностика: флаги базы и модели',
    dg.body.kb && dg.body.kb.url === true && dg.body.kb.token === true &&
    dg.body.model && dg.body.model.key === true,
    JSON.stringify(dg.body.kb) + JSON.stringify(dg.body.model));
  check('диагностика: ошибка модели зафиксирована',
    !!dg.body.last_model_error && dg.body.last_model_error.err !== 0,
    JSON.stringify(dg.body.last_model_error));
  check('диагностика: готовый ответ учтён',
    dg.body.answers && (dg.body.answers.deep_ready || dg.body.answers.quick_ready ||
      dg.body.answers.done || dg.body.answers.cancelled ||
      dg.body.answers.pending), JSON.stringify(dg.body.answers));
  check('диагностика: два этапа видны',
    dg.body.deep && dg.body.deep.enabled === true &&
      dg.body.recent.some(r => r.stage === 'deep'),
    JSON.stringify(dg.body.deep) + JSON.stringify(dg.body.recent).slice(0, 120));

  // --- 24. токен заголовком X-Moon-Token ---
  const pingH = await mv.handler({
    httpMethod: 'GET',
    headers: { 'X-Moon-Token': TOKEN },
    queryStringParameters: { ping: '1' }
  });
  const pingBad = await mv.handler({
    httpMethod: 'GET',
    headers: { 'x-moon-token': 'wrong-token' },
    queryStringParameters: { ping: '1' }
  });
  const pingNone = await mv.handler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { ping: '1' }
  });

  check('токен заголовком: доступ есть', pingH.statusCode === 200,
    pingH.statusCode);
  check('токен заголовком: чужой отклонён', pingBad.statusCode === 403,
    pingBad.statusCode);
  check('без токена: отказ', pingNone.statusCode === 403,
    pingNone.statusCode);

  // --- 25. зависший прогрев перестаёт долбить сам себя ---
  s3.reset();
  const stuck = blank();
  stuck.game = GAME;
  stuck.gameSetAt = Date.now();
  stuck.warm = {
    game: GAME, status: 'scheduled', at: Date.now() - 200000,
    startedAt: Date.now() - 200000, pages: 0, kicks: 3
  };
  s3.put('state.json', stuck);
  selfCalls.length = 0;

  await call({ poll: '1' });

  check('прогрев: после трёх неудач пауза, а не новый вызов',
    selfCalls.length === 0, selfCalls.join(' | '));

  s3.reset();
  const half = blank();
  half.game = GAME;
  half.gameSetAt = Date.now();
  half.warm = {
    game: GAME, status: 'scheduled', at: Date.now() - 200000,
    startedAt: Date.now() - 200000, pages: 0, kicks: 1
  };
  s3.put('state.json', half);
  selfCalls.length = 0;

  await call({ poll: '1' });

  check('прогрев: зависший вызов повторяется не сразу',
    selfCalls.length === 1, selfCalls.join(' | '));

  // --- 27. два этапа: короткий ответ и вдумчивый разбор ---
  s3.reset();

  const two = blank();

  two.game = GAME;
  two.gameSetAt = Date.now();
  two.warm = {
    game: GAME, status: 'ok', at: Date.now(), startedAt: Date.now(), pages: 6
  };
  s3.put('state.json', two);

  kbState.mode = 'hit';
  modelState.mode = 'ok';
  modelState.failNext = 0;
  selfCalls.length = 0;
  kbState.log.length = 0;

  const ask = await post({
    q: 'когда основан найт сити', game: GAME, cid: 'c-two-1', uid: UID
  });

  check('этапы: короткий ответ отдан сразу',
    ask.body.status === 'done' && ask.body.stage === 'quick' &&
      String(ask.body.text || '').length > 0,
    JSON.stringify(ask.body).slice(0, 160));
  check('этапы: разбор обещан, но не финал',
    ask.body.final === false && ask.body.deep_pending === true,
    JSON.stringify(ask.body).slice(0, 160));
  check('этапы: короткий этап шёл по быстрому поиску',
    kbState.log.includes('fast') && !kbState.log.includes('full'),
    kbState.log.join(','));
  check('этапы: разбор поставлен отдельным вызовом',
    selfCalls.filter(u => /deep=1/.test(u)).length === 1,
    selfCalls.join(' | '));

  const qid = ask.body.qid;

  const ackQuick = await call({ ack: '1', qid: String(qid) });

  check('этапы: ack помечает стадию quick',
    ackQuick.body.status === 'ok' && ackQuick.body.stage === 'quick',
    JSON.stringify(ackQuick.body));

  const light = await call({ answer: '1', qid: String(qid) });

  check('этапы: лёгкий опрос отдаёт короткий ответ и не считает разбор',
    light.body.stage === 'quick' && String(light.body.text || '').length > 0 &&
      !kbState.log.includes('full'),
    JSON.stringify(light.body).slice(0, 160) + ' ' + kbState.log.join(','));

  kbState.log.length = 0;

  const deep = await call({ deep: '1', qid: String(qid) });

  check('этапы: ?deep=1 отдаёт разбор',
    deep.body.stage === 'deep' && deep.body.final === true &&
      String(deep.body.text || '').length > 0,
    JSON.stringify(deep.body).slice(0, 160));
  check('этапы: разбор шёл по полному поиску',
    kbState.log.includes('full'), kbState.log.join(','));
  check('этапы: разбор сохранил короткий ответ',
    typeof deep.body.quick_text === 'string' &&
      deep.body.quick_text.length > 0,
    JSON.stringify(deep.body).slice(0, 160));

  kbState.log.length = 0;

  const deepAgain = await call({ deep: '1', qid: String(qid) });

  check('этапы: готовый разбор не пересчитывается',
    kbState.log.length === 0 && deepAgain.body.stage === 'deep',
    kbState.log.join(','));

  const readyDeep = await call({ ready: '1' });

  check('этапы: разбор показывается даже после ack короткого',
    readyDeep.body.ready && readyDeep.body.ready.stage === 'deep' &&
      readyDeep.body.ready.final === true,
    JSON.stringify(readyDeep.body.ready));

  await call({ ack: '1', qid: String(qid) });

  const readyAfter = await call({ ready: '1' });

  check('этапы: после ack разбора показывать нечего',
    !readyAfter.body.ready || readyAfter.body.ready.qid !== qid,
    JSON.stringify(readyAfter.body.ready));

  // Разбор не удался — короткий ответ не должен пропасть.
  s3.reset();
  s3.put('state.json', two);
  kbState.mode = 'hit';
  modelState.mode = 'ok';
  kbState.log.length = 0;

  const ask2 = await post({
    q: 'кто такие фиксеры', game: GAME, cid: 'c-two-2', uid: UID
  });

  const quickText = String(ask2.body.text || '');

  modelState.mode = 'unk';

  const deepFail = await call({ deep: '1', qid: String(ask2.body.qid) });

  check('этапы: неудачный разбор не стирает короткий ответ',
    deepFail.body.stage === 'deep' &&
      String(deepFail.body.text || '') === quickText,
    JSON.stringify(deepFail.body).slice(0, 200));

  // --- 28. часовая копия состояния ---
  const hourKey = 'backup/state-' +
    new Date().toISOString().slice(0, 13).replace(/[-:T]/g, '') + '.json';

  check('резервная копия: создана в этом часу',
    s3.get(hourKey) !== null, hourKey);

  // --- 29. гонка ack: подтверждается именно показанная стадия ---
  s3.reset();

  const race = blank();

  race.game = GAME;
  race.gameSetAt = Date.now();
  race.warm = {
    game: GAME, status: 'ok', at: Date.now(), startedAt: Date.now(), pages: 6
  };
  s3.put('state.json', race);

  kbState.mode = 'hit';
  modelState.mode = 'ok';
  selfCalls.length = 0;

  const raceAsk = await post({
    q: 'когда основан найт сити', game: GAME, cid: 'c-race-1', uid: UID
  });
  const raceQid = String(raceAsk.body.qid);

  check('гонка ack: короткий ответ получен',
    raceAsk.body.stage === 'quick' && raceQid !== '0',
    JSON.stringify(raceAsk.body).slice(0, 160));

  // Разбор заканчивается раньше, чем оверлей подтвердил короткий ответ.
  const raceDeep = await call({ deep: '1', qid: raceQid });

  check('гонка ack: разбор готов до подтверждения',
    raceDeep.body.stage === 'deep' && raceDeep.body.final === true,
    JSON.stringify(raceDeep.body).slice(0, 160));

  // Запоздавшее подтверждение именно короткого ответа.
  const lateQuick = await call({ ack: '1', qid: raceQid, stage: 'quick' });

  check('гонка ack: запоздавший quick подтверждает quick, а не deep',
    lateQuick.body.status === 'ok' && lateQuick.body.stage === 'quick',
    JSON.stringify(lateQuick.body));

  const raceReady = await call({ ready: '1' });

  check('гонка ack: разбор всё ещё ждёт показа',
    raceReady.body.ready && raceReady.body.ready.qid === Number(raceQid) &&
      raceReady.body.ready.stage === 'deep' && raceReady.body.ready.final === true,
    JSON.stringify(raceReady.body.ready));

  const deepAck = await call({ ack: '1', qid: raceQid, stage: 'deep' });

  check('гонка ack: подтверждение deep помечает deep',
    deepAck.body.status === 'ok' && deepAck.body.stage === 'deep',
    JSON.stringify(deepAck.body));

  const raceReadyAfter = await call({ ready: '1' });

  check('гонка ack: после подтверждения разбора показывать нечего',
    !raceReadyAfter.body.ready || raceReadyAfter.body.ready.qid !== Number(raceQid),
    JSON.stringify(raceReadyAfter.body.ready));

  // Запоздавшее quick после подтверждённого разбора не откатывает стадию.
  const staleQuick = await call({ ack: '1', qid: raceQid, stage: 'quick' });

  check('гонка ack: поздний quick не откатывает подтверждённый deep',
    staleQuick.body.status === 'ok' && staleQuick.body.stage === 'deep',
    JSON.stringify(staleQuick.body));

  // --- 30. обратная совместимость: ack без stage ---
  s3.reset();

  const compat = blank();

  compat.game = GAME;
  compat.gameSetAt = Date.now();
  compat.answers['777'] = doneRecord({
    qid: 777,
    status: 'deep_ready',
    quick: { text: 'Найт-Сити основан в мае 1994 года.', src: 'kb', unk: false },
    text: 'Разбор: Найт-Сити основан в мае 1994 года.',
    ackedAt: 0,
    ackedStage: ''
  });
  s3.put('state.json', compat);

  const compatReady = await call({ ready: '1' });

  check('совместимость: разбор ждёт показа до подтверждения',
    compatReady.body.ready && compatReady.body.ready.qid === 777 &&
      compatReady.body.ready.stage === 'deep',
    JSON.stringify(compatReady.body.ready));

  const compatAck = await call({ ack: '1', qid: '777' });

  check('совместимость: ack без stage подтверждает текущую стадию',
    compatAck.body.status === 'ok' && compatAck.body.stage === 'deep',
    JSON.stringify(compatAck.body));

  const compatAfter = await call({ ready: '1' });

  check('совместимость: после старого ack повтора нет',
    !compatAfter.body.ready || compatAfter.body.ready.qid !== 777,
    JSON.stringify(compatAfter.body.ready));

  const failed = results.filter(r => !r.ok);

  console.log('\n' + (results.length - failed.length) + '/' +
    results.length + ' проверок пройдено');

  if (failed.length) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
