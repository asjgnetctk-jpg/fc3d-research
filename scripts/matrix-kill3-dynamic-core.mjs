export const combinations = [];
for (let a=0;a<8;a++) for(let b=a+1;b<9;b++) for(let c=b+1;c<10;c++) combinations.push(`${a}${b}${c}`);
export const metric = rows => {
  let hits=0,miss=0,maxMiss=0;
  for(const r of rows){hits+=Number(r.hit);miss=r.hit?0:miss+1;maxMiss=Math.max(maxMiss,miss);}
  return {count:rows.length,hits,rate:rows.length?hits/rows.length:0,maxMiss,currentMiss:miss};
};
export class DynamicKill3 {
  constructor(config){this.config=config;this.cells=new Map();this.step=0;this.positionCounts=Array.from({length:3},()=>Array(10).fill(10));this.jointCounts=Array(120).fill(0);this.jointTrials=0;}
  cell(key){const c=this.cells.get(key);if(!c)return{n:0,h:0};const decay=2**(-(this.step-c.t)/this.config.halfLife);return{n:c.n*decay,h:c.h*decay};}
  predict(channels){
    const logs=this.positionCounts.map(counts=>{const sum=counts.reduce((a,b)=>a+b,0);return counts.map(v=>Math.log(v/sum));});
    const effects=[];
    for(let p=0;p<3;p++){
      const families=new Map();
      for(const channel of channels){
        if(channel.position!=null&&channel.position!==p)continue;
        const values=channel.members.map((member,digit)=>{
          const cell=this.cell(`${channel.id}|${channel.state}|${Number(member)}|${p}`);
          const probability=(cell.h+this.config.prior*.1)/(cell.n+this.config.prior);
          return Math.log(Math.max(.005,probability)/.1);
        });
        const family=families.get(channel.family)??[];family.push(values);families.set(channel.family,family);
        if(p===0||channel.position===p)effects.push({id:channel.id,state:channel.state,priorHitRate:channel.priorHitRate,hitStreak:channel.hitStreak,missStreak:channel.missStreak,maxMiss:channel.maxMiss,missRatio:channel.missRatio,sampleCount:channel.sampleCount});
      }
      for(const group of families.values())for(let d=0;d<10;d++)logs[p][d]+=this.config.gain*group.reduce((s,v)=>s+v[d],0)/group.length;
    }
    const probabilities=logs.map(values=>{const max=Math.max(...values),exps=values.map(v=>Math.exp(v-max)),sum=exps.reduce((a,b)=>a+b,0);return exps.map(v=>v/sum);});
    let best=0,score=-Infinity;
    combinations.forEach((kills,k)=>{
      const positional=probabilities.reduce((v,ps)=>v*Math.max(.001,1-[...kills].reduce((sum,d)=>sum+ps[Number(d)],0)),1);
      const joint=(this.jointCounts[k]+this.config.prior*.343)/(this.jointTrials+this.config.prior);
      const value=(1-this.config.jointBlend)*Math.log(positional)+this.config.jointBlend*Math.log(joint);
      if(value>score){score=value;best=k;}
    });
    return{kills:combinations[best],probabilities,channelStates:effects};
  }
  // The current result enters only here, after predict() has returned.
  observe(channels,draw){
    const digits=[...draw].map(Number),decay=2**(-1/this.config.halfLife);
    for(const channel of channels)for(let p=0;p<3;p++){
      if(channel.position!=null&&channel.position!==p)continue;
      for(let d=0;d<10;d++){
        const key=`${channel.id}|${channel.state}|${Number(channel.members[d])}|${p}`,cell=this.cell(key);
        this.cells.set(key,{n:cell.n+1,h:cell.h+Number(digits[p]===d),t:this.step});
      }
    }
    this.positionCounts.forEach((counts,p)=>counts.forEach((v,d)=>{counts[d]=v*decay+Number(digits[p]===d);}));
    combinations.forEach((kills,k)=>{this.jointCounts[k]=this.jointCounts[k]*decay+Number([...draw].every(d=>!kills.includes(d)));});
    this.jointTrials=this.jointTrials*decay+1;this.step++;
  }
}
