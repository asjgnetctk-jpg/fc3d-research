import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
for(const prefix of ['', 'pl3-'])test(`${prefix || 'fc3d-'}matrix kill3 statistics and cutoff`,async()=>{
  const d=JSON.parse(await readFile(new URL(`../pages/${prefix}matrix-kill3-data.json`,import.meta.url)));
  assert.ok(d.selectionEnd<d.holdoutStart);
  let misses=0;
  for(const r of d.history){
    assert.match(r.kills,/^\d{3}$/);
    assert.equal(new Set(r.kills).size,3);
    const hit=[...r.draw].every(digit=>!r.kills.includes(digit));
    assert.equal(r.hit,hit,`${r.issue}: outcome`);
    misses=hit?0:misses+1;
    assert.equal(r.missStreak,misses,`${r.issue}: streak`);
  }
  for(const [name,rows] of [['selection',d.history.filter(r=>r.phase==='selection')],['holdout',d.history.filter(r=>r.phase==='holdout')],['recentYear',d.history.slice(-365)]]){
    assert.equal(d.metrics[name].count,rows.length);
    assert.equal(d.metrics[name].hits,rows.filter(r=>r.hit).length);
    assert.equal(d.metrics[name].rate,d.metrics[name].hits/rows.length);
  }
  assert.equal(d.metrics.holdout.count,100);
  if(d.recommendation){assert.equal(d.recommendation.targetIssue,d.targetIssue);assert.equal(d.recommendation.basedOnIssue,d.basedOnIssue);}
});
