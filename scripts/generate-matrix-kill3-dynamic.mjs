import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DynamicKill3,metric} from './matrix-kill3-dynamic-core.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const game=process.env.LOTTERY_GAME==='pl3'?'pl3':'fc3d',prefix=game==='pl3'?'pl3-':'';
const read=async file=>JSON.parse(await readFile(path.join(root,file),'utf8'));
const source=await read(`scripts/data/${game}-full-history.json`),draws=source.rows;
const heat=await read(`scripts/data/${game}-17500-heat.json`),matrix=await read(`pages/${prefix}heat-data.json`);
const sources={};
for(const name of ['data','v2-data','v5-data','kill3-data','position7-data','joint-position7-data','trust-position7-data','meta-position-data',...(game==='fc3d'?['v9-data','v9-2-data']:[])])sources[name]=await read(`pages/${prefix}${name}.json`);
const descriptors=[];
function add(id,family,kind,records,current,position=null,baseline=.1){descriptors.push({id,family,kind,records:new Map(records.map(r=>[r.date,r.pool])),current,position,baseline});}
for(const [name,data] of Object.entries(sources)){
  const history=data.history??data.rows??[];
  for(const key of ['dan','pool5','pool6','pool7','pool8','kills']){
    const records=history.filter(r=>r[key]!=null).map(r=>({date:r.date,pool:String(r[key])}));
    if(!records.length&&data.recommendation?.[key]==null)continue;
    const size=key==='dan'?1:Number(key.slice(-1)),kind=key==='kills'?'kill':key==='dan'?'dan':'pool';
    add(`${name}:${key}`,name,kind,records,data.recommendation?.[key]==null?null:String(data.recommendation[key]),null,kind==='dan'?.271:kind==='kill'?.343:(size*(size-1)*(size-2)/1000));
  }
  for(const [size,pool] of Object.entries(data.pools??{}))for(const [p,key] of ['hundredsPool','tensPool','unitsPool'].entries()){
    add(`${name}:${size}:${key}`,name,'position',(pool.history??[]).map(r=>({date:r.date,pool:r[key]})),pool.recommendation?.[key]??null,p,Number(size)/10);
  }
}
const heatMap=new Map(heat.rows.map(r=>[r.date,r]));
const matrixMap=new Map([...(matrix.matrix22.replayRows??[]),...(matrix.matrix22.liveRows??[])].map(r=>[r.date,r]));
const states=new Map(descriptors.map(d=>[d.id,{hits:0,misses:0,results:[],count:0}]));
const start=Math.max(0,draws.length-1100),evaluationStart=draws.length-730,split=draws.length-100;
const frames=[];
const stateKey=(s,base)=>{
  const rate=s.results.length?s.results.filter(Boolean).length/s.results.length:base;
  const streak=s.misses?`断${Math.min(5,s.misses)}`:`中${Math.min(3,s.hits)}`;
  return `${streak}|${rate<base-.05?'弱':rate>base+.05?'强':'平'}`;
};
function buildChannels(index,date,live=false,heatRow=null){
  const channels=[],present=[];
  for(const d of descriptors){
    const pool=live?d.current:d.records.get(date);if(pool==null||pool==='')continue;
    const s=states.get(d.id),rate=s.results.length?s.results.filter(Boolean).length/s.results.length:d.baseline;
    channels.push({id:d.id,family:d.family,position:d.position,state:stateKey(s,d.baseline),members:Array.from({length:10},(_,digit)=>String(pool).includes(String(digit))),priorHitRate:rate,hitStreak:s.hits,missStreak:s.misses,sampleCount:s.count});present.push({d,pool});
  }
  const ranks=(heatRow??heatMap.get(date))?.rankings;
  if(ranks)for(let p=0;p<3;p++)channels.push({id:`heat:${p}`,family:'heat',position:p,state:'排名',members:Array.from({length:10},(_,digit)=>ranks[p]?.slice(0,3).includes(digit)??false)});
  const matrixRow=live?matrix.matrix22:matrixMap.get(date),numbers=(matrixRow?.numbers??[]).map(n=>String(n.number??n));
  if(numbers.length)for(let p=0;p<3;p++){
    const counts=Array.from({length:10},(_,d)=>numbers.filter(n=>Number(n[p])===d).length);
    const ranked=counts.map((n,d)=>({n,d})).sort((a,b)=>b.n-a.n||a.d-b.d).slice(0,3).map(x=>x.d);
    channels.push({id:`matrix22:${p}`,family:'matrix22',position:p,state:'投票',members:Array.from({length:10},(_,d)=>ranked.includes(d))});
  }
  const coverage=live?matrix.matrix22Coverage:(matrix.matrix22Coverage?.replayRows??[]).find(r=>r.date===date);
  const groups=(coverage?.numbers??[]).map(n=>String(n.number??n));
  if(groups.length){
    const counts=Array.from({length:10},(_,d)=>groups.filter(n=>n.includes(String(d))).length);
    const ranked=counts.map((n,d)=>({n,d})).sort((a,b)=>b.n-a.n||a.d-b.d).slice(0,3).map(x=>x.d);
    channels.push({id:'matrixCoverage',family:'matrixCoverage',position:null,state:'组选投票',members:Array.from({length:10},(_,d)=>ranked.includes(d))});
  }
  for(let p=0;p<3;p++){
    const freq=Array(10).fill(0),omission=Array(10).fill(0);
    for(let j=Math.max(0,index-60);j<index;j++)freq[Number(draws[j].draw[p])]++;
    for(let d=0;d<10;d++)for(let j=index-1;j>=0&&Number(draws[j].draw[p])!==d;j--)omission[d]++;
    for(const [name,values] of [['冷热',freq],['遗漏',omission]]){
      const ranked=values.map((n,d)=>({n,d})).sort((a,b)=>b.n-a.n||a.d-b.d).slice(0,3).map(x=>x.d);
      channels.push({id:`${name}:${p}`,family:name,position:p,state:'排序',members:Array.from({length:10},(_,d)=>ranked.includes(d))});
    }
  }
  return{channels,present};
}
function observeStates(present,draw){
  for(const {d,pool} of present){
    const hit=d.kind==='position'?pool.includes(draw[d.position]):d.kind==='kill'?[...draw].every(v=>!pool.includes(v)):d.kind==='dan'?draw.includes(pool):new Set(draw).size===3&&[...draw].every(v=>pool.includes(v));
    const s=states.get(d.id);s.hits=hit?s.hits+1:0;s.misses=hit?0:s.misses+1;s.results.push(hit);if(s.results.length>30)s.results.shift();s.count++;
  }
}
for(let index=start;index<draws.length;index++){
  const row=draws[index],input=buildChannels(index,row.date);
  frames.push({index,issue:row.issue,date:row.date,channels:input.channels,draw:row.draw});
  observeStates(input.present,row.draw);
}
const configs=[];
for(const halfLife of [30,90])for(const prior of [30,100])for(const gain of [.5,1])for(const jointBlend of [.1,.35])configs.push({halfLife,prior,gain,jointBlend});
let locked=null;if(process.env.KILL3_DYNAMIC_RESEARCH!=='1')try{locked=await read(`pages/${prefix}matrix-kill3-dynamic-data.json`);if(locked.modelVersion!=='MATRIX-KILL3-DYNAMIC-1')locked=null;}catch{}
const runs=(locked?[locked.config]:configs).map(config=>{
  const engine=new DynamicKill3(config),history=[];let miss=0;
  for(const frame of frames){
    const prediction=engine.predict(frame.channels);
    const hit=[...frame.draw].every(d=>!prediction.kills.includes(d));miss=hit?0:miss+1;
    if(frame.index>=evaluationStart)history.push({issue:frame.issue,date:frame.date,draw:frame.draw,kills:prediction.kills,hit,missStreak:miss,phase:frame.index<split?'selection':'sequential-replay'});
    engine.observe(frame.channels,frame.draw);
  }
  return{config,engine,history,selection:metric(history.filter(r=>r.phase==='selection'))};
}).sort((a,b)=>b.selection.rate-a.selection.rate||a.selection.maxMiss-b.selection.maxMiss);
const winner=runs[0],latest=draws.at(-1),targetIssue=String(matrix.matrix22.targetIssue);
const targetHeat=(heat.preDrawSnapshots??[]).findLast(r=>String(Number(r.issue))===String(Number(targetIssue.slice(-3)))&&r.date>latest.date&&/^20:(2\d|[3-5]\d)$/.test(String(r.capturedAtBeijing??'').slice(11,16)));
const forward=[...(locked?.forwardHistory??[])];
if(locked?.recommendation){const old=locked.recommendation,actual=draws.find(r=>String(r.issue)===String(old.targetIssue));if(actual&&!forward.some(r=>String(r.issue)===String(actual.issue)))forward.push({issue:actual.issue,date:actual.date,draw:actual.draw,kills:old.kills,hit:[...actual.draw].every(v=>!old.kills.includes(v)),phase:'forward'});}
let fm=0;for(const r of forward){fm=r.hit?0:fm+1;r.missStreak=fm;}
const current=buildChannels(draws.length,targetHeat?.date??latest.date,true,targetHeat);
const recommendation=locked?.recommendation?.targetIssue===targetIssue?locked.recommendation:targetHeat?{targetIssue,basedOnIssue:latest.issue,heatCapturedAt:targetHeat.capturedAtBeijing,...winner.engine.predict(current.channels)}:null;
const output={generatedAt:new Date().toISOString(),game,modelVersion:'MATRIX-KILL3-DYNAMIC-1',modelSelectedThrough:locked?.modelSelectedThrough??draws[split-1].date,targetIssue,basedOnIssue:latest.issue,config:winner.config,candidateCount:configs.length,channelCount:descriptors.length,currentChannelStates:current.channels,definition:'3个杀码都未出现在开奖号中才算成功。',theoreticalRate:.343,notice:'分别读取各模型每种玩法的推荐，以及截至上一期的连中连断、近30期表现；学习不同状态下号码出现的频率，缺少证据时降低影响。同模型内多玩法合并控制重复投票。16套平滑参数只在前630期比较，后100期按先推荐后核对再学习的顺序回放。上游历史推荐及热度并非全部具有开奖前存档，所以仍不是完整独立盲测。',recommendation,history:winner.history,forwardHistory:forward,metrics:{selection:winner.selection,holdout:metric(winner.history.filter(r=>r.phase==='sequential-replay')),recentYear:metric(winner.history.slice(-365)),forward:metric(forward)},comparison:runs.map(r=>({config:r.config,selection:r.selection}))};
for(const base of ['pages','public'])await writeFile(path.join(root,base,`${prefix}matrix-kill3-dynamic-data.json`),JSON.stringify(output)+'\n');
console.log(JSON.stringify({game,channels:descriptors.length,config:output.config,metrics:output.metrics}));
