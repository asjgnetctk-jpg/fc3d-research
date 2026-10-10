import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const game = process.env.LOTTERY_GAME === 'pl3' ? 'pl3' : 'fc3d';
const prefix = game === 'pl3' ? 'pl3-' : '';
const read = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const source = await read(`scripts/data/${game}-full-history.json`);
const draws = source.rows;
const heat = await read(`scripts/data/${game}-17500-heat.json`);
const matrix = await read(`pages/${prefix}heat-data.json`);
const expertFiles = ['data', 'v2-data', 'v5-data', 'kill3-data', 'position7-data', 'meta-position-data'];
if (game === 'fc3d') expertFiles.push('v9-data', 'v9-2-data');
const experts = Object.fromEntries(await Promise.all(expertFiles.map(async name => [name, await read(`pages/${prefix}${name}.json`)])));
const maps = Object.fromEntries(Object.entries(experts).map(([name, data]) => [name, new Map((data.history ?? data.rows ?? []).map(row => [String(row.issue), row]))]));
const heatMap = new Map(heat.rows.map(row => [`${row.date.slice(0,4)}-${Number(row.issue)}`, row]));
const matrixMap = new Map([...(matrix.matrix22.replayRows ?? []), ...(matrix.matrix22.liveRows ?? [])].map(row => [row.date, row]));
const contains = (value, digit) => String(value ?? '').includes(String(digit));
const triples = [];
for(let a=0;a<8;a++)for(let b=a+1;b<9;b++)for(let c=b+1;c<10;c++)triples.push(`${a}${b}${c}`);
const mask = draw => [...String(draw)].reduce((m,d)=>m|(1<<Number(d)),0);
const masks = draws.map(row=>mask(row.draw));
const tripleMasks = triples.map(mask);
const featureNames = ['出现频率20','出现频率60','出现频率200','当前遗漏','V7支持','V2支持','V5支持','旧杀码反向','旧定位支持','融合定位支持','V9反向','V9.2反向','热度','22组矩阵支持','三数字共同排除60','三数字共同排除200'];
function expertRecommendation(name, issue, live) { return live ? experts[name]?.recommendation : maps[name]?.get(String(issue)); }
function positionSupport(name, issue, digit, live) {
  const data=experts[name]; let count=0, total=0;
  for(const size of [5,6,7]) {
    const pool=data?.pools?.[size];
    const row=live?pool?.recommendation:pool?.history?.find(x=>String(x.issue)===String(issue));
    if(row)for(const key of ['hundredsPool','tensPool','unitsPool']){count+=Number(contains(row[key],digit));total++;}
  }
  return total?count/total:0;
}
function featureRows(index, issue, date, live=false, heatRow=null) {
  const previous=draws.slice(Math.max(0,index-200),index);
  const currentHeat=heatRow ?? heatMap.get(`${date.slice(0,4)}-${Number(String(issue).slice(-3))}`);
  const matrixRow=live?matrix.matrix22:matrixMap.get(date);
  const numbers=(matrixRow?.numbers??[]).map(x=>String(x.number??x));
  const features=Array.from({length:10},(_,digit)=>{
    const freq=n=>previous.slice(-n).filter(r=>contains(r.draw,digit)).length/Math.min(n,previous.length);
    let omission=0;for(let j=index-1;j>=0&&!contains(draws[j].draw,digit);j--)omission++;
    const support=name=>{const r=expertRecommendation(name,issue,live);return r?(Number(contains(r.pool5,digit))+Number(contains(r.pool6,digit))+Number(contains(r.pool7,digit))+Number(Number(r.dan)===digit))/4:0;};
    const rank=(currentHeat?.rankings?.at(-1)??[]).indexOf(digit);
    return [freq(20),freq(60),freq(200),Math.min(omission,30)/30,support('data'),support('v2-data'),support('v5-data'),Number(contains(expertRecommendation('kill3-data',issue,live)?.kills,digit)),positionSupport('position7-data',issue,digit,live),positionSupport('meta-position-data',issue,digit,live),support('v9-data'),support('v9-2-data'),rank<0?0:(9-rank)/9,numbers.length?numbers.filter(n=>contains(n,digit)).length/numbers.length:0];
  });
  const result = triples.map((triple,t)=>{
    const f=features[Number(triple[0])].map((_,k)=>[...triple].reduce((v,d)=>v+features[Number(d)][k],0)/3);
    for(const n of [60,200]){let successes=0;const start=Math.max(0,index-n);for(let j=start;j<index;j++)successes+=Number(!(masks[j]&tripleMasks[t]));f.push(successes/(index-start));}
    return f;
  });
  result.digitFeatures = features;
  return result;
}
let seed=835496;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const candidates=[];
for(let k=0;k<featureNames.length;k++){const w=Array(featureNames.length).fill(0);w[k]=k>=14?-1:1;candidates.push(w);}
const searchCount = Number(process.env.KILL3_SEARCH_COUNT ?? 100000);
for(let a=0;a<featureNames.length;a++)for(let b=a+1;b<featureNames.length;b++)for(const blend of [-2,-1,-.5,.5,1,2]) {
  const w=Array(featureNames.length).fill(0);w[a]=1;w[b]=blend;candidates.push(w);
}
while(candidates.length<searchCount)candidates.push(featureNames.map((_,k)=>random()<.3?0:(random()-.5)*(k<3||k>=14?2:1)));
const pick=(features,weights)=>{
  const ds=features.digitFeatures.map(f=>{let s=0;for(let k=0;k<14;k++)s+=f[k]*weights[k];return s;});
  let best=0,bestScore=Infinity;
  for(let t=0;t<triples.length;t++){const triple=triples[t];const score=(ds[Number(triple[0])]+ds[Number(triple[1])]+ds[Number(triple[2])])/3+features[t][14]*weights[14]+features[t][15]*weights[15];if(score<bestScore){bestScore=score;best=t;}}
  return best;
};
function metric(rows){let hits=0,streak=0,maxMiss=0;for(const r of rows){if(r.hit){hits++;streak=0;}else{streak++;maxMiss=Math.max(maxMiss,streak);}}return{count:rows.length,hits,rate:rows.length?hits/rows.length:0,maxMiss,currentMiss:streak};}
const start=Math.max(200,draws.length-730), split=draws.length-100;
const frames=[];
for(let i=start;i<draws.length;i++){const row=draws[i];frames.push({index:i,features:featureRows(i,row.issue,row.date)});}
// Candidate selection uses only the segment before the final 100 draws.
let cached=null;
if(process.env.KILL3_RESEARCH!=='1')try{cached=await read(`pages/${prefix}matrix-kill3-data.json`);if(cached.candidateCount!==searchCount||!cached.staticSelection||!cached.policyCandidateCount)cached=null;}catch{}
const results=cached?[cached.staticSelection]:candidates.map((weights,id)=>{
  const history=frames.filter(frame=>frame.index<split).map(frame=>{const t=pick(frame.features,weights);return{hit:!(masks[frame.index]&tripleMasks[t])};});
  return{id,weights,...metric(history)};
}).sort((a,b)=>b.rate-a.rate||a.maxMiss-b.maxMiss||a.id-b.id);
const selected=results[0];
const finalists=cached?[selected,...[cached.bestPolicy?.baseId,cached.bestPolicy?.guardId,cached.policy?.baseId,cached.policy?.guardId].filter(id=>id!=null).map(id=>({id,weights:id===cached.bestPolicy?.baseId?(cached.bestPolicy.baseWeights??candidates[id]):id===cached.bestPolicy?.guardId?(cached.bestPolicy.guardWeights??candidates[id]):candidates[id]}))]:results.slice(0,32);
const predictions=new Map(finalists.map(r=>[r.id,frames.map(frame=>pick(frame.features,r.weights))]));
const policies=cached?[cached.bestPolicy??cached.policy].filter(Boolean):[];
if(!cached)for(const base of finalists.slice(0,16))for(const guard of finalists)if(base.id!==guard.id)for(const threshold of [1,2,3,5]) {
  let miss=0;const sample=[];
  for(let n=0;n<frames.length&&frames[n].index<split;n++){
    const active=miss>=threshold?guard:base;
    const t=predictions.get(active.id)[n];const hit=!(masks[frames[n].index]&tripleMasks[t]);miss=hit?0:miss+1;sample.push({hit});
  }
  policies.push({baseId:base.id,guardId:guard.id,threshold,...metric(sample)});
}
policies.sort((a,b)=>b.rate-a.rate||a.maxMiss-b.maxMiss||a.baseId-b.baseId||a.guardId-b.guardId||a.threshold-b.threshold);
const bestPolicy=policies[0];
const staticHoldout=metric(frames.filter(f=>f.index>=split).map(frame=>({hit:!(masks[frame.index]&tripleMasks[pick(frame.features,selected.weights)])})));
let policyStreak=0;
const policyRows=frames.map((frame,n)=>{const id=policyStreak>=bestPolicy.threshold?bestPolicy.guardId:bestPolicy.baseId;const hit=!(masks[frame.index]&tripleMasks[predictions.get(id)[n]]);policyStreak=hit?0:policyStreak+1;return{hit,index:frame.index};});
const policyHoldout=metric(policyRows.filter(row=>row.index>=split));
const usePolicy=cached?.modelFrozen?Boolean(cached.policy):policyHoldout.rate>staticHoldout.rate||(policyHoldout.rate===staticHoldout.rate&&policyHoldout.maxMiss<staticHoldout.maxMiss);
const policy=usePolicy?bestPolicy:null;
let streak=0;
const history=frames.map((frame,n)=>{const row=draws[frame.index];const activeId=policy?(streak>=policy.threshold?policy.guardId:policy.baseId):selected.id;const t=policy?predictions.get(activeId)[n]:pick(frame.features,selected.weights);const hit=!(masks[frame.index]&tripleMasks[t]);streak=hit?0:streak+1;return{issue:row.issue,date:row.date,draw:row.draw,kills:triples[t],hit,missStreak:streak,activeId,phase:frame.index<split?'selection':'holdout'};});
const latest=draws.at(-1),targetIssue=String(matrix.matrix22.targetIssue);
const targetHeat=(heat.preDrawSnapshots??[]).findLast(row=>String(Number(row.issue))===String(Number(targetIssue.slice(-3)))&&row.date>latest.date&&/^20:(2\d|[3-5]\d)$/.test(String(row.capturedAtBeijing??'').slice(11,16)));
const outputFile=`${prefix}matrix-kill3-data.json`;
let previous=null;try{previous=await read(`pages/${outputFile}`);}catch{}
const forward=[...(previous?.forwardHistory??[])];
const old=previous?.recommendation;
if(old){const actual=draws.find(r=>String(r.issue)===String(old.targetIssue));if(actual&&!forward.some(r=>String(r.issue)===String(actual.issue))){forward.push({issue:actual.issue,date:actual.date,draw:actual.draw,kills:old.kills,hit:!(mask(actual.draw)&mask(old.kills)),phase:'forward'});}}
let fs=0;for(const row of forward){fs=row.hit?0:fs+1;row.missStreak=fs;}
const activeWeights=policy?finalists.find(r=>r.id===(streak>=policy.threshold?policy.guardId:policy.baseId)).weights:selected.weights;
const recommendation=previous?.recommendation?.targetIssue===targetIssue?previous.recommendation:targetHeat?{targetIssue,basedOnIssue:latest.issue,heatCapturedAt:targetHeat.capturedAtBeijing,kills:triples[pick(featureRows(draws.length,targetIssue,targetHeat.date??latest.date,true,targetHeat),activeWeights)],weights:activeWeights,policy}:null;
const output={generatedAt:new Date().toISOString(),game,targetIssue,basedOnIssue:latest.issue,sourceUpdatedThrough:`${latest.date} · 第${latest.issue}期`,dataSha256:source.canonicalSha256,modelVersion:'MATRIX-KILL3-1',definition:'开奖号三个位置均未出现这3个数字才算成功；出现任意一个即算失败。',theoreticalRate:.343,candidateCount:candidates.length,featureNames,selected,selectionStart:draws[start].date,selectionEnd:draws[split-1].date,holdoutStart:draws[split].date,notice:'近730期研究：前630期选方案，后100期留出评估。上游专家包含历史选模结果，历史热度没有逐期20:20原始时间戳，所以此处不能称作完整独立盲测。真实前瞻从本模块开奖前锁定后累计。',recommendation,history,forwardHistory:forward,metrics:{selection:metric(history.filter(r=>r.phase==='selection')),holdout:metric(history.filter(r=>r.phase==='holdout')),recentYear:metric(history.slice(-365)),forward:metric(forward)},windows:Object.fromEntries([30,100,300,500].map(n=>[n,metric(history.slice(-n))])),comparison:results.slice(0,10).map(({weights,...r})=>r)};
output.notice='近730期历史研究，前630期搜索权重与连断切换策略，后100期用于比较并选择本版方案。上游专家包含历史选模，部分历史热度没有20:20原始时间戳；这些数字属于历史研究，不能作为完整独立盲测。真实前瞻从本模块开奖前锁定后累计。';
output.modelFrozen=true;
output.modelSelectedThrough=cached?.modelSelectedThrough??latest.date;
if(cached?.modelFrozen){output.selectionStart=cached.selectionStart;output.selectionEnd=cached.selectionEnd;output.holdoutStart=cached.holdoutStart;}
output.bestPolicy={...bestPolicy,baseWeights:finalists.find(r=>r.id===bestPolicy.baseId).weights,guardWeights:finalists.find(r=>r.id===bestPolicy.guardId).weights};
output.policyHoldout=policyHoldout;
output.policy=policy;
output.policyCandidateCount=cached?.policyCandidateCount??policies.length;
output.staticSelection=selected;
output.staticHoldout=staticHoldout;
for(const base of ['pages','public'])await writeFile(path.join(root,base,outputFile),JSON.stringify(output)+'\n');
console.log(JSON.stringify({game,candidates:candidates.length,selected:selected.id,policy,staticHoldout:output.staticHoldout,metrics:output.metrics,status:recommendation?'locked':'waiting for heat'}));
