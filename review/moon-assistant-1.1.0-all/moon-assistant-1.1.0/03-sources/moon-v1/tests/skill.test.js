'use strict';

// Проверка навыка Moon против поддельного moon-vision.
// Сценарии: ответ сразу, ожидание с подсказкой про оверлей, забор ответа
// по «ну что там», честный прогресс и сохранение незавершённой задачи.

process.env.MOON_TOKEN = 'test-moon-token-0123456789';

const path = require('path');

const server = {
  ask: { status: 'query', qid: 123, cid: 'c-1', async: true },
  answer: { status: 'query' },
  progress: null,
  deep: null,
  warm: null,
  calls: []
};

globalThis.fetch = async function (input, init) {
  const options = init || {};
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = String(options.method || 'GET').toUpperCase();
  const qp = url.searchParams;
  const entry = method + ' ' +
    ['answer', 'progress', 'usergame', 'warm', 'deep'].filter(k => qp.get(k))
      .map(k => k + '=' + qp.get(k)).join(',');

  server.calls.push(entry || method);

  const json = body => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

  if (method === 'POST') return json(server.ask);
  if (qp.get('usergame') === '1') return json({ status: 'ok', game: '' });

  if (qp.get('warm') === '1') {
    return json(server.warm || { status: 'ok' });
  }

  if (qp.get('deep') === '1') {
    return json(server.deep || { status: 'none' });
  }

  if (qp.get('answer') === '1') {
    return json(server.answer);
  }

  if (qp.get('progress') === '1') {
    return json(server.progress || { status: 'none' });
  }

  return json({ status: 'ok' });
};

const skill = require(process.env.SKILL_MODULE || path.join(__dirname, '..', 'moon-skill-core.js'));

const results = [];

function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name +
    (ok || !detail ? '' : ' -> ' + detail));
}

let messageId = 0;
let state = null;

async function say(command) {
  messageId++;
  const event = {
    meta: { locale: 'ru-RU' },
    session: {
      new: messageId === 1,
      session_id: 'session-test-1',
      message_id: messageId,
      skill_id: 'skill-1',
      user: { user_id: 'user-1' },
      application: { application_id: 'app-1' },
      user_id: 'app-1'
    },
    request: {
      command: command,
      original_utterance: command,
      type: 'SimpleUtterance'
    },
    version: '1.0'
  };

  if (state) event.state = { session: state };

  const res = await skill.handler(event);
  state = res.session_state || state;
  return res.response.text;
}

async function main() {
  // 1. Ответ приходит сразу — без «ну что там».
  server.ask = {
    status: 'done',
    text: 'Найт-Сити был основан в мае 1994 года.',
    src: 'kb',
    conf: 0.9
  };

  const first = await say('когда основан найт сити');
  check('мгновенный ответ', /1994/.test(first), first);

  // 2. Долгий ответ — подсказка про оверлей один раз.
  server.ask = { status: 'query', qid: 123, cid: 'c-1', async: true };
  server.answer = { status: 'query' };
  server.progress = { status: 'processing', elapsed_s: 7 };

  const waiting = await say('кто такие альдекальдо');
  check('ожидание: просит «ну что там»',
    /ну что там/i.test(waiting), waiting);
  check('ожидание: упоминает оверлей',
    /оверле/i.test(waiting), waiting);

  // 3. «Ну что там» забирает готовый ответ.
  server.answer = {
    status: 'done',
    text: 'Альдекальдо — кочевой клан из пустошей.',
    src: 'kb',
    conf: 0.8
  };
  server.progress = { status: 'done', text: 'Альдекальдо — кочевой клан из пустошей.' };

  const got = await say('ну что там');
  check('забор ответа по «ну что там»', /кочевой клан/.test(got), got);

  // 4. Ответ ещё готовится — честный прогресс без повторной подсказки.
  server.ask = { status: 'query', qid: 456, cid: 'c-2', async: true };
  server.answer = { status: 'query' };
  server.progress = null;

  const waiting2 = await say('что такое ночноголос');
  check('ожидание: снова просит «ну что там»',
    /ну что там/i.test(waiting2), waiting2);

  server.progress = { status: 'processing', elapsed_s: 11 };
  const still = await say('ну что там');

  check('прогресс: показывает время',
    /прошло 11 секунд/i.test(still), still);
  check('прогресс: не повторяет подсказку про оверлей',
    !/оверле/i.test(still), still);
  check('ожидание: задача не потеряна',
    !!(state && (state.cid || state.qid)),
    JSON.stringify({ qid: state && state.qid, cid: state && state.cid }));

  // 5. progress сам отдаёт готовый ответ, даже если опрос не успел.
  server.answer = { status: 'query' };
  server.progress = {
    status: 'done',
    text: 'Ночноголос — это сражение 2023 года.',
    result_status: 'done'
  };

  const viaProgress = await say('ну что там');
  check('progress: ответ вместо ожидания',
    /сражение 2023/.test(viaProgress), viaProgress);

  // 6. Смена игры прогревает базу по новой игре.
  server.warm = {
    status: 'ok',
    game: 'Minecraft',
    warm: { status: 'ok', pages: 8, cached: false }
  };
  server.calls = [];

  const askGame = await say('сменить игру');
  check('смена игры: спрашивает название',
    /какую игру/i.test(askGame), askGame);

  const setGame = await say('майнкрафт');
  check('смена игры: приняла название',
    /майнкрафт/i.test(setGame), setGame);
  check('смена игры: прогрела базу знаний',
    /8/.test(setGame), setGame);
  check('смена игры: запрос прогрева отправлен',
    server.calls.some(c => /warm=1/.test(c)), server.calls.join(' | '));

  // 7. Два этапа: короткий ответ сразу, разбор — по слову «подробнее».
  server.ask = {
    status: 'done',
    stage: 'quick',
    final: false,
    deep_pending: true,
    qid: 789,
    cid: 'c-3',
    text: 'Джуди Альварес — техник из Найт-Сити.',
    src: 'kb'
  };
  server.answer = { status: 'query' };
  server.progress = null;
  server.deep = null;

  const quick = await say('кто такая джуди альварес');

  check('этапы: короткий ответ озвучен', /джуди альварес/i.test(quick), quick);
  check('этапы: предложен разбор', /подробнее/i.test(quick), quick);
  check('этапы: вопрос сохранён для разбора',
    !!(state && state.deepPending === true && state.qid === 789),
    JSON.stringify({ qid: state && state.qid, deep: state && state.deepPending }));

  // 8. Разбор ещё считается — не молчим и не повторяем короткий ответ.
  server.deep = {
    status: 'done',
    stage: 'quick',
    final: false,
    deep_pending: true,
    qid: 789,
    text: 'Джуди Альварес — техник из Найт-Сити.'
  };

  const deepWait = await say('подробнее');

  check('этапы: во время разбора просит подождать',
    /ещё готовится|ну что там/i.test(deepWait), deepWait);
  check('этапы: короткий ответ не повторяется',
    !/техник из Найт-Сити/i.test(deepWait), deepWait);

  // 9. Готовый разбор забирается по «подробнее».
  server.deep = {
    status: 'done',
    stage: 'deep',
    final: true,
    deep_pending: false,
    qid: 789,
    text: 'Джуди Альварес — техник и специалист по браиндансам, ' +
      'лидер Мокс. В сюжете она помогает Ви и предлагает роман.'
  };

  const deepDone = await say('подробнее');

  check('этапы: разбор озвучен', /браинданс|Мокс/i.test(deepDone), deepDone);
  check('этапы: после разбора вопрос закрыт',
    !state || (!state.qid && state.deepPending !== true),
    JSON.stringify({ qid: state && state.qid, deep: state && state.deepPending }));

  // 10. «Ну что там» после короткого ответа тоже забирает разбор.
  server.ask = {
    status: 'done', stage: 'quick', final: false, deep_pending: true,
    qid: 790, cid: 'c-4', text: 'Хорнет — защитница Халлоунеста.', src: 'kb'
  };
  server.deep = null;

  await say('кто такая хорнет');
  server.deep = {
    status: 'done', stage: 'deep', final: true, deep_pending: false,
    qid: 790, text: 'Хорнет — защитница Холлоунеста и дочь Короля-бога.'
  };

  const viaFollow = await say('ну что там');

  check('этапы: «ну что там» отдаёт разбор',
    /Холлоунест|Холлоу/i.test(viaFollow), viaFollow);

  // 11. «Подробнее», пока вопрос ещё в работе — не выдумываем отказ.
  server.ask = {
    status: 'done', stage: 'quick', final: false, deep_pending: true,
    qid: 791, cid: 'c-5', text: 'Смоук — торговец из Халлоунеста.', src: 'kb'
  };
  server.deep = null;

  await say('кто такой смоук');
  server.deep = { status: 'query', stage: 'deep', qid: 791 };

  const queued = await say('подробнее');

  check('этапы: разбор в очереди — просит подождать',
    /ещё готовится|ну что там/i.test(queued), queued);
  check('этапы: вопрос не закрыт, пока разбор идёт',
    !!(state && state.deepPending === true),
    JSON.stringify({ deep: state && state.deepPending }));

  // 12. «Подробнее» без вопроса — понятный отказ, а не новый поиск.
  // Состояние сбрасываем: проверяем именно случай «спрашивать нечего».
  server.deep = { status: 'none' };
  server.calls = [];
  state = null;

  const noQuestion = await say('подробнее');

  check('этапы: «подробнее» без вопроса',
    /сначала задай вопрос/i.test(noQuestion), noQuestion);
  check('этапы: без вопроса не ходит на сервер',
    !server.calls.some(c => /POST/.test(c)), server.calls.join(' | '));

  // 12. Распознавание просьбы о разборе.
  const deepWords = ['подробнее', 'а можно поглубже', 'разбор', 'расскажи подробнее',
    'детали', 'подробней'];

  check('этапы: просьбы о разборе распознаны',
    deepWords.every(w => skill._test.isDeepAsk(w)), deepWords.join(' | '));
  check('этапы: обычный вопрос не считается просьбой о разборе',
    !skill._test.isDeepAsk('кто такая джуди альварес') &&
      !skill._test.isDeepAsk('что такое ночноголос'),
    'ok');

  const failed = results.filter(r => !r.ok);

  console.log('\n' + (results.length - failed.length) + '/' +
    results.length + ' проверок пройдено');

  if (failed.length) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
