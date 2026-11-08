'use strict';

// Мини-вики на MediaWiki API для локальных тестов.
// Умеет ровно то, что использует движок базы знаний: siteinfo, search,
// allpages с продолжением, выборку по pageids/titles, recentchanges и parse.
// Никакой сети: запросы приходят из tests/fake-s3.js.

const MAX_CHARS = 30000;

function contentOf(page) {
  return String(page.text || '').slice(0, MAX_CHARS);
}

function toApiPage(page, opts) {
  const o = opts || {};
  const out = {
    pageid: page.pageid,
    title: page.title,
    ns: 0,
    fullurl: 'https://' + o.host + '/wiki/' + encodeURIComponent(page.title.replace(/ /g, '_')),
    lastrevid: page.revid || 1,
    categories: (page.categories || []).map(c => ({ title: 'Category:' + c }))
  };

  if (o.withExtract) out.extract = contentOf(page);

  if (o.withRevision) {
    out.revisions = [{
      revid: page.revid || 1,
      slots: { main: { content: page.wikitext || page.text || '' } }
    }];
  }

  return out;
}

function tokensOf(s) {
  return String(s || '').toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(x => x.length > 1);
}

function createWiki(config) {
  const cfg = config || {};
  const host = cfg.host;
  const pages = (cfg.pages || []).map((p, i) => ({
    pageid: p.pageid || (100 + i),
    title: p.title,
    text: p.text || '',
    wikitext: p.wikitext || '',
    revid: p.revid || (1000 + i),
    categories: p.categories || []
  }));

  const state = {
    host: host,
    calls: [],
    allpagesOffset: 0,
    recentChanges: null
  };

  function byTitle(title) {
    const key = String(title || '').toLowerCase().replace(/_/g, ' ');
    return pages.find(p => p.title.toLowerCase() === key);
  }

  // MediaWiki ищет не по точному слову, а по префиксу и словоформам.
  // Тест повторяет это, иначе «персонажи» не находит «персонаж».
  function matchesToken(haystack, needle) {
    const n = needle.slice(0, 5);

    if (!n) return false;

    return haystack.some(h => h.startsWith(n) || n.startsWith(h.slice(0, 5)));
  }

  function search(query, limit) {
    const qTokens = tokensOf(query);
    if (!qTokens.length) return [];

    return pages
      .map(p => {
        const titleTokens = tokensOf(p.title);
        const bodyTokens = tokensOf(p.text);
        let score = 0;

        for (const t of qTokens) {
          if (matchesToken(titleTokens, t)) score += 10;
          else if (matchesToken(bodyTokens, t)) score += 3;
        }

        return { page: p, score: score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit || 5)
      .map(x => x.page);
  }

  function handle(url, init) {
    const params = url.searchParams;
    const action = String(params.get('action') || 'query');
    const prop = String(params.get('prop') || '');
    const list = String(params.get('list') || '');
    const generator = String(params.get('generator') || '');

    state.calls.push({
      host: host,
      action: action,
      generator: generator,
      list: list,
      search: params.get('srsearch') || params.get('gsrsearch') || '',
      pageids: params.get('pageids') || '',
      titles: params.get('titles') || ''
    });

    if (action === 'query' && params.get('meta') === 'siteinfo') {
      return {
        status: 200,
        body: {
          query: {
            general: {
              sitename: cfg.sitename || host,
              server: 'https://' + host,
              generator: 'MediaWiki 1.39.0',
              lang: cfg.lang || 'en'
            }
          }
        }
      };
    }

    if (action === 'parse') {
      const page = pages.find(p => String(p.pageid) === String(params.get('pageid')));

      if (!page) {
        return { status: 200, body: { error: { code: 'missingtitle', info: 'no page' } } };
      }

      return {
        status: 200,
        body: {
          parse: {
            pageid: page.pageid,
            title: page.title,
            wikitext: page.wikitext || page.text,
            text: '<p>' + page.text + '</p>'
          }
        }
      };
    }

    if (list === 'recentchanges') {
      const changes = (state.recentChanges || pages.map(p => ({
        title: p.title,
        revid: p.revid,
        old_revid: p.revid - 1,
        timestamp: '2026-01-01T00:00:00Z'
      })));

      return {
        status: 200,
        body: { query: { recentchanges: changes.slice(0, Number(params.get('rclimit') || 30)) } }
      };
    }

    if (list === 'search') {
      const found = search(params.get('srsearch'), Number(params.get('srlimit') || 8));

      return {
        status: 200,
        body: {
          query: {
            search: found.map(p => ({
              title: p.title,
              pageid: p.pageid,
              size: contentOf(p).length,
              wordcount: contentOf(p).split(/\s+/).length
            }))
          }
        }
      };
    }

    if (generator === 'search') {
      const found = search(params.get('gsrsearch'), Number(params.get('gsrlimit') || 5));

      return {
        status: 200,
        body: {
          query: {
            pages: found.map(p => toApiPage(p, {
              host: host,
              withExtract: true,
              withRevision: true
            }))
          }
        }
      };
    }

    if (generator === 'allpages') {
      const limit = Number(params.get('gaplimit') || 20);
      const continueFrom = String(params.get('gapcontinue') || '');
      let start = 0;

      if (continueFrom) {
        const at = pages.findIndex(p => p.title === continueFrom);
        start = at >= 0 ? at : 0;
      }

      const slice = pages.slice(start, start + limit);
      const next = start + limit < pages.length ? pages[start + limit].title : null;
      const body = {
        query: {
          pages: slice.map(p => toApiPage(p, {
            host: host,
            withExtract: true,
            withRevision: true
          }))
        }
      };

      if (next) body.continue = { gapcontinue: next, continue: '||' };

      return { status: 200, body: body };
    }

    if (params.get('pageids')) {
      const ids = String(params.get('pageids')).split('|');
      const found = pages.filter(p => ids.includes(String(p.pageid)));

      return {
        status: 200,
        body: {
          query: {
            pages: found.map(p => toApiPage(p, {
              host: host,
              withExtract: prop.indexOf('extracts') !== -1,
              withRevision: prop.indexOf('revisions') !== -1
            }))
          }
        }
      };
    }

    if (params.get('titles')) {
      const titles = String(params.get('titles')).split('|');
      const found = titles.map(byTitle).filter(Boolean);

      return {
        status: 200,
        body: {
          query: {
            pages: found.map(p => toApiPage(p, {
              host: host,
              withExtract: prop.indexOf('extracts') !== -1,
              withRevision: prop.indexOf('revisions') !== -1
            }))
          }
        }
      };
    }

    return { status: 200, body: { query: { pages: [] } } };
  }

  return {
    host: host,
    pages: pages,
    state: state,
    handle: handle,
    byTitle: byTitle,
    setText: function (title, text, revid) {
      const page = byTitle(title);

      if (!page) return null;

      page.text = text;
      page.wikitext = text;
      if (revid) page.revid = revid;

      return page;
    },
    setRecentChanges: function (list) {
      state.recentChanges = list;
    },
    callsFor: function (kind) {
      return state.calls.filter(c => c[kind]);
    }
  };
}

module.exports = { createWiki: createWiki };
