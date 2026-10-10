import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function checkGame({data, heat, meta, kill}, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23',
  }).formatToParts(now).map(p=>[p.type,p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`)-86400000).toISOString().slice(0,10);
  const minute = Number(parts.hour)*60+Number(parts.minute);
  const expectedDate = minute>=23*60 ? today : yesterday;
  const rec = data.recommendation, matrix = heat.matrix22, coverage = heat.matrix22Coverage;
  const issues = [];
  const same = (a,b)=>String(a)===String(b);
  if (!rec?.basedOnDate || rec.basedOnDate<expectedDate) issues.push(`开奖数据截至${rec?.basedOnDate??'未知'}，早于应检查日期${expectedDate}；需排查源站、任务或官方休市，不可补造数据`);
  for (const [name,r] of [['直选',matrix],['组选',coverage],['融合杀码',kill]]) {
    if(!same(r?.targetIssue,rec?.targetIssue)||!same(r?.basedOnIssue,rec?.basedOnIssue)) issues.push(`${name}与基础模型期号不同步`);
  }
  for(const size of [5,6,7]) {
    const pool=meta.pools?.[size];
    if(!same(pool?.targetIssue??pool?.recommendation?.targetIssue??meta.targetIssue,rec?.targetIssue)) issues.push(`融合定位${size}码期号不同步`);
    if(pool?.recommendation&&!same(pool.recommendation.basedOnIssue,rec.basedOnIssue)) issues.push(`融合定位${size}码依据期号不同步`);
  }
  const locked=matrix?.numbers?.length===22;
  if(locked&&(!matrix.heatSnapshot||!same(Number(matrix.heatSnapshot.issue),Number(String(matrix.targetIssue).slice(-3))))) issues.push('22组缺少本期热度存档');
  // An evening lag is an error, not a fabricated recommendation. Before 20:20
  // and after drawing the next day's still-pending recommendations are normal.
  if(rec?.basedOnDate<today&&minute>=20*60+50&&minute<=21*60+50) {
    if(!locked||matrix.heatSnapshot?.date!==today) issues.push('今晚22组尚未取得当期热度并锁定');
    if((coverage?.numbers?.length??0)!==22) issues.push('今晚组选尚未锁定');
    for(const size of [5,6,7]) if(meta.pools?.[size]?.recommendation?.heatMode!=='target-locked') issues.push(`今晚融合定位${size}码尚未锁定`);
    if(!kill.recommendation) issues.push('今晚融合杀码尚未锁定');
  }
  return {ok:issues.length===0,today,expectedDate,basedOnDate:rec?.basedOnDate,targetIssue:rec?.targetIssue,locked,issues};
}

async function run() {
  const online=process.argv.includes('--online');
  const base='https://asjgnetctk-jpg.github.io/fc3d-research/';
  const load=async file=>{
    if(!online)return JSON.parse(await readFile(path.join(root,'pages',file),'utf8'));
    let last;
    for(let attempt=0;attempt<3;attempt++)try{
      const res=await fetch(`${base}${file}?t=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(20000)});
      if(!res.ok)throw new Error(`${file}: HTTP ${res.status}`);
      return await res.json();
    }catch(error){last=error;}
    throw last;
  };
  let failed=false;
  for(const [game,prefix] of [['fc3d',''],['pl3','pl3-']])try{
    const [data,heat,meta,kill]=await Promise.all(['data.json','heat-data.json','meta-position-data.json','matrix-kill3-dynamic-data.json'].map(f=>load(prefix+f)));
    const result=checkGame({data,heat,meta,kill});
    console.log(JSON.stringify({game,online,...result}));
    if(!result.ok){failed=true;for(const issue of result.issues)console.error(`::error title=${game}自动更新检查::${issue}`);}
  }catch(error){failed=true;console.error(`::error title=${game}自动更新检查::${error.message}`);}
  if(failed)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await run();
