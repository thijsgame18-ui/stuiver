#!/bin/bash
# gebruik: release.sh "notitie 1" "notitie 2" ...
set -e
cd /home/claude
python3 /tmp/build.py
python3 /home/claude/tests/smoke.py || { echo 'Release afgebroken: rooktest mislukt'; exit 1; }
H=$(md5sum stuiver.html|cut -c1-32); if [ -f /tmp/last_release_md5 ] && [ "$(cat /tmp/last_release_md5)" = "$H" ]; then echo 'Release afgebroken: er is niets veranderd'; exit 1; fi
rm -rf /tmp/out && java -jar /tmp/tools/apktool/apktool.jar b apk -o /tmp/out/unsigned.apk >/dev/null 2>&1
(cd /tmp/out && java -jar /tmp/tools/signer/*.jar -a unsigned.apk --ks /home/claude/apk-key/stuiver.jks --ksAlias stuiver --ksPass "${KS_PASS:-$(cat /home/claude/apk-key/pass.txt)}" --ksKeyPass "${KS_PASS:-$(cat /home/claude/apk-key/pass.txt)}" -o signed >/tmp/sign.log 2>&1)
cp /tmp/out/signed/*.apk /home/claude/Stuiver.apk
VC=$(grep -o "versionCode: [0-9]*" apk/apktool.yml | grep -o "[0-9]*")
VN=$(grep -o "versionName: '[^']*'" apk/apktool.yml | cut -d"'" -f2)
R=/home/claude/stuiver
cp Stuiver.html $R/index.html
mkdir -p $R/src && rm -rf $R/src/* && cp stuiver.html $R/src/ && cp -r app-src fn tests $R/src/ && mkdir -p $R/src/apk && cp -r apk/AndroidManifest.xml apk/apktool.yml apk/res $R/src/apk/ && cp /tmp/build.py /tmp/release.sh $R/src/tests/
python3 - "$VC" "$VN" "$@" <<'PY'
import json,sys
vc,vn,*notes=sys.argv[1:]
json.dump({"versionCode":int(vc),"versionName":vn,"notes":notes,"apk":f"https://raw.githubusercontent.com/thijsgame18-ui/stuiver/main/Stuiver.apk?v={vc}"},open('/home/claude/stuiver/version.json','w'),ensure_ascii=False,indent=1)
PY
cd $R
cp /home/claude/Stuiver.apk $R/Stuiver.apk
git add -A && git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -q -m "Stuiver $VN

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012a4MoJAmiG3YEi1M5rzaU7" && git -c push.negotiate=true push -q origin main
echo "$H" > /tmp/last_release_md5
echo "released $VN ($VC)"
