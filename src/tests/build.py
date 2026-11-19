import re
s=open('/home/claude/stuiver.html').read()
yml=open('/home/claude/apk/apktool.yml').read()
vn=re.search(r"versionName: '([^']+)'",yml).group(1)
s=s.replace('__APP_VN__',vn)
lib=open('/tmp/sbjs/package/dist/umd/supabase.js').read().replace('</script','<\\/script')
xl=open('/tmp/xlsxpkg/package/dist/xlsx.full.min.js').read().replace('</script','<\\/script')
i=s.index('<script>\n/* ---------- helpers');s2=s[:i]+'<script>'+lib+'</script>\n<script>'+xl+'</script>\n'+s[i:]
csp='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'unsafe-inline\'; style-src \'unsafe-inline\' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src https://wnircustmcvwjlkvtyur.supabase.co wss://wnircustmcvwjlkvtyur.supabase.co https://raw.githubusercontent.com; form-action \'none\'; base-uri \'none\'">'
s2=s2.replace('<meta charset="utf-8">','<meta charset="utf-8">\n'+csp,1)
open('/home/claude/apk/assets/index.html','w').write(s2)
open('/home/claude/Stuiver.html','w').write(s2)
