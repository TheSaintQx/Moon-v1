'use strict';

const crypto = require('crypto');

// Moon Skill v9.7-a-v3.8-moon-async
// Изменения:
// - асинхронная отправка вопросов через index.js;
// - ожидание появления задания в Object Storage по CID после HTTP 202;
// - токен берётся из уже существующей переменной MOON_TOKEN;
// - восстановление ответа по UID, даже если тестер не передал state;
// - сохранена универсальная работа со всеми играми.
// v9.7:
// - реплика Алисы используется целиком: 3,0 с на вопрос + опрос до конца бюджета;
// - более частый опрос (120 мс) и дешёвый ?progress=1 как второй шанс забрать ответ;
// - ожидание больше не сбрасывает задачу преждевременно;
// - подсказка про оверлей показывается один раз, а не в каждой реплике.

const CLOUD_URL = 'https://functions.yandexcloud.net/d4el6hpg7nh0cui52kd2';

// Токен берётся из переменной окружения MOON_TOKEN.
// Его значение должно совпадать с AUTH_TOKEN в настройках moon-vision.
const TOKEN = String(process.env.MOON_TOKEN || '').trim();

const TURN_BUDGET_MS    = 4300;
const SAFETY_MS         = 350;
const ASK_TIMEOUT_MS    = 3000;
const ANSWER_TIMEOUT_MS = 900;
const PROGRESS_TIMEOUT_MS = 700;
const POLL_STEP_MS      = 120;
// После HTTP 202 асинхронная функция может ещё не успеть записать CID в хранилище.
const ASYNC_CREATE_GRACE_MS = 60000;
const FOLLOWUP_TTL_MS   = 120000;
const FOLLOWUP_CEIL_MS  = 300000;
const VER               = '9.7-a-v3.8-moon-async';
const VOICE_MAX         = 400;

function isTokenConfigured() {
  return TOKEN.length >= 16;
}

const SHOW_WORDS = ['покаж', 'обвед', ' кто из ', ' где '];

function isShow(utter) {
  const s = ' ' + String(utter || '').toLowerCase() + ' ';
  return SHOW_WORDS.some(w => s.indexOf(w) !== -1);
}

function isFollowUp(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[!?,.]/g, '').replace(/\s+/g, ' ').trim();

  if (!s) return false;

  return /^(ну\s+)?(что|ч[е]|как)\s+(там|вышло|получилось|у\s+нас)$/.test(s) ||
    /^(результат|ответ|готово|есть\s+ответ|а\s+что\s+там|ну\s+что)$/.test(s);
}

// Распознавание установки игры.
const GAME_SET_RES = [
  /^(?:(?:я\s+)?игра(?:ю|ешь|ет|ем|ете|ут|ют)?\s+в|включи игру|запусти игру)\s+(.+)$/i,
  /^запусти лунного[,.!]?\s*(?:я\s+)?в\s+(.+)$/i,
  /^переключи(?:сь)?\s+на\s+(.+)$/i,
  /^я\s+в\s+(.{2,60})$/i,
  /^(?:я\s+)?(?:сейчас\s+|сегодня\s+)?игра(?:ю|ем)\s+(.+)$/i
];

const GAME_STOP_RE = /(?:^|\s)(порядке?|себе|курс[е]|шок[е]|отпуск[е]|настроени[ие]|движени[ие]|процесс[е]|форм[е]|ток[е]|восторг[е]|поиск[е]|очеред[и]|замешательств[е]|дел[е]|пут[и]|срок[е])/i;

function isGameSet(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е').trim();
  return GAME_SET_RES.some(re => re.test(s));
}

const GAME_FILLER_RE = /^(?:с\s+\S+\s+|со\s+\S+\s+|вдвоем\s+|вдвоём\s+|сейчас\s+|сегодня\s+|теперь\s+)+/i;
const GAME_LEAD_PREP_RE = /^(?:на|за|у|по|про|для|из|от|к|ко|до|без|о|об|при|не|с|со)(?:\s|$)/i;

function gameFrom(utter) {
  const s = String(utter || '').trim();

  for (let i = 0; i < GAME_SET_RES.length; i++) {
    const m = s.match(GAME_SET_RES[i]);
    if (!m) continue;

    let g = m[1].replace(/[.!,?]$/, '').trim();

    if (i === GAME_SET_RES.length - 1) {
      g = g.replace(GAME_FILLER_RE, '').replace(/^в\s+/i, '').trim();
      if (!g || GAME_LEAD_PREP_RE.test(g)) return '';
    }

    g = g.slice(0, 60);
    return GAME_STOP_RE.test(g) ? '' : g;
  }

  return '';
}

function isChangeGame(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[!?,.]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^алиса\s*/, '');

  return /^(сменить игру|поменять игру|давай сменим игру|давай поменяем игру|хочу сменить игру|начать другую игру|другая игра)$/.test(s);
}

function cleanGameCandidate(utter) {
  let g = String(utter || '').trim();
  if (!g) return '';

  const parsed = gameFrom(g);
  if (parsed) return parsed.slice(0, 60);

  g = g.replace(/^(?:игра\s+|в игру\s+|это\s+)/i, '').trim();
  g = g.replace(/^[«"'“”]+/, '').replace(/[»"'“”]+$/, '');
  g = g.replace(/[.!?,;:]+$/, '').trim();

  if (g.length < 2 || g.length > 60) return '';
  if (QUESTION_START_RE.test(g) || /[?]/.test(utter)) return '';
  if (/^(отмена|не знаю|не хочу|помощь|сменить игру|стоп|выход)$/i.test(g)) return '';
  return g;
}

function splitGameQuestion(utter) {
  const raw = String(utter || '').trim();
  if (!raw) return null;

  const questionLead = '(?:кто|что|как|где|сколько|какой|какая|какое|какие|каких|почему|зачем|когда|куда|откуда|чем|чей|можно|есть|дай|скажи|расскажи|найди|покажи|обведи)';
  const separators = new RegExp(
    '[.!?;]\\s+|,\\s+|\\s+(?=' + questionLead + '(?:\\s|[?!,.]|$))',
    'ig'
  );

  let match;
  while ((match = separators.exec(raw)) !== null) {
    const prefix = raw.slice(0, match.index).trim();
    const question = raw.slice(match.index + match[0].length).trim();
    if (!question || !isGameSet(prefix)) continue;

    const game = gameFrom(prefix);
    if (game && game.length >= 2) return { game, question };
  }

  return null;
}

function isHelp(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[!?,.]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^алиса,?\s*/, '');
  return /^(помощь|что ты умеешь|какие команды|как пользоваться|команды)$/.test(s);
}

function isExit(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[!?,.]/g, '').replace(/\s+/g, ' ').trim();
  return /^(хватит|стоп|выход|выйти|закончить|заверши(ть)?( навык)?|пока|до свидания|спасибо пока)$/.test(s);
}

function isGameInfo(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е');
  return /какая (сейчас )?игра|во что (мы )?играем|во что играешь|какая у нас игра/.test(s);
}

const QUESTION_START_RE = /^(что|как|где|кто|сколько|какой|какая|какое|какие|каких|почему|зачем|когда|куда|откуда|чем|чей|можно|есть|дай|скажи|расскажи|найди|покажи|обведи)(\s|$)/i;

function normGame(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

function isBareGameTitle(utter, currentGame) {
  const s = String(utter || '').trim().replace(/[.!]$/, '');
  if (!/^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 .:'-]{1,58}$/.test(s)) return false;
  if (!/\d/.test(s) || QUESTION_START_RE.test(s)) return false;
  if (currentGame && normGame(currentGame) === normGame(s)) return true;
  const parts = s.split(/\s+/);
  return parts.length >= 2 && parts.length <= 4;
}

function cleanVoice(text) {
  let t = String(text || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const sents = t.split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
  t = sents.slice(0, 3).join(' ');
  if (t.length <= VOICE_MAX) return t;
  const cut = t.slice(0, VOICE_MAX - 1);
  return cut.replace(/\s+\S*$/, '').trim() + '…';
}

async function cloudFetch(path, init, timeoutMs) {
  if (!isTokenConfigured()) {
    return { status: 0, body: { status: 'config_error' }, kind: 'config' };
  }

  try {
    const res = await fetch(CLOUD_URL + path, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    return { status: res.status, body, kind: res.status === 200 ? 'ok' : 'http' };
  } catch (e) {
    const kind = (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      ? 'timeout' : 'network';
    return { status: 0, body: null, kind };
  }
}

function makeCid(session, utter) {
  const sid = String((session && session.session_id) || '');
  const hasMessageId = session && session.message_id !== undefined && session.message_id !== null;
  const mid = hasMessageId ? String(session.message_id) : '';
  const nonce = sid && hasMessageId
    ? sid + ':' + mid
    : String(Date.now()) + ':' + String(Math.random());
  const digest = crypto.createHash('sha256').update(nonce + ':' + String(utter || '')).digest('hex');
  return 'c-' + digest.slice(0, 24);
}

async function ask(q, game, cid, supersede, timeoutMs, uid) {
  const payload = { q: String(q || '').slice(0, 200), cid: String(cid || '').slice(0, 64) };
  if (game) payload.game = String(game).slice(0, 60);
  if (uid) payload.uid = uid;
  if (supersede) payload.supersede = String(supersede).slice(0, 64);

  return await cloudFetch('?token=' + encodeURIComponent(TOKEN), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, Math.max(200, timeoutMs));
}

async function answer(qid, cid, timeoutMs, uid) {
  const p = '?token=' + encodeURIComponent(TOKEN) + '&answer=1' +
    (qid ? '&qid=' + encodeURIComponent(qid) : '') +
    (cid ? '&cid=' + encodeURIComponent(cid) : '') +
    (uid ? '&uid=' + encodeURIComponent(uid) : '');
  return await cloudFetch(p, { method: 'GET' },
    Math.max(150, Math.min(ANSWER_TIMEOUT_MS, timeoutMs || ANSWER_TIMEOUT_MS)));
}

// Лёгкий опрос состояния задачи: не запускает обработку на сервере.
async function progress(cid, uid, timeoutMs) {
  const p = '?token=' + encodeURIComponent(TOKEN) + '&progress=1' +
    (cid ? '&cid=' + encodeURIComponent(cid) : '') +
    (uid ? '&uid=' + encodeURIComponent(uid) : '');
  const r = await cloudFetch(p, { method: 'GET' },
    timeoutMs || PROGRESS_TIMEOUT_MS);
  return (r.kind === 'ok' && r.body && typeof r.body === 'object')
    ? r.body : null;
}

async function setGame(game, supersede, timeoutMs, uid) {
  const payload = { game: String(game).slice(0, 60) };
  if (uid) payload.uid = uid;
  if (supersede) payload.supersede = String(supersede).slice(0, 64);
  return await cloudFetch('?token=' + encodeURIComponent(TOKEN), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, Math.max(150, Math.min(1200, timeoutMs || 1200)));
}

async function fetchUserGame(uid, timeoutMs) {
  if (!uid) return '';
  const r = await cloudFetch(
    '?token=' + encodeURIComponent(TOKEN) + '&usergame=1&uid=' + encodeURIComponent(uid),
    { method: 'GET' }, timeoutMs || 800
  );
  return (r.kind === 'ok' && r.body && typeof r.body.game === 'string')
    ? r.body.game.slice(0, 60) : '';
}

function clearPending(s) {
  s.qid = 0;
  s.cid = '';
  s.followUpUntil = 0;
  s.followUpMax = 0;
  s.followUpFrom = 0;
  s.asyncAcceptedAt = 0;
}

function slideFollowUp(s) {
  if (!s.followUpMax || !s.followUpFrom) {
    s.followUpMax = Date.now() + FOLLOWUP_CEIL_MS;
    s.followUpFrom = Date.now();
  }
  s.followUpUntil = Math.min(Date.now() + FOLLOWUP_TTL_MS, s.followUpMax);
}

function pluralSec(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'секунд';
  if (b >= 2 && b <= 4) return 'секунды';
  return n === 1 ? 'секунда' : 'секунд';
}

// Ожидание: сначала честно показываем прогресс, а подсказку про оверлей — один раз.
function pendingText(s, elapsed) {
  const sec = Math.max(0, Math.round(Number(elapsed) || 0));
  const tail = s.hintShown
    ? 'Скажи «ну что там» ещё раз.'
    : 'Когда ответ будет готов, он появится в оверлее. Или скажи «ну что там».';
  s.hintShown = true;
  return (sec >= 3
    ? 'Ещё собираю ответ, прошло ' + sec + ' ' + pluralSec(sec) + '. '
    : 'Собираю ответ. ') + tail;
}

// При async 202 запись задания может появиться в Object Storage не мгновенно.
// В течение grace-периода ищем запрос только по CID; только после его появления
// переключаемся на qid. Это не позволяет принять временный status:none/expired
// за потерянную задачу.
async function pollAnswer(qid, cid, untilMs, uid, creationDeadlineMs) {
  const waitForCreationUntil = Number(creationDeadlineMs) || 0;
  let actualQid = (waitForCreationUntil && Date.now() < waitForCreationUntil)
    ? 0 : (qid || 0);
  let foundRequest = actualQid > 0;

  while (Date.now() < untilMs) {
    const remaining = untilMs - Date.now() - SAFETY_MS;
    if (remaining < 150) return null;

    const r = await answer(actualQid, cid, Math.min(ANSWER_TIMEOUT_MS, remaining), uid);
    const body = r.body || {};
    const status = String(body.status || '');

    if (body.qid && status !== 'none') {
      actualQid = body.qid;
      foundRequest = true;
    }

    if (status === 'done' || status === 'clarify') {
      return { text: String(body.text || ''), clarify: status === 'clarify', meta: body };
    }

    if (status === 'expired' || status === 'superseded' || status === 'cancelled') {
      if (!(status === 'expired' && waitForCreationUntil && !foundRequest &&
            Date.now() < waitForCreationUntil)) {
        return { expired: true };
      }
    } else if (status === 'none') {
      if (!(waitForCreationUntil && !foundRequest && Date.now() < waitForCreationUntil)) {
        return { none: true };
      }
    } else if (r.kind === 'config') {
      return { error: 'config' };
    } else if (r.kind === 'http' && r.status === 403) {
      return { error: 'auth' };
    } else if (r.kind === 'http' && status && status !== 'query' && status !== 'pending') {
      return { error: 'http', httpStatus: r.status, status: status };
    }

    if (Date.now() + POLL_STEP_MS > untilMs) return null;
    await new Promise(res => setTimeout(res, POLL_STEP_MS));
  }

  return null;
}

function loadState(req) {
  const r = req || {};
  const st = r.state || {};
  const candidates = [
    st.session, st.application, st.user,
    r.session_state, r.application_state, r.user_state_update
  ];
  let best = null;
  for (const c of candidates) {
    if (!c || typeof c !== 'object' || !Object.keys(c).length) continue;
    if (!best || (Number(c.ts) || 0) > (Number(best.ts) || 0)) best = c;
  }
  return best || {};
}

const UID_SALT = process.env.MOON_UID_SALT || 'moon:';

function makeUid(session) {
  const s = session || {};
  const raw = (s.user && s.user.user_id) ||
    (s.application && s.application.application_id) || s.user_id || '';
  if (!raw) return '';
  return 'u-' + crypto.createHash('sha256')
    .update(UID_SALT + String(raw)).digest('hex').slice(0, 24);
}

function resp(text, session, endSession, userState) {
  const out = {
    version: '1.0',
    session: session || {},
    response: {
      text: String(text || '').slice(0, 1024),
      tts: String(text || '').slice(0, 1024),
      end_session: !!endSession
    }
  };
  if (userState) {
    const snap = Object.assign({}, userState, { ts: Date.now() });
    out.session_state = snap;
    out.application_state = snap;
    out.user_state_update = snap;
  }
  return out;
}

module.exports.handler = async function (event) {
  const t0 = Date.now();
  let req = event;
  try {
    if (event && event.body) req = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (e) { req = event; }

  const session = (req && req.session) || {};
  const utter = String((req && req.request &&
    (req.request.command || req.request.original_utterance)) || '').trim();
  const origUtter = String((req && req.request && req.request.original_utterance) || utter).trim();
  const mergedGameQuestion = splitGameQuestion(origUtter) || splitGameQuestion(utter);
  const activeUtter = mergedGameQuestion ? mergedGameQuestion.question : utter;
  const user = loadState(req);
  const uid = makeUid(session);

  const uState = {
    game: String(user.game || '').slice(0, 60),
    qid: user.qid || 0,
    cid: String(user.cid || '').slice(0, 64),
    followUpUntil: user.followUpUntil || 0,
    followUpMax: user.followUpMax || 0,
    followUpFrom: user.followUpFrom || 0,
    asyncAcceptedAt: user.asyncAcceptedAt || 0,
    awaitingGame: user.awaitingGame === true,
    hintShown: user.hintShown === true
  };

  if (mergedGameQuestion && mergedGameQuestion.game) uState.game = mergedGameQuestion.game;
  const turnDeadline = t0 + TURN_BUDGET_MS;
  let finalRoute = 'unknown';
  const route = name => { finalRoute = name; };

  const reply = (text, endSession, status, meta) => {
    const v = cleanVoice(text);
    const m = meta || {};
    console.log(JSON.stringify({
      s: 'moon', v: VER, route: finalRoute, status: status || 'ok',
      ms: Date.now() - t0, end: !!endSession, hasGame: !!uState.game,
      hasQid: !!uState.qid, hasUid: !!uid, awaitingGame: !!uState.awaitingGame,
      unk: m.unk === true, src: m.src || 'none', frame_id: m.frame_id || null,
      conf: typeof m.conf === 'number' ? m.conf : null
    }));
    return resp(v, session, endSession, uState);
  };

  if (!uState.game && uid && ((session.new && !activeUtter) || isGameInfo(activeUtter))) {
    uState.game = await fetchUserGame(uid, 800);
  }

  if (session.new && !activeUtter) {
    route('start');
    return reply(
      uState.game
        ? 'Привет! Продолжаем ' + uState.game + ' — задавай вопросы, а по слову «покажи» обведу объект на экране.'
        : 'Привет! Я Лунный Ассистент: скажи, во что играешь, и задавай вопросы. По слову «покажи» обведу объект на экране.',
      false, 'ok'
    );
  }

  if (isExit(activeUtter)) {
    route('exit'); uState.awaitingGame = false;
    return reply('До встречи! Удачной игры.', true, 'ok');
  }

  if (isHelp(activeUtter)) {
    route('help');
    return reply(
      'Скажи, во что играешь, и задавай вопросы. «Покажи воина» — обведу объект на экране. «Ну что там» — забрать ответ, если я сказал «собираю». Чтобы сменить игру, скажи «Сменить игру».',
      false, 'ok'
    );
  }

  if (isChangeGame(utter) || isChangeGame(origUtter)) {
    route('change-game-start'); clearPending(uState); uState.awaitingGame = true;
    return reply('Хорошо, сменим игру. В какую игру играешь?', false, 'awaiting-game');
  }

  if (uState.awaitingGame) {
    const candidate = cleanGameCandidate(origUtter || activeUtter);
    if (!candidate) {
      route('change-game-invalid');
      return reply('Не расслышала название. Скажи название игры ещё раз.', false, 'awaiting-game');
    }

    route('change-game-save');
    const oldCid = uState.cid || (uState.qid ? String(uState.qid) : '');
    clearPending(uState); uState.awaitingGame = false; uState.game = candidate;
    const sg = await setGame(candidate, oldCid, turnDeadline - Date.now() - SAFETY_MS, uid);

    if (sg.status === 200) return reply('Принято, теперь игра: ' + candidate + '. Спрашивай!', false, 'ok');
    if (sg.kind === 'config') return reply('Запомнила игру «' + candidate + '» в навыке, но MOON_TOKEN не настроен. Проверь переменную MOON_TOKEN в настройках moon-skill.', false, 'config');
    if (sg.status === 403) return reply('Запомнила игру «' + candidate + '» в навыке, но сервер отклонил токен. Проверь MOON_TOKEN и AUTH_TOKEN.', false, 'auth-error');
    return reply('Записала у себя новую игру: ' + candidate + '. Но сервер не подтвердил сохранение. Если что-то пойдёт не так, назови игру ещё раз.', false, 'degraded');
  }

  if (isGameInfo(activeUtter)) {
    route('gameinfo');
    return reply(uState.game ? 'Игра: ' + uState.game + '.' : 'Игра пока не названа. Скажи, например, «я в Ведьмаке».', false, 'ok');
  }

  const doFollowUp = async () => {
    const hasLocal = !!(uState.followUpUntil || uState.qid || uState.cid);
    if (!hasLocal && !uid) {
      route('followup-none');
      return reply('Я пока ничего не собирала. Задай вопрос.', false, 'none');
    }

    const got = await pollAnswer(
      uState.qid || 0,
      uState.cid,
      turnDeadline - SAFETY_MS,
      uid,
      uState.asyncAcceptedAt
        ? uState.asyncAcceptedAt + ASYNC_CREATE_GRACE_MS
        : 0
    );

    if (got && got.text) {
      route(got.clarify ? 'followup-clarify' : 'followup-done');
      clearPending(uState);
      return reply(got.text, false, got.clarify ? 'clarify' : 'done', got.meta);
    }

    // Второй шанс: ?progress=1 читает состояние задачи и не запускает обработку.
    // Он ловит ответ, который появился между опросами, и честно показывает прогресс.
    if (!(got && (got.error === 'config' || got.error === 'auth'))) {
      const pr = await progress(uState.cid, uid,
        Math.min(PROGRESS_TIMEOUT_MS, turnDeadline - Date.now() - 80));

      if (pr && pr.status === 'done' && pr.text) {
        const clar = pr.result_status === 'clarify';
        route(clar ? 'followup-clarify' : 'followup-done');
        clearPending(uState);
        return reply(pr.text, false, clar ? 'clarify' : 'done', pr);
      }

      if (pr && (pr.status === 'processing' || pr.status === 'pending')) {
        route('followup-waiting'); slideFollowUp(uState);
        return reply(pendingText(uState, pr.elapsed_s), false, 'pending');
      }
    }

    if (got && got.expired) {
      route('followup-expired'); clearPending(uState);
      return reply('Срок хранения этого ответа истёк. Задай вопрос ещё раз.', false, 'expired');
    }
    if (got && got.none) {
      route('followup-none'); clearPending(uState);
      return reply(hasLocal ? 'Не нашла запрос, который нужно проверить. Задай вопрос ещё раз.' : 'Не нашла незавершённый вопрос. Задай его ещё раз.', false, 'none');
    }
    if (got && got.error === 'config') {
      route('followup-config');
      return reply('Сервис ответа не настроен. Проверь переменную MOON_TOKEN в настройках moon-skill.', false, 'config');
    }
    if (got && got.error === 'auth') {
      route('followup-auth');
      return reply('Moon-vision отклонил запрос. Требуется проверить переменные MOON_TOKEN и AUTH_TOKEN.', false, 'auth-error');
    }
    if (got && got.error) {
      route('followup-http');
      return reply('Moon-vision ответил ошибкой. Попробуй повторить вопрос.', false, 'http-error');
    }

    route('followup-pending'); slideFollowUp(uState);
    return reply(pendingText(uState, 0), false, 'pending');
  };

  if (isFollowUp(activeUtter)) return await doFollowUp();

  const words = activeUtter.split(/\s+/).filter(Boolean);
  const pendAlive = !!uState.qid || Date.now() < uState.followUpUntil;
  if (pendAlive && words.length <= 3 && !isShow(activeUtter) &&
      !isGameSet(activeUtter) && !isBareGameTitle(activeUtter, uState.game)) {
    route('followup-short');
    return await doFollowUp();
  }

  const gameSetByCommand = isGameSet(utter);
  const gameSetByOriginal = isGameSet(origUtter);
  const bareByCommand = isBareGameTitle(utter, uState.game);
  const bareByOriginal = isBareGameTitle(origUtter, uState.game);

  if (!mergedGameQuestion && (gameSetByCommand || gameSetByOriginal || bareByCommand || bareByOriginal) &&
      !isShow(utter) && !isShow(origUtter)) {
    const g = (gameSetByOriginal && gameFrom(origUtter)) ||
      (gameSetByCommand && gameFrom(utter)) ||
      (bareByOriginal ? origUtter : utter).trim().replace(/[.!]$/, '').slice(0, 60);

    if (g) {
      route('setgame');
      const oldCid = uState.cid || (uState.qid ? String(uState.qid) : '');
      clearPending(uState); uState.game = g;
      const sg = await setGame(g, oldCid, turnDeadline - Date.now() - SAFETY_MS, uid);

      if (sg.status === 200) return reply('Принято, игра: ' + g + '. Спрашивай!', false, 'ok');
      if (sg.kind === 'config') return reply('Запомнила игру «' + g + '» в навыке, но MOON_TOKEN не настроен. Проверь переменную MOON_TOKEN в настройках moon-skill.', false, 'config');
      if (sg.status === 403) return reply('Запомнила игру «' + g + '» в навыке, но сервер отклонил запрос. Проверь MOON_TOKEN и AUTH_TOKEN.', false, 'auth-error');
      return reply('Записала у себя: ' + g + '. Но бэкенд не подтвердил сохранение — если что-то пойдёт не так, назови игру ещё раз.', false, 'degraded');
    }
  }

  const meaningful = words.length >= 2 || isShow(activeUtter);
  if (!meaningful) {
    route('short');
    return reply('Скажи вопрос целиком или скажи «ну что там».', false, 'short');
  }

  const oldCid = uState.cid || (uState.qid ? String(uState.qid) : '');
  const cid = makeCid(session, activeUtter);
  clearPending(uState);
  uState.cid = cid;

  const r = await ask(
    activeUtter,
    uState.game,
    cid,
    oldCid,
    Math.min(ASK_TIMEOUT_MS, turnDeadline - Date.now() - SAFETY_MS),
    uid
  );

  if (r.body && (r.body.status === 'done' || r.body.status === 'clarify')) {
    route(r.body.status === 'clarify' ? 'ask-clarify' : 'ask-done');
    clearPending(uState);
    const t = String(r.body.text || '');
    return reply(t ? t : 'Честно: пока не знаю. Спроси иначе.', false,
      r.body.status === 'clarify' ? 'clarify' : (t ? 'done' : 'done-empty'), r.body);
  }

  if (r.body && (r.body.status === 'superseded' || r.body.status === 'cancelled' || r.body.status === 'expired')) {
    route('ask-terminal'); clearPending(uState);
    return reply('Запрос завершён до получения ответа. Задай вопрос ещё раз.', false, r.body.status);
  }

  if (r.body && r.body.status === 'query' && r.body.qid) {
    const asyncAccepted = r.body.async === true;
    uState.qid = r.body.qid;
    uState.asyncAcceptedAt = asyncAccepted ? Date.now() : 0;

    const got = await pollAnswer(
      asyncAccepted ? 0 : r.body.qid,
      cid,
      turnDeadline - SAFETY_MS,
      uid,
      asyncAccepted ? uState.asyncAcceptedAt + ASYNC_CREATE_GRACE_MS : 0
    );

    if (got && got.text) {
      route(got.clarify ? 'poll-clarify' : 'poll-done');
      clearPending(uState);
      return reply(got.text, false, got.clarify ? 'clarify' : 'done', got.meta);
    }
    if (got && got.expired) {
      route('poll-expired'); clearPending(uState);
      return reply('Ответ не успел собраться или запрос был заменён. Спроси ещё раз.', false, 'expired');
    }

    route('poll-filler'); slideFollowUp(uState);
    return reply(pendingText(uState, 0), false, 'pending');
  }

  if (r.kind === 'config') {
    route('ask-config');
    return reply('Не настроен токен доступа. Проверь переменную MOON_TOKEN в настройках moon-skill и AUTH_TOKEN в настройках moon-vision.', false, 'config');
  }
  if (r.kind === 'http' && r.status === 403) {
    route('ask-auth-error');
    return reply('Сервер отклонил токен доступа. Проверь, что MOON_TOKEN совпадает с AUTH_TOKEN в настройках moon-vision.', false, 'auth-error');
  }
  if (r.kind === 'http' && r.body && r.body.status === 'cid_conflict') {
    route('ask-cid-conflict'); slideFollowUp(uState);
    return reply('Этот вопрос уже собирается. Через несколько секунд скажи «ну что там».', false, 'cid-conflict');
  }
  if (r.kind === 'http' && r.body && r.body.status === 'superseded') {
    route('ask-superseded'); slideFollowUp(uState);
    return reply('Этот вопрос уже заменён новым. Через несколько секунд скажи «ну что там».', false, 'superseded');
  }
  if (r.kind === 'http' && r.body && r.body.status === 'bad_request') {
    route('ask-bad-request');
    return reply('Скажи вопрос целиком, я не поняла.', false, 'bad-request');
  }
  if (r.kind === 'timeout') {
    route('ask-timeout-filler'); slideFollowUp(uState);
    return reply(pendingText(uState, 0), false, 'pending');
  }
  if (r.kind === 'ok') {
    route('ask-protocol'); slideFollowUp(uState);
    return reply(pendingText(uState, 0), false, 'protocol');
  }

  route('ask-network');
  return reply('Связь с сервером подвела. Скажи вопрос ещё раз.', false, 'network');
};

module.exports._test = {
  isGameSet,
  gameFrom,
  splitGameQuestion,
  makeUid,
  loadState,
  isBareGameTitle,
  normGame,
  isChangeGame,
  cleanGameCandidate,
  isTokenConfigured,
  pollAnswer
};
