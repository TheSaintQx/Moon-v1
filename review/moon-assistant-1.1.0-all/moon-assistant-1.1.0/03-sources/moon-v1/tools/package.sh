#!/usr/bin/env bash
# Собирает готовые к загрузке ZIP-архивы для Yandex Cloud Functions.
# В архиве точка входа всегда называется index.js, как ждёт облако.
#
# Дополнительно:
#   - в каждый архив кладётся VERSION с версией функции и версией релиза;
#   - в dist/SHA256SUMS.txt пишутся контрольные суммы всех архивов;
#   - скрипт печатает таблицу «функция — версия — размер — sha256».
set -euo pipefail

cd "$(dirname "$0")/.."

RELEASE="1.1.0"
DIST="dist"

KB_VER="0.9.0"
VISION_VER="4.1.0"
SKILL_VER="10.1"

rm -rf "$DIST"
mkdir -p "$DIST/moon-skill" "$DIST/moon-vision" "$DIST/moon-knowledge-engine"

cp moon-skill-index.js "$DIST/moon-skill/index.js"
cp moon-skill-core.js "$DIST/moon-skill/moon-skill-core.js"

cp moon-vision-index.js "$DIST/moon-vision/index.js"
cp moon-vision-core.js "$DIST/moon-vision/moon-vision-core.js"

cp moon-knowledge-index.js "$DIST/moon-knowledge-engine/index.js"

write_version() {
  local dir="$1" name="$2" ver="$3"
  {
    echo "function=$name"
    echo "version=$ver"
    echo "release=$RELEASE"
    echo "built=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$dir/VERSION"
}

write_version "$DIST/moon-skill" "moon-skill" "$SKILL_VER"
write_version "$DIST/moon-vision" "moon-vision" "$VISION_VER"
write_version "$DIST/moon-knowledge-engine" "moon-knowledge-engine" "$KB_VER"

# Имя архива = имя функции + версия релиза: moon-skill-v1.1.0.zip
for fn in moon-skill moon-vision moon-knowledge-engine; do
  (cd "$DIST/$fn" && zip -q -r "../$fn-v$RELEASE.zip" . -x '.*')
done

(cd "$DIST" && sha256sum \
  "moon-knowledge-engine-v$RELEASE.zip" \
  "moon-vision-v$RELEASE.zip" \
  "moon-skill-v$RELEASE.zip" > SHA256SUMS.txt)

printf '%-24s %-8s %10s  %s\n' "функция" "версия" "размер" "sha256"
for fn in moon-knowledge-engine moon-vision moon-skill; do
  case "$fn" in
    moon-knowledge-engine) ver="$KB_VER" ;;
    moon-vision) ver="$VISION_VER" ;;
    moon-skill) ver="$SKILL_VER" ;;
  esac
  zipfile="$DIST/$fn-v$RELEASE.zip"
  size=$(stat -c %s "$zipfile")
  sum=$(sha256sum "$zipfile" | cut -d' ' -f1)
  printf '%-24s %-8s %10s  %s\n' "$fn" "$ver" "$size" "$sum"
done

echo
echo "Релиз $RELEASE. Архивы: $DIST/*-v$RELEASE.zip, суммы: $DIST/SHA256SUMS.txt"
