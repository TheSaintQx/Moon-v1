#!/usr/bin/env bash
# Собирает готовые к загрузке ZIP-архивы для Yandex Cloud Functions.
# В архиве точка входа всегда называется index.js, как ждёт облако.
set -euo pipefail

cd "$(dirname "$0")/.."

DIST="dist"
rm -rf "$DIST"
mkdir -p "$DIST/moon-skill" "$DIST/moon-vision" "$DIST/moon-knowledge-engine"

cp moon-skill-index.js "$DIST/moon-skill/index.js"
cp moon-skill-core.js "$DIST/moon-skill/moon-skill-core.js"

cp moon-vision-index.js "$DIST/moon-vision/index.js"
cp moon-vision-core.js "$DIST/moon-vision/moon-vision-core.js"

cp moon-knowledge-index.js "$DIST/moon-knowledge-engine/index.js"

for fn in moon-skill moon-vision moon-knowledge-engine; do
  (cd "$DIST/$fn" && zip -q -r "../$fn.zip" . -x '.*')
done

ls -l "$DIST"/*.zip
