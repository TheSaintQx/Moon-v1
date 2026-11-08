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
// Тестовая вика: свой хост разрешаем явно, внешняя сеть всё равно запрещена.
process.env.KB_ALLOWED_WIKI_HOSTS = 'wiki.test';

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
  // Раньше любой русский вопрос уходил в вики и не успевал. Теперь сильный
  // локальный ответ остаётся локальным, а вики — только для слабой выдачи.
  check('полный режим: сильный локальный ответ без вики',
    s3.foreign.length === 0 &&
    full.body.search && full.body.search.mode === 'local',
    'foreign=' + s3.foreign.length + ' mode=' +
      (full.body.search && full.body.search.mode));

  const weak = await search({ query: 'какой климат в калифорнийском мегаполисе' });
  check('полный режим: слабая выдача идёт в вики', s3.foreign.length > 0,
    'foreign=' + s3.foreign.length);
  check('полный режим: режим local+wiki',
    weak.body.search && weak.body.search.mode === 'local+wiki',
    JSON.stringify(weak.body.search && weak.body.search.mode));

  // ---------- намерение вопроса ----------

  const t = kb._test;

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

  const plan = t.warmPlan('Ведьмак 3', 'ru');
  check('тёплая база: план покрывает обзорные разделы',
    plan[0].section === 'main' &&
    plan.some(x => x.section === 'characters') &&
    plan.some(x => x.section === 'locations') &&
    plan.some(x => x.section === 'mechanics'),
    JSON.stringify(plan.map(x => x.section)));

  // ---------- тёплая база и вопросы по смыслу ----------

  const WIKI = 'wiki.test';

  const WIKI_PAGES = [
    {
      pageid: 201,
      title: 'Персонажи',
      extract: 'Ви — главный герой. Джонни Сильверхенд — энграмма в его голове. ' +
        'Джеки Уэллс — друг Ви и напарник.'
    },
    {
      pageid: 202,
      title: 'Локации',
      extract: 'Найт-Сити — город в Калифорнии, разделённый на районы.'
    },
    {
      pageid: 203,
      title: 'Джонни Сильверхенд',
      extract: 'Джонни Сильверхенд — рокер и энграмма, застрявшая в голове Ви.'
    },
    {
      pageid: 204,
      title: 'Джеки Уэллс',
      extract: 'Джеки Уэллс — напарник Ви, погибает в начале истории.'
    }
  ];

  const byTitle = title => WIKI_PAGES
    .filter(p => p.title.toLowerCase().includes(String(title).toLowerCase()));

  s3.mount(WIKI, (url, options, method) => {
    const params = url.searchParams;
    const search = String(params.get('gsrsearch') || '').toLowerCase();

    if (params.get('generator') === 'allpages') {
      return { status: 200, body: { query: { pages: [] } } };
    }

    let pages = WIKI_PAGES;

    if (search.includes('персонаж')) {
      pages = WIKI_PAGES.filter(p => [201, 203, 204].includes(p.pageid));
    } else if (search.includes('локац') || search.includes('мир')) {
      pages = byTitle('Локации');
    } else if (search.includes('предмет') || search.includes('оруж')) {
      pages = [];
    } else if (search.includes('процесс') || search.includes('механик')) {
      pages = [];
    } else if (search.includes('сюжет') || search.includes('концов')) {
      pages = [];
    }

    return { status: 200, body: { query: { pages: pages } } };
  });

  function warmEvent(extra) {
    return event(Object.assign({
      action: 'warm',
      game: 'Cyberpunk 2077'
    }, extra));
  }

  seed();

  const seedManifest = s3.get(ROOT + '/manifest.json');
  seedManifest.source.api = 'https://' + WIKI + '/api.php';
  seedManifest.source.language = 'ru';
  seedManifest.status = 'indexing';
  seedManifest.complete = false;
  s3.put(ROOT + '/manifest.json', seedManifest);

  const warm = await kb.handler(warmEvent({}));
  const warmBody = JSON.parse(warm.body);

  check('тёплая база: статус ok', warmBody.status === 'ok', warmBody.status);
  check('тёплая база: обзорная статья по персонажам загружена',
    Array.isArray(warmBody.sections && warmBody.sections.characters) &&
    warmBody.sections.characters.includes(201),
    JSON.stringify(warmBody.sections));
  check('тёплая база: итог сохранён в S3',
    !!s3.get('kb/games/' + GAME + '/warm.json'));
  check('тёплая база: страница сохранена в индекс',
    (s3.get(ROOT + '/index.json').items || []).some(x => x.pageId === 201));

  const warmAgain = await kb.handler(warmEvent({}));
  const warmAgainBody = JSON.parse(warmAgain.body);

  check('тёплая база: повтор без перезагрузки',
    warmAgainBody.cached === true, JSON.stringify(warmAgainBody.cached));

  const warmIndex = s3.get(ROOT + '/index.json');
  check('тёплая база: индекс не теряет уже собранные страницы',
    (warmIndex.items || []).some(x => x.pageId === 101) &&
    (warmIndex.items || []).some(x => x.pageId === 201),
    JSON.stringify((warmIndex.items || []).map(x => x.pageId)));

  // Замок: параллельный прогрев (выбор игры + первый вопрос) не дублируется.
  s3.put(ROOT + '/warm-lock.json', { at: Date.now() });

  const busy = await kb.handler(warmEvent({ refresh: true }));
  const busyBody = JSON.parse(busy.body);

  check('тёплая база: параллельный прогрев не дублируется',
    busyBody.status === 'busy', busyBody.status);

  s3.put(ROOT + '/warm-lock.json', { at: 0 });

  const refreshed = await kb.handler(warmEvent({ refresh: true }));
  const refreshedBody = JSON.parse(refreshed.body);

  check('тёплая база: refresh перечитывает статьи',
    refreshedBody.cached === false && refreshedBody.status === 'ok',
    JSON.stringify({ status: refreshedBody.status, cached: refreshedBody.cached }));
  check('тёплая база: замок снят после прогрева',
    (s3.get(ROOT + '/warm-lock.json') || {}).at === 0,
    JSON.stringify(s3.get(ROOT + '/warm-lock.json')));

  const chars = await search({
    query: 'кто главные герои игры',
    limit: 3
  });

  check('намерение в ответе поиска',
    chars.body.intent && chars.body.intent.name === 'characters',
    JSON.stringify(chars.body.intent));
  check('обзорная статья попала в выдачу без совпадения слов',
    (chars.body.results || []).some(r => r.title === 'Персонажи'),
    (chars.body.results || []).map(r => r.title).join(' | '));
  check('выдержка про героев содержит имена',
    (chars.body.results || []).some(r => /Джонни|Джеки/.test(r.evidence)),
    String(((chars.body.results || [])[0] || {}).evidence || '').slice(0, 100));

  const compare = await search({
    query: 'кто лучше джонни или джеки',
    limit: 4
  });

  check('сравнение: две сущности в ответе',
    compare.body.comparison &&
    compare.body.comparison.entities.join('|') === 'джонни|джеки',
    JSON.stringify(compare.body.comparison));
  check('сравнение: выдача содержит обе стороны',
    (compare.body.results || []).some(r => r.entity === 'джонни') &&
    (compare.body.results || []).some(r => r.entity === 'джеки'),
    JSON.stringify((compare.body.results || []).map(r => r.entity)));

  const failed = results.filter(r => !r.ok);

  console.log('\n' + (results.length - failed.length) + '/' +
    results.length + ' проверок пройдено');

  if (failed.length) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
