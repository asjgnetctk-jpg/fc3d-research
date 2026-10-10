import test from 'node:test';
import assert from 'node:assert/strict';
import {DynamicKill3} from '../scripts/matrix-kill3-dynamic-core.mjs';
const config={halfLife:90,prior:30,gain:1,jointBlend:.1};
const channels=[{id:'V2:pool5',family:'V2',state:'断3|弱',position:null,members:Array.from({length:10},(_,d)=>d<5)}];
test('current and future answers do not enter prediction',()=>{
  const a=new DynamicKill3(config),b=new DynamicKill3(config);
  for(const draw of ['123','456','789','000']){a.predict(channels);b.predict(channels);a.observe(channels,draw);b.observe(channels,draw);}
  assert.deepEqual(a.predict(channels),b.predict(channels));
  assert.deepEqual(a.predict(channels.map(c=>({...c,draw:'000'}))),b.predict(channels.map(c=>({...c,draw:'999'}))));
  const before=a.predict(channels);
  a.observe(channels,'123');
  assert.notDeepEqual(a.predict(channels).probabilities,before.probabilities);
});
test('missing expert contributes no evidence; probabilities remain normalized',()=>{
  const model=new DynamicKill3(config);
  const r=model.predict([]);
  assert.equal(new Set(r.kills).size,3);
  for(const p of r.probabilities)assert.ok(Math.abs(p.reduce((a,b)=>a+b,0)-1)<1e-12);
});
