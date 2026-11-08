'use strict';

// Проверка базы знаний: быстрый и полный поиск, прогрев, разбор статей,
// выбор нужного раздела, перевод запроса, универсальное обнаружение вики,
// актуальность и разделение баз разных игр.
//
// Всё локально: Object Storage и вики подменены (tests/fake-s3.js,
// tests/fake-wiki.js), внешняя сеть запрещена.

process.env.KB_TOKEN = 'test-kb-token-0123456789';
process.env.KB_BUCKET = 'moon-assistant';
process.env.ACCESS_KEY_ID = 'test-key-id';
process.env.SECRET_ACCESS_KEY = 'test-secret';
process.env.S3_REGION = 'ru-central1';
process.env.KB_ALLOWED_WIKI_HOSTS = 'wiki.test';

const path = require('path');
const s3 = require('./fake-s3');
const { createWiki } = require('./fake-wiki');

s3.install();

const kb = require(process.env.KB_MODULE || path.join(__dirname, '..', 'moon-knowledge-index.js'));
const t = kb._test;

const CP = 'cyberpunk-2077';
const CP_ROOT = 'kb/games/' + CP;
const HK = 'hollow-knight';
const HK_ROOT = 'kb/games/' + HK;

const CP_EXTRACT =
  'Найт-Сити — город будущего в Калифорнии. ' +
  'Найт-Сити был основан в мае 1994 года усилиями пяти корпораций. ' +
  'Инициатором создания стал Ричард Найт.';

// ---------- вики Cyberpunk 2077 (русская) ----------
const cyberpunk = createWiki({
  host: 'cyberpunk.fandom.com',
  sitename: 'Cyberpunk Wiki',
  lang: 'ru',
  pages: [
    {
      pageid: 101,
      title: 'Найт-Сити',
      text: CP_EXTRACT + '\n\nРайоны\nУотсон, Уэстбрук, Хейвуд, Санто-Доминго.',
      categories: ['Города']
    },
    {
      pageid: 201,
      title: 'Персонажи',
      text: 'Ви — главный герой. Джонни Сильверхенд — энграмма в его голове. ' +
        'Джеки Уэллс — друг Ви и напарник. Джуди Альварес — техник из банды Моксы.',
      categories: ['Персонажи']
    },
    {
      pageid: 202,
      title: 'Локации',
      text: 'Найт-Сити — город в Калифорнии, разделённый на районы. ' +
        'Пустоши окружают город и принадлежат кочевникам.',
      categories: ['Локации']
    },
    {
      pageid: 203,
      title: 'Джонни Сильверхенд',
      text: 'Джонни Сильверхенд — рокер и энграмма, застрявшая в голове Ви.\n\n' +
        'Биография\nДжонни родился в 1988 году, служил в армии, затем основал группу Samurai.\n\n' +
        'Способности\nВ бою использует револьвер и кибернетическую руку.',
      categories: ['Персонажи']
    },
    {
      pageid: 204,
      title: 'Джеки Уэллс',
      text: 'Джеки Уэллс — напарник Ви, погибает в начале истории.\n\n' +
        'Биография\nДжеки вырос в Хейвуде и мечтал стать легендой Найт-Сити.',
      categories: ['Персонажи']
    },
    {
      pageid: 205,
      title: 'Джуди Альварес',
      text: 'Джуди Альварес — техник из банды Моксы, занимается монтажом виртуалок ' +
        'и редактированием воспоминаний.\n\n' +
        'Биография\nДжуди родилась в 2049 году в Лагуна-Бенд и выросла в семье Хиральдо. ' +
        'В 2077 году она работает в мастерской «Коллектив Лиззи» и помогает Ви.\n\n' +
        'Способности\nДжуди отлично разбирается в виртуальной реальности и взломе.',
      categories: ['Персонажи']
    },
    {
      pageid: 206,
      title: 'Оружие',
      text: 'Оружие в игре делится на силовое, техническое и умное.\n\n' +
        'Характеристики\nСиловое оружие стреляет обычными пулями и рикошетит.',
      categories: ['Оружие']
    },
    {
      pageid: 207,
      title: 'Игровой процесс',
      text: 'Игровой процесс построен на прокачке пяти характеристик и навыков.\n\n' +
        'Прокачка\nЗа уровни дают очки атрибутов и перки.',
      categories: ['Механики']
    },
    {
      pageid: 208,
      title: 'Фракции',
      text: 'В Найт-Сити действуют корпорации, банды и кочевники.\n\n' +
        'Список\nАрасака, Милитех, Моксы, Альдекальдо.',
      categories: ['Фракции']
    },
    {
      pageid: 209,
      title: 'Квесты',
      text: 'Квесты делятся на сюжетные и побочные.\n\n' +
        'Сюжет\nОсновная линия связана с чипом и Джонни Сильверхендом.',
      categories: ['Квесты']
    },
    {
      pageid: 210,
      title: 'Предметы',
      text: 'Предметы включают аптечки, гранаты и расходники.\n\n' +
        'Применение\nАптечка восстанавливает здоровье.',
      categories: ['Предметы']
    },
    {
      pageid: 211,
      title: 'Транспорт',
      text: 'Транспорт в игре — машины и мотоциклы.\n\n' +
        'Виды\nКвадры, тайгеркло, мотоциклы.',
      categories: ['Транспорт']
    },
    {
      pageid: 212,
      title: 'Секреты',
      text: 'В игре есть секретные квартиры и пасхалки.\n\n' +
        'Секреты\nНа крыше можно найти тайник.',
      categories: ['Секреты']
    },
    {
      pageid: 213,
      title: 'Концовки',
      text: 'Концовки зависят от решений игрока.\n\n' +
        'Варианты\nУйти из города, подписать контракт или стать легендой.',
      categories: ['Сюжет']
    },
    {
      pageid: 214,
      title: 'Навыки',
      text: 'Навыки открываются за перки.\n\n' +
        'Прокачка\nВзлом и скрытность полезны в начале.',
      categories: ['Механики']
    }
  ]
});

// ---------- вики Hollow Knight (английская) ----------
const hollow = createWiki({
  host: 'hollowknight.fandom.com',
  sitename: 'Hollow Knight Wiki',
  lang: 'en',
  pages: [
    {
      pageid: 301,
      title: 'Hollow Knight',
      text: 'Hollow Knight is a metroidvania game set in Hallownest.\n\n' +
        'Gameplay\nThe player explores Hallownest and fights bugs.',
      categories: ['Games']
    },
    {
      pageid: 302,
      title: 'Characters',
      text: 'The Knight is the protagonist. Hornet is a recurring rival. ' +
        'The Pale King rules Hallownest.',
      categories: ['Characters']
    },
    {
      pageid: 303,
      title: 'Hornet',
      text: 'Hornet is a protector of Hallownest and a recurring boss.\n\n' +
        'Biography\nHornet is the daughter of the Pale King and Herrah.',
      categories: ['Characters']
    },
    {
      pageid: 304,
      title: 'Hallownest',
      text: 'Hallownest is the underground kingdom where the game takes place.\n\n' +
        'Locations\nDirtmouth, Greenpath, City of Tears.',
      categories: ['Locations']
    },
    {
      pageid: 305,
      title: 'Nail',
      text: 'The Nail is the main weapon of the Knight.\n\n' +
        'Stats\nThe Nail can be upgraded by the Nailsmith.',
      categories: ['Weapons']
    },
    {
      pageid: 306,
      title: 'Charms',
      text: 'Charms modify the Knight abilities.\n\n' +
        'Gameplay\nCharms are equipped at benches.',
      categories: ['Items']
    },
    {
      pageid: 307,
      title: 'Endings',
      text: 'There are several endings depending on progress.\n\n' +
        'Plot\nThe endings differ by the fate of the Hollow Knight.',
      categories: ['Plot']
    },
    {
      pageid: 308,
      title: 'Factions',
      text: 'Several factions live in Hallownest.\n\n' +
        'Factions\nThe Mantis Tribe and the Bees.',
      categories: ['Factions']
    },
    {
      pageid: 309,
      title: 'Quests',
      text: 'Quests are given by NPCs across Hallownest.\n\n' +
        'Quests\nDeliver the flower and rescue the grubs.',
      categories: ['Quests']
    },
    {
      pageid: 310,
      title: 'Items',
      text: 'Items include relics and geo.\n\n' +
        'Items\nRelics can be sold to Lemm.',
      categories: ['Items']
    },
    {
      pageid: 311,
      title: 'Secrets',
      text: 'Secrets are hidden behind breakable walls.\n\n' +
        'Secrets\nMany secrets hide grubs.',
      categories: ['Secrets']
    }
  ]
});

const wikiCalls = [];

s3.mount('cyberpunk.fandom.com', (url, init) => {
  wikiCalls.push({
    host: 'cyberpunk',
    search: url.searchParams.get('gsrsearch') || url.searchParams.get('srsearch') || ''
  });
  return cyberpunk.handle(url, init);
});

s3.mount('hollowknight.fandom.com', (url, init) => {
  wikiCalls.push({
    host: 'hollow',
    search: url.searchParams.get('gsrsearch') || url.searchParams.get('srsearch') || ''
  });
  return hollow.handle(url, init);
});

// Перевод: движок ходит в публичный переводчик. Здесь он подменён.
const translateCalls = [];

s3.mount('translate.googleapis.com', (url) => {
  const q = String(url.searchParams.get('q') || '');
  translateCalls.push(q);

  const dictionary = {
    'кто такая джуди альварес': 'who is Judy Alvarez',
    'биография джуди альварес': 'Judy Alvarez biography',
    'кто такая хорнет': 'who is Hornet',
    'какие способности у джонни сильверхенда': 'Johnny Silverhand abilities',
    'когда основан найт сити': 'when was Night City founded'
  };

  const out = dictionary[q.toLowerCase()] || q;

  return {
    status: 200,
    body: [[[out, q, null, null, 1]]]
  };
});

const results = [];

function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name +
    (ok || !detail ? '' : ' -> ' + detail));
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

async function call(body) {
  const res = await kb.handler(event(body));
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function search(extra) {
  return await call(Object.assign({
    action: 'search',
    game: 'Cyberpunk 2077',
    query: 'когда основан найт сити'
  }, extra));
}

// ---------- подготовка состояния бакета ----------

function seedCyberpunk(extra) {
  const o = extra || {};

  s3.reset();
  wikiCalls.length = 0;
  translateCalls.length = 0;

  s3.put(CP_ROOT + '/manifest.json', {
    game: 'Cyberpunk 2077',
    gameId: CP,
    status: o.status || 'complete',
    complete: o.complete === undefined ? true : o.complete,
    pageCount: 1,
    lastWarmAt: o.lastWarmAt || null,
    warmStatus: o.warmStatus || 'none',
    warmPages: o.warmPages || 0,
    warmSections: o.warmSections || {},
    source: {
      siteName: 'Cyberpunk Wiki',
      language: 'ru',
      api: 'https://cyberpunk.fandom.com/api.php'
    },
    createdAt: '2026-01-01T00:00:00.000Z'
  });

  s3.put(CP_ROOT + '/index.json', {
    items: [{
      pageId: 101,
      title: 'Найт-Сити',
      url: 'https://cyberpunk.fandom.com/wiki/Night_City',
      revisionId: 1,
      categories: ['Города'],
      lead: CP_EXTRACT.slice(0, 300),
      tail: CP_EXTRACT.slice(-200),
      tokens: [
        'найт', 'сити', 'город', 'основан', 'май', 'мае',
        '1994', 'корпорац', 'калифорн', 'район'
      ]
    }]
  });

  s3.put(CP_ROOT + '/pages/101.json', {
    pageId: 101,
    title: 'Найт-Сити',
    url: 'https://cyberpunk.fandom.com/wiki/Night_City',
    revisionId: 1,
    categories: ['Города'],
    extract: CP_EXTRACT,
    contentLength: CP_EXTRACT.length,
    contentSource: 'stored'
  });
}

async function main() {
  // =====================================================================
  // 1. Быстрый и полный режимы
  // =====================================================================
  seedCyberpunk();

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
  check('fast: ни одного запроса к вики',
    wikiCalls.length === 0, wikiCalls.map(c => c.search).join(' | '));

  const before = s3.stats().puts;
  const fast2 = await search({ fast: true });

  check('fast: повтор из кэша', fast2.body.cached === true,
    String(fast2.body.cached));
  check('fast: кэш не пишет в S3', s3.stats().puts === before,
    before + ' -> ' + s3.stats().puts);

  seedCyberpunk();

  const full = await search({});
  check('полный режим: статус ok', full.body.status === 'ok',
    full.body.status);
  check('полный режим: сильный локальный ответ без вики',
    wikiCalls.length === 0 &&
    full.body.search && full.body.search.mode === 'local',
    'wiki=' + wikiCalls.length + ' mode=' +
      (full.body.search && full.body.search.mode));

  const weak = await search({ query: 'какой климат в калифорнийском мегаполисе' });
  check('полный режим: слабая выдача идёт в вики', wikiCalls.length > 0,
    'wiki=' + wikiCalls.length);
  check('полный режим: режим local+wiki',
    weak.body.search && weak.body.search.mode === 'local+wiki',
    JSON.stringify(weak.body.search && weak.body.search.mode));

  // =====================================================================
  // 2. Намерение и сравнение (юнит-уровень)
  // =====================================================================
  check('намерение: кто главные герои',
    t.detectIntent('кто главные герои игры').name === 'characters');
  check('намерение: что это за персонаж',
    t.detectIntent('что это за персонаж').name === 'characters');
  check('намерение: что это за локация',
    t.detectIntent('что это за локация').name === 'locations');
  check('намерение: обычный факт без намерения',
    t.detectIntent('когда основан найт сити').name === 'general');

  const cmp = t.splitComparison('что лучше — меч или топор');
  check('сравнение: две сущности',
    cmp && cmp.entities.join('|') === 'меч|топор', JSON.stringify(cmp));
  check('сравнение: не срабатывает без маркера выбора',
    t.splitComparison('где найти меч или топор') === null);
  check('обзорные термины на языке вики',
    t.intentQueryTerms('characters', 'ru')[0] === 'персонажи' &&
    t.intentQueryTerms('characters', 'en')[0] === 'characters',
    JSON.stringify(t.intentQueryTerms('characters', 'ru')));

  // =====================================================================
  // 3. Прогрев базы
  // =====================================================================
  const plan = t.warmPlan('Ведьмак 3', 'ru');

  check('тёплая база: план покрывает обзорные разделы',
    plan[0].section === 'main' &&
    plan.some(x => x.section === 'characters') &&
    plan.some(x => x.section === 'locations') &&
    plan.some(x => x.section === 'mechanics'),
    JSON.stringify(plan.map(x => x.section)));

  check('тёплая база: план покрывает основные игровые категории',
    ['world', 'characters', 'locations', 'items', 'mechanics', 'skills',
      'quests', 'factions', 'story'].every(s => plan.some(x => x.section === s)),
    JSON.stringify(plan.map(x => x.section)));

  check('жанр: определяется по тексту статьи',
    t.detectGenre('Прокачка уровней, класс персонажа, квесты и инвентарь') === 'rpg',
    t.detectGenre('Прокачка уровней, класс персонажа, квесты и инвентарь'));

  seedCyberpunk({ status: 'indexing', complete: false });

  const warm = await call({ action: 'warm', game: 'Cyberpunk 2077' });
  const warmBody = warm.body;

  check('тёплая база: статус ok', warmBody.status === 'ok',
    JSON.stringify({ status: warmBody.status, pages: warmBody.pages }));
  check('тёплая база: готовность подтверждена',
    warmBody.ready === true, JSON.stringify(warmBody.ready));
  check('тёплая база: обзорная статья по персонажам загружена',
    Array.isArray(warmBody.sections && warmBody.sections.characters) &&
    warmBody.sections.characters.includes(201),
    JSON.stringify(warmBody.sections));
  check('тёплая база: итог сохранён в S3',
    !!s3.get(CP_ROOT + '/warm.json'));
  check('тёплая база: страница сохранена в индекс',
    (s3.get(CP_ROOT + '/index.json').items || []).some(x => x.pageId === 201));
  check('тёплая база: готовность записана в manifest',
    (s3.get(CP_ROOT + '/manifest.json') || {}).warmStatus === 'ok',
    JSON.stringify((s3.get(CP_ROOT + '/manifest.json') || {}).warmStatus));

  const warmAgain = await call({ action: 'warm', game: 'Cyberpunk 2077' });

  check('тёплая база: повтор без перезагрузки',
    warmAgain.body.cached === true, JSON.stringify(warmAgain.body.cached));

  const warmIndex = s3.get(CP_ROOT + '/index.json');
  check('тёплая база: индекс не теряет уже собранные страницы',
    (warmIndex.items || []).some(x => x.pageId === 101) &&
    (warmIndex.items || []).some(x => x.pageId === 201),
    JSON.stringify((warmIndex.items || []).map(x => x.pageId)));

  // Замок: параллельный прогрев (выбор игры + первый вопрос) не дублируется.
  s3.put(CP_ROOT + '/warm-lock.json', { at: Date.now() });

  const busy = await call({ action: 'warm', game: 'Cyberpunk 2077', refresh: true });

  check('тёплая база: параллельный прогрев не дублируется',
    busy.body.status === 'busy', busy.body.status);

  s3.put(CP_ROOT + '/warm-lock.json', { at: 0 });

  const refreshed = await call({ action: 'warm', game: 'Cyberpunk 2077', refresh: true });

  check('тёплая база: refresh перечитывает статьи',
    refreshed.body.cached === false && refreshed.body.status === 'ok',
    JSON.stringify({ status: refreshed.body.status, cached: refreshed.body.cached }));
  check('тёплая база: замок снят после прогрева',
    (s3.get(CP_ROOT + '/warm-lock.json') || {}).at === 0,
    JSON.stringify(s3.get(CP_ROOT + '/warm-lock.json')));

  // Маленькая вика: статей меньше минимума — база честно «частичная».
  s3.reset();

  const tiny = createWiki({
    host: 'tiny.fandom.com',
    sitename: 'Tiny Wiki',
    lang: 'ru',
    pages: [{
      pageid: 401,
      title: 'Крошка',
      text: 'Tiny Game — маленькая игра про крошку. Крошка — герой этой игры.'
    }]
  });

  s3.mount('tiny.fandom.com', (url, init) => tiny.handle(url, init));
  s3.put('kb/games/tiny-game/manifest.json', {
    game: 'Tiny Game',
    gameId: 'tiny-game',
    status: 'registered',
    complete: false,
    pageCount: 0,
    source: {
      siteName: 'Tiny Wiki',
      language: 'ru',
      api: 'https://tiny.fandom.com/api.php'
    }
  });
  s3.put('kb/games/tiny-game/index.json', { items: [] });

  const tinyWarm = await call({ action: 'warm', game: 'Tiny Game' });

  check('тёплая база: мало статей — статус partial, а не ok',
    tinyWarm.body.status === 'partial' && tinyWarm.body.ready === false,
    JSON.stringify({ status: tinyWarm.body.status, ready: tinyWarm.body.ready }));

  // =====================================================================
  // 4. Поиск: намерение, сравнение, готовность в ответе
  // =====================================================================
  seedCyberpunk({ status: 'indexing', complete: false });
  await call({ action: 'warm', game: 'Cyberpunk 2077' });

  const chars = await search({ query: 'кто главные герои игры', limit: 3 });

  check('намерение в ответе поиска',
    chars.body.intent && chars.body.intent.name === 'characters',
    JSON.stringify(chars.body.intent));
  check('обзорная статья попала в выдачу без совпадения слов',
    (chars.body.results || []).some(r => r.title === 'Персонажи'),
    (chars.body.results || []).map(r => r.title).join(' | '));
  check('выдержка про героев содержит имена',
    (chars.body.results || []).some(r => /Джонни|Джеки/.test(r.evidence)),
    String(((chars.body.results || [])[0] || {}).evidence || '').slice(0, 100));

  const compare = await search({ query: 'кто лучше джонни или джеки', limit: 4 });

  check('сравнение: две сущности в ответе',
    compare.body.comparison &&
    compare.body.comparison.entities.join('|') === 'джонни|джеки',
    JSON.stringify(compare.body.comparison));
  check('сравнение: выдача содержит обе стороны',
    (compare.body.results || []).some(r => r.entity === 'джонни') &&
    (compare.body.results || []).some(r => r.entity === 'джеки'),
    JSON.stringify((compare.body.results || []).map(r => r.entity)));

  check('готовность базы в ответе поиска',
    chars.body.database && chars.body.database.warmReady === true,
    JSON.stringify(chars.body.database));
  check('прогрев в ответе поиска — объект, а не null',
    chars.body.warm && typeof chars.body.warm === 'object' &&
    typeof chars.body.warm.ready === 'boolean',
    JSON.stringify(chars.body.warm));

  // =====================================================================
  // 5. Разбор статьи и выбор доказательства (кейс Джуди)
  // =====================================================================
  const judyPage = cyberpunk.byTitle('Джуди Альварес');
  const judyRecord = t.makePageRecord({
    pageid: judyPage.pageid,
    title: judyPage.title,
    extract: judyPage.text
  }, { source: { api: 'https://cyberpunk.fandom.com/api.php' } });

  const judyQuery = 'кто такая джуди альварес';
  const judy = t.bestEvidenceChunk(judyRecord, t.searchTokens(judyQuery), judyQuery);

  check('Джуди: выдержка из биографии, а не из конца статьи',
    judy.group === 'biography' && /родилась/.test(judy.evidence),
    JSON.stringify({ group: judy.group, text: judy.evidence.slice(0, 80) }));

  // Старые данные: прежний парсер превратил межъязыковые ссылки в текст.
  const oldTail = '\n\n' + Array.from({ length: 30 }, (_, i) =>
    'en Judy Alvarez ' + i + ' de Judy Alvarez fr Judy Alvarez pl Judy Alvarez').join(' ');
  const legacy = {
    pageId: 1,
    title: 'Джуди Альварес',
    extract: judyPage.text + oldTail,
    chunks: []
  };
  const legacyPick = t.bestEvidenceChunk(legacy, t.searchTokens(judyQuery), judyQuery);

  check('Джуди: старые данные — список языковых ссылок не побеждает',
    /родилась/.test(legacyPick.evidence) &&
    !/de Judy Alvarez/.test(legacyPick.evidence),
    JSON.stringify(legacyPick.evidence.slice(0, 100)));

  const wikitext =
    "{{Инфобокс|имя=Джуди|образ=judy.png}}\n'''Джуди Альварес''' — персонаж игры [[Cyberpunk 2077]].\n\n" +
    '== Биография ==\nДжуди родилась в 2049 году в Лагуна-Бенд.\n\n' +
    '== Примечания ==\n{{примечания}}\n\n' +
    '== Ссылки ==\n* [https://example.com Официальный сайт]\n\n' +
    '[[en:Judy Alvarez]][[de:Judy Alvarez]][[fr:Judy Alvarez]]';

  const parsed = t.makePageRecord({
    pageid: 9,
    title: 'Джуди Альварес',
    revisions: [{ revid: 7, slots: { main: { content: wikitext } } }]
  }, { source: { api: 'https://cyberpunk.fandom.com/api.php' } });

  check('парсер: межъязыковые ссылки удалены',
    !/Judy Alvarez/.test(parsed.extract.replace(/Джуди Альварес/g, '')),
    JSON.stringify(parsed.extract.slice(-80)));
  check('парсер: служебные разделы удалены',
    !/Примечания|Ссылки/.test(parsed.extract),
    JSON.stringify(parsed.extract));
  check('парсер: инфобокс не съел текст',
    /персонаж игры Cyberpunk 2077/.test(parsed.extract),
    JSON.stringify(parsed.extract.slice(0, 80)));
  check('парсер: заголовок раздела сохранён',
    /Биография/.test(parsed.extract), JSON.stringify(parsed.extract));

  const abilityQuery = 'какие способности у джуди';
  const ability = t.bestEvidenceChunk(
    judyRecord, t.searchTokens(abilityQuery), abilityQuery);

  check('раздел: вопрос о способностях ведёт в «Способности»',
    ability.group === 'abilities' && /взлом|виртуальн/.test(ability.evidence),
    JSON.stringify({ group: ability.group, text: ability.evidence.slice(0, 80) }));

  check('раздел: «кто такая» и «способности» дают разные фрагменты',
    judy.evidence !== ability.evidence);

  // =====================================================================
  // 6. Перевод запроса доходит до вики
  // =====================================================================
  s3.reset();
  wikiCalls.length = 0;
  translateCalls.length = 0;

  s3.put(HK_ROOT + '/manifest.json', {
    game: 'Hollow Knight',
    gameId: HK,
    status: 'indexing',
    complete: false,
    pageCount: 0,
    source: {
      siteName: 'Hollow Knight Wiki',
      language: 'en',
      api: 'https://hollowknight.fandom.com/api.php'
    }
  });
  s3.put(HK_ROOT + '/index.json', { items: [] });

  const ruQuery = await search({
    game: 'Hollow Knight',
    query: 'биография джуди альварес'
  });

  check('перевод: переводчик вызван',
    translateCalls.length > 0, translateCalls.join(' | '));
  check('перевод: вариант на языке вики попал в поиск',
    (ruQuery.body.search.wikiVariants || [])
      .some(v => /judy alvarez/i.test(v)),
    JSON.stringify(ruQuery.body.search.wikiVariants));
  check('перевод: поиск по вики выполнен с переводом',
    wikiCalls.some(c => /judy alvarez/i.test(c.search)),
    JSON.stringify({ calls: wikiCalls, variants: ruQuery.body.search.wikiVariants }).slice(0, 300));

  // =====================================================================
  // 7. Универсальность: новая игра, своя вика, базы не смешиваются
  // =====================================================================
  s3.reset();
  wikiCalls.length = 0;

  const discovered = await call({ action: 'discover', game: 'Hollow Knight' });

  check('обнаружение: вика найдена по названию игры',
    discovered.body.status === 'found' &&
    /hollowknight\.fandom\.com/.test(discovered.body.source.api),
    JSON.stringify(discovered.body).slice(0, 160));
  check('обнаружение: язык источника определён',
    discovered.body.source.language === 'en',
    JSON.stringify(discovered.body.source && discovered.body.source.language));

  const registered = await call({
    action: 'register',
    game: 'Hollow Knight',
    wikiApi: 'https://hollowknight.fandom.com/api.php'
  });

  check('регистрация: игра зарегистрирована',
    registered.body.status === 'registered' &&
    registered.body.gameId === HK,
    JSON.stringify(registered.body).slice(0, 140));

  const hkWarm = await call({ action: 'warm', game: 'Hollow Knight' });

  check('новая игра: база прогрета',
    hkWarm.body.status === 'ok' && hkWarm.body.pages >= 6,
    JSON.stringify({ status: hkWarm.body.status, pages: hkWarm.body.pages }));

  const hkSearch = await search({
    game: 'Hollow Knight',
    query: 'кто такая хорнет',
    limit: 3
  });

  check('новая игра: русский вопрос отвечает английская вика',
    (hkSearch.body.results || []).some(r => /Hornet/.test(r.title)),
    JSON.stringify((hkSearch.body.results || []).map(r => r.title)));
  check('новая игра: выдержка про персонажа содержательна',
    (hkSearch.body.results || []).some(r => /daughter of the Pale King/.test(r.evidence)),
    JSON.stringify(((hkSearch.body.results || [])[0] || {}).evidence || '').slice(0, 90));

  check('разделение баз: база Cyberpunk не создана заново',
    s3.get(CP_ROOT + '/manifest.json') === null &&
    s3.get(HK_ROOT + '/manifest.json') !== null,
    'cp=' + !!s3.get(CP_ROOT + '/manifest.json'));

  const cpPagesInHk = (s3.get(HK_ROOT + '/index.json').items || [])
    .filter(x => /Найт-Сити|Джуди/.test(x.title));

  check('разделение баз: в базе Hollow Knight нет статей Cyberpunk',
    cpPagesInHk.length === 0, JSON.stringify(cpPagesInHk.map(x => x.title)));

  // =====================================================================
  // 8. Синхронизация, слияние индекса и актуальность
  // =====================================================================
  s3.reset();
  wikiCalls.length = 0;

  s3.put(HK_ROOT + '/manifest.json', {
    game: 'Hollow Knight',
    gameId: HK,
    status: 'registered',
    complete: false,
    pageCount: 0,
    source: {
      siteName: 'Hollow Knight Wiki',
      language: 'en',
      api: 'https://hollowknight.fandom.com/api.php'
    }
  });
  s3.put(HK_ROOT + '/index.json', { items: [] });

  const sync1 = await call({ action: 'sync', game: 'Hollow Knight', limit: 3 });

  check('sync: первая порция статей загружена',
    sync1.body.status === 'indexing' && sync1.body.batchAdded === 3,
    JSON.stringify(sync1.body));
  check('sync: курсор сохранён',
    !!(s3.get(HK_ROOT + '/manifest.json') || {}).cursor,
    JSON.stringify((s3.get(HK_ROOT + '/manifest.json') || {}).cursor));

  // Параллельная запись: пока идёт sync, поиск добавил свою статью.
  const indexBefore = s3.get(HK_ROOT + '/index.json');
  indexBefore.items.push({
    pageId: 999,
    title: 'Параллельная статья',
    lead: 'параллельная статья',
    tail: '',
    tokens: ['параллельн', 'статья'],
    categories: []
  });
  s3.put(HK_ROOT + '/index.json', indexBefore);

  const sync2 = await call({ action: 'sync', game: 'Hollow Knight', limit: 3 });
  const mergedIndex = s3.get(HK_ROOT + '/index.json');

  check('sync: продолжение с курсора',
    sync2.body.pageCount > sync1.body.pageCount,
    sync1.body.pageCount + ' -> ' + sync2.body.pageCount);
  check('sync: параллельная запись не потеряна',
    (mergedIndex.items || []).some(x => x.pageId === 999),
    JSON.stringify((mergedIndex.items || []).map(x => x.pageId)));

  // Актуальность: у статьи изменился revisionId.
  hollow.setText('Hornet', 'Hornet is a protector of Hallownest and a boss.\n\n' +
    'Biography\nHornet is the daughter of the Pale King and Herrah, now updated.', 2002);
  hollow.setRecentChanges([
    { title: 'Hornet', revid: 2002, old_revid: 1002, timestamp: '2026-02-01T00:00:00Z' },
    { title: 'Brand New Page', revid: 3001, old_revid: 0, timestamp: '2026-02-01T00:00:00Z' }
  ]);

  const refresh = await call({ action: 'refresh', game: 'Hollow Knight' });

  check('refresh: изменившаяся статья обновлена',
    refresh.body.status === 'ok' && refresh.body.updated >= 1,
    JSON.stringify(refresh.body));
  check('refresh: новая страница отмечена, но вики целиком не качалась',
    (refresh.body.newTitles || []).includes('Brand New Page'),
    JSON.stringify(refresh.body.newTitles));

  const hornetPage = s3.get(HK_ROOT + '/pages/303.json');

  check('refresh: текст статьи обновлён в хранилище',
    hornetPage && /now updated/.test(hornetPage.extract),
    JSON.stringify(hornetPage && hornetPage.extract.slice(-60)));

  const failed = results.filter(r => !r.ok);

  console.log('\n' + (results.length - failed.length) + '/' +
    results.length + ' проверок пройдено');

  if (failed.length) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
