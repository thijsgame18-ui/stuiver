"""Rooktest voor Stuiver. Faalt (exit 1) bij JS-fouten of verkeerde uitkomsten."""
import asyncio,sys,json
from playwright.async_api import async_playwright
FAIL=[]
def check(name,cond,detail=''):
    if not cond: FAIL.append(f'{name}: {detail}')
SETUP="""()=>{hideAuth();S.catsV2=false;ensureCatsV2();S.settings.ptype='maand';S.settings.pstart='';S.settings.incomes=[{id:'v',name:'A',amount:4400,day:23},{id:'m',name:'T',amount:4488,day:24}];
 const C=re=>S.cats.find(c=>re.test(c.name)).id;const sp=S.cats.find(c=>c.name==='Spaar A&T');TX={};
 const add=(d,ty,a,desc,cat,ex)=>{const m=d.slice(0,7);(TX[m]=TX[m]||[]).push({id:uid(),type:ty,amount:a,desc,date:d,cat,...(ex||{})})};
 for(const m of ['2026-08','2026-09','2026-10','2026-11']){add(m+'-23','in',4400,'Werkgever A');add(m+'-24','in',4500,'Werkgever B');add(m+'-25','out',120,'Albert Heijn 1234 BARNEVELD NLD',C(/boodschap/i));add(m+'-26','out',300,'Naar Oranje spaarrekening B11130519',sp.id)}
 add('2026-08-12','out',40,'Mercadona MALAGA ESP Kaartnr: 1',C(/boodschap/i));add('2026-08-13','out',50,'Bar MALAGA ESP Kaartnr: 1',C(/horeca/i));add('2026-08-15','out',60,'Super MALAGA ESP Kaartnr: 1',C(/boodschap/i));
 add('2026-11-18','in',10,'Van Oranje spaarrekening B11130519',S.cats.find(c=>c.kind==='in').id);
 S.assets=[{id:'b',type:'betaal',name:'Betaal',amount:500,updated:today()},{id:'a2',type:'spaar',name:'Spaar A&T',amount:1000,updated:'2026-11-01',cat:sp.id,match:'B11130519'},{id:'d',type:'beleg',name:'DeGiro',amount:20000}];
 S.internalV1=false;ensureInternalV1();render();return true}"""
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch()
        for dark in [False,True]:
            pg=await b.new_page(viewport={'width':412,'height':900})
            errs=[];pg.on('pageerror',lambda e:errs.append(str(e)));pg.on('console',lambda m:errs.append(m.text) if m.type=='error' else None)
            await pg.add_init_script("window.Android={versionCode:()=>1,notify(){},schedule(){},cancel(){},setSecure(){},deviceSecure:()=>false,installUpdate(u){window._u=u}}")
            await pg.route('https://raw.githubusercontent.com/**',lambda r:r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps({'versionCode':999,'versionName':'9.9','notes':['x'],'apk':'https://x/a.apk'})))
            await pg.goto('file:///home/claude/Stuiver.html');await pg.wait_for_timeout(800)
            await pg.evaluate(SETUP);await pg.evaluate(f"S.settings.dark={str(dark).lower()};render()")
            for v in ['home','budget','transacties','vast','vermogen','beleggingen','categorieen','meer','reizen','toekomst','jaar','rapport','overzicht','instellingen','doelen','inzicht']:
                await pg.evaluate(f"go('{v}')");await pg.wait_for_timeout(120)
            r=await pg.evaluate("""()=>({sp:acctBalance(S.assets.find(a=>a.id==='a2')),inc:sums(periodAt(0)).inc,trips:foundTrips().length,
               m3:(()=>{const B={a:hj({id:'a',v:1})};return merge3Items([{id:'a',v:1}],[{id:'a',v:2}],B)[0].v})(),
               freq:freqData().length,plan:planRun(planGet()).length,yr:yearData(2026).tOut>0,where:WHERE.length,clean:cleanPlan().plan.length>0,sug:budgetSuggest().length>0})""")
            check('spaarsaldo',abs(r['sp']-(1000+300-10))<0.01 or abs(r['sp']-(1000-10+300))<0.01,r)
            check('geen spaaropname als inkomen',r['inc']<9000 or r['inc']==8900,r)
            check('reis gevonden',r['trips']==1,r);check('3-weg merge',r['m3']==2,r);check('freq',r['freq']>0,r);check('planner',r['plan']>5,r)
            check('jaaroverzicht',r['yr'],r);check('taart',r['where']>0,r);check('opruimen',r['clean'],r);check('budgetvoorstel',r['sug'],r)
            await pg.evaluate("checkUpdate(true)");await pg.wait_for_timeout(400)
            check('update-melding','9.9' in (await pg.evaluate("$('updateBanner').innerText")),'')
            check(f'JS-fouten (donker={dark})',not errs,errs[:3])
            await pg.close()
        await b.close()
asyncio.run(main())
if FAIL:
    print('ROOKTEST MISLUKT:');[print(' -',f) for f in FAIL];sys.exit(1)
print('Rooktest geslaagd')
