# Moon v1 — Лунный Ассистент

Три функции Yandex Cloud, которые вместе дают голосового игрового ассистента
для Алисы: знания по игре, анализ кадров с телефона и оверлей поверх игры.

## Структура

| Файл | Что это |
| --- | --- |
| `moon-skill-index.js` + `moon-skill-core.js` | навык Алисы; адаптер переводит вопрос в асинхронный вызов |
| `moon-vision-index.js` + `moon-vision-core.js` | зрение, база знаний, кэш ответов, `answer_ready` для оверлея |
| `moon-knowledge-index.js` | база знаний: вики → индекс в Object Storage → поиск с выдержками |
| `tests/` | локальные тесты с подменой S3, базы знаний и модели |
| `tools/package.sh` | собирает `dist/*.zip` для загрузки в облако |
| `ИНСТРУКЦИЯ.md` | что изменилось и как разворачивать |

## Сборка архивов

```bash
./tools/package.sh
```

В архиве точка входа всегда `index.js`, как ждёт Yandex Cloud.

## Проверка

```bash
node tests/kb.test.js
node tests/vision.test.js
node tests/skill.test.js
```

Тесты работают без облака и без секретов: Object Storage заменён памятью,
внешняя сеть заблокирована, база знаний и модель подменены.

Проверить именно то, что лежит в архивах:

```bash
KB_MODULE="$PWD/dist/moon-knowledge-engine/index.js" node tests/kb.test.js
VISION_MODULE="$PWD/dist/moon-vision/moon-vision-core.js" node tests/vision.test.js
SKILL_MODULE="$PWD/dist/moon-skill/moon-skill-core.js" node tests/skill.test.js
```
