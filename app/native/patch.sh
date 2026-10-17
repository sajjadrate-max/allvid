#!/usr/bin/env bash
# Runs after `npx cap add android`: adds the native plugin, the share-sheet entry,
# storage permission for old Android versions, and the app icon.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=android/app/src/main/java/com/sajjadrate/videodl
mkdir -p "$SRC"
cp native/DownloaderPlugin.java native/MainActivity.java "$SRC/"

python3 - <<'PY'
import re
p = "android/app/src/main/AndroidManifest.xml"
s = open(p, encoding="utf-8").read()
perm = '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />'
if perm not in s:
    s = s.replace("</manifest>", "    " + perm + "\n</manifest>")
share = ('<intent-filter>\n'
         '                <action android:name="android.intent.action.SEND" />\n'
         '                <category android:name="android.intent.category.DEFAULT" />\n'
         '                <data android:mimeType="text/plain" />\n'
         '            </intent-filter>')
if "android.intent.action.SEND" not in s:
    s = re.sub(r"(<activity[^>]*MainActivity[^>]*>)", r"\1\n            " + share, s, count=1)
open(p, "w", encoding="utf-8").write(s)
PY

# App icon: our PNG in every density; drop the adaptive-icon XML so the PNG is used.
RES=android/app/src/main/res
for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  mkdir -p "$RES/mipmap-$d"
  cp www/icon-192.png "$RES/mipmap-$d/ic_launcher.png"
  cp www/icon-192.png "$RES/mipmap-$d/ic_launcher_round.png"
  rm -f "$RES/mipmap-$d/ic_launcher_foreground.png"
done
rm -rf "$RES/mipmap-anydpi-v26"
grep -n "SEND\|WRITE_EXTERNAL" android/app/src/main/AndroidManifest.xml
