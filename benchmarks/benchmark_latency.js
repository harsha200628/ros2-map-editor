/**
 * benchmark_latency.js
 * ====================
 * Reproduces Table II of the companion paper.
 *
 * Measures execution latency (n=30 runs) for four algorithm pipelines:
 *   1. File Load & Parse (PGM parser)
 *   2. Noise Filter (class-aware majority-vote)
 *   3. A* Query (inflation-aware path search, random start/goal pair)
 *   4. ICP Fusion (25 iterations, two synthetic maps)
 *
 * These are reimplementations of the browser JS functions extracted into
 * a pure Node.js context (no DOM/Canvas required).
 *
 * Run:  node benchmark_latency.js
 * Requires: Node.js >= 18  (uses fs/perf_hooks; no npm install needed)
 *
 * Output: results/latency_results.csv
 */

'use strict';

const fs        = require('fs');
const path      = require('path');
const { performance } = require('perf_hooks');

const MAPS = [
  { label: '512px',  file: 'maps/small_512.pgm'   },
  { label: '1024px', file: 'maps/medium_1024.pgm'  },
  { label: '2048px', file: 'maps/large_2048.pgm'   },
];
const N_RUNS = 30;

// ─── Seeded LCG PRNG ─────────────────────────────────────────────────────────
function makePRNG(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000; };
}
const rand = makePRNG(42);

// ─── PGM Parser (mirrors parsePGM in script.js) ──────────────────────────────
function parsePGM(buf) {
  const b   = new Uint8Array(buf);
  let p     = 0;
  const ws  = c => c===0x20||c===0x09||c===0x0a||c===0x0d;
  const dig = c => c>=0x30&&c<=0x39;
  function skipWC() {
    for(;;) {
      while(p<b.length&&ws(b[p])) p++;
      if(p<b.length&&b[p]===0x23){ while(p<b.length&&b[p]!==0x0a) p++; }
      else break;
    }
  }
  function token() { skipWC(); let s=''; while(p<b.length&&!ws(b[p])) s+=String.fromCharCode(b[p++]); return s; }
  function readInt() { skipWC(); let n=0; while(p<b.length&&dig(b[p])) n=n*10+(b[p++]-0x30); return n; }
  const magic = token();
  const W = readInt(), H = readInt(), MV = readInt();
  const pixels = new Uint8Array(W*H);
  if(magic==='P5') {
    if(ws(b[p])) p++;
    for(let i=0;i<W*H;i++) pixels[i]=MV===255?b[p++]:Math.round(b[p++]*255/MV);
  } else {
    for(let i=0;i<W*H;i++) pixels[i]=Math.round(readInt()*255/MV);
  }
  return {width:W,height:H,pixels};
}

// ─── Majority-vote noise filter (mirrors applyMedianFilter in script.js) ─────
function majorityFilter(pixels, W, H) {
  const src = new Uint8Array(pixels);
  const dst = new Uint8Array(pixels);
  for(let y=1;y<H-1;y++) for(let x=1;x<W-1;x++) {
    const idx = y*W+x;
    if(src[idx]===205) continue;
    let c254=0, c0=0;
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
      if(!dy&&!dx) continue;
      const v=src[(y+dy)*W+(x+dx)];
      if(v===254) c254++; else if(v===0) c0++;
    }
    if(src[idx]===0&&c254>=5) dst[idx]=254;
    else if(src[idx]===254&&c0>=5) dst[idx]=0;
  }
  return dst;
}

// ─── BFS distance transform (mirrors recomputeInflation in script.js) ────────
function distTransform(pixels, W, H, radiusPx) {
  const dist = new Float32Array(W*H).fill(1e9);
  const q=[]; let head=0;
  for(let i=0;i<pixels.length;i++) if(pixels[i]===0){dist[i]=0;q.push(i);}
  while(head<q.length) {
    const idx=q[head++];
    const y=(idx/W)|0, x=idx%W, d=dist[idx];
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
      if(!dy&&!dx) continue;
      const nx=x+dx,ny=y+dy;
      if(nx<0||nx>=W||ny<0||ny>=H) continue;
      const nd=d+(dx&&dy?Math.SQRT2:1);
      if(nd<dist[ny*W+nx]) { dist[ny*W+nx]=nd; if(nd<=radiusPx) q.push(ny*W+nx); }
    }
  }
  return dist;
}

// ─── MinHeap (mirrors MinHeap class in script.js) ────────────────────────────
class MinHeap {
  constructor() { this._h=[]; }
  push(item) { this._h.push(item); this._up(this._h.length-1); }
  pop() { const t=this._h[0]; const l=this._h.pop(); if(this._h.length){this._h[0]=l;this._down(0);} return t; }
  isEmpty() { return this._h.length===0; }
  _up(i) { while(i>0){const p=(i-1)>>1;if(this._h[p].f<=this._h[i].f)break;[this._h[p],this._h[i]]=[this._h[i],this._h[p]];i=p;} }
  _down(i) { for(;;){let m=i,l=2*i+1,r=2*i+2;if(l<this._h.length&&this._h[l].f<this._h[m].f)m=l;if(r<this._h.length&&this._h[r].f<this._h[m].f)m=r;if(m===i)break;[this._h[m],this._h[i]]=[this._h[i],this._h[m]];i=m;} }
}

// ─── A* (mirrors computeAStarPath in script.js, abbreviated) ─────────────────
function runAstar(grid, W, H, start, goal, dist, inflRpx) {
  const startIdx=start.y*W+start.x, goalIdx=goal.y*W+goal.x;
  if(grid[startIdx]===0||grid[goalIdx]===0) return false;
  const INF=1e30;
  const g=new Float32Array(W*H).fill(INF);
  const closed=new Uint8Array(W*H);
  const h=(x,y)=>Math.hypot(x-goal.x,y-goal.y);
  g[startIdx]=0;
  const open=new MinHeap(); open.push({idx:startIdx,f:h(start.x,start.y)});
  const DIRS=[[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,1.414],[-1,1,1.414],[1,-1,1.414],[-1,-1,1.414]];
  while(!open.isEmpty()) {
    const {idx:ci}=open.pop();
    if(closed[ci]) continue; closed[ci]=1;
    if(ci===goalIdx) return true;
    const cy=(ci/W)|0, cx=ci%W;
    for(const [dx,dy,w] of DIRS) {
      const nx=cx+dx,ny=cy+dy;
      if(nx<0||nx>=W||ny<0||ny>=H) continue;
      const ni=ny*W+nx;
      if(closed[ni]||grid[ni]===0) continue;
      const d2w=dist?dist[ni]:1e9;
      let pen=0;
      if(d2w<1) pen=200; else if(d2w<=inflRpx) pen=100/d2w; else pen=5/(d2w-inflRpx+1);
      const tg=g[ci]+w+pen+(grid[ni]===205?10:0);
      if(tg<g[ni]) { g[ni]=tg; open.push({idx:ni,f:tg+h(nx,ny)}); }
    }
  }
  return false;
}

// ─── ICP (mirrors autoAlignMerge in script.js) ───────────────────────────────
function runICP(srcPts, tgtPts) {
  const CELL=15, cellOf=p=>({cx:Math.floor(p.x/CELL),cy:Math.floor(p.y/CELL)});
  const hash={};
  tgtPts.forEach(p=>{ const {cx,cy}=cellOf(p); const k=cx+','+cy; (hash[k]||(hash[k]=[])).push(p); });
  const near=(p)=>{
    const {cx,cy}=cellOf(p); let bd=1e18,bp=null;
    for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) {
      (hash[(cx+dx)+','+(cy+dy)]||[]).forEach(q=>{const d=(p.x-q.x)**2+(p.y-q.y)**2;if(d<bd){bd=d;bp=q;}});
    }
    return bp;
  };
  let [tx,ty,rot]=[0,0,0];
  for(let iter=0;iter<25;iter++) {
    const c=Math.cos(rot),s=Math.sin(rot);
    const matchSrc=[],matchDst=[];
    srcPts.forEach(p=>{
      const tp={x:p.x*c-p.y*s+tx,y:p.x*s+p.y*c+ty};
      const nn=near(tp); if(nn){matchSrc.push(tp);matchDst.push(nn);}
    });
    if(matchSrc.length<10) break;
    const n=matchSrc.length;
    const csx=matchSrc.reduce((a,p)=>a+p.x,0)/n, csy=matchSrc.reduce((a,p)=>a+p.y,0)/n;
    const cdx=matchDst.reduce((a,p)=>a+p.x,0)/n, cdy=matchDst.reduce((a,p)=>a+p.y,0)/n;
    let a00=0,a01=0,a10=0,a11=0;
    for(let i=0;i<n;i++){
      const sx=matchSrc[i].x-csx,sy=matchSrc[i].y-csy,dx=matchDst[i].x-cdx,dy=matchDst[i].y-cdy;
      a00+=dx*sx;a01+=dx*sy;a10+=dy*sx;a11+=dy*sy;
    }
    rot=Math.atan2(a10-a01,a00+a11);
    tx=cdx-(csx*Math.cos(rot)-csy*Math.sin(rot));
    ty=cdy-(csx*Math.sin(rot)+csy*Math.cos(rot));
  }
}

// ─── Timing helper ───────────────────────────────────────────────────────────
function timeMs(fn) { const t=performance.now(); fn(); return performance.now()-t; }

function stats(arr) {
  const mean=arr.reduce((a,b)=>a+b,0)/arr.length;
  const std=Math.sqrt(arr.reduce((a,b)=>a+(b-mean)**2,0)/(arr.length-1));
  return {mean:+mean.toFixed(1), std:+std.toFixed(1)};
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const results = [];
console.log(['Operation'.padEnd(20), '512px'.padStart(14), '1024px'.padStart(14), '2048px'.padStart(14)].join(''));
console.log('-'.repeat(64));

for(const mapCfg of MAPS) {
  if(!fs.existsSync(mapCfg.file)) {
    console.error(`${mapCfg.file} not found — run generate_synthetic_maps.py first`);
    process.exit(1);
  }
}

// Pre-load raw buffers
const rawBufs = MAPS.map(m=>fs.readFileSync(m.file).buffer);

const ops = ['File Load & Parse','Noise Filter','A* Query','ICP Fusion (25 iters)'];
const mapStats = MAPS.map(()=>({}));

// File Load & Parse
MAPS.forEach((m,mi)=>{
  const times=[]; for(let r=0;r<N_RUNS;r++) times.push(timeMs(()=>parsePGM(rawBufs[mi])));
  mapStats[mi]['File Load & Parse']=stats(times);
});

// Noise Filter
MAPS.forEach((m,mi)=>{
  const {width:W,height:H,pixels}=parsePGM(rawBufs[mi]);
  const times=[]; for(let r=0;r<N_RUNS;r++) times.push(timeMs(()=>majorityFilter(pixels,W,H)));
  mapStats[mi]['Noise Filter']=stats(times);
});

// A* Query (with inflation enabled, random start/goal)
MAPS.forEach((m,mi)=>{
  const {width:W,height:H,pixels}=parsePGM(rawBufs[mi]);
  const inflRpx=4; // ~0.2m / 0.05m/px
  const dist=distTransform(pixels,W,H,inflRpx);
  // Pick a deterministic free start and goal
  const free=[]; for(let i=0;i<pixels.length;i++) if(pixels[i]===254) free.push(i);
  const si=free[Math.floor(rand()*free.length)], gi=free[Math.floor(rand()*free.length)];
  const start={x:si%W,y:(si/W)|0}, goal={x:gi%W,y:(gi/W)|0};
  const times=[]; for(let r=0;r<N_RUNS;r++) times.push(timeMs(()=>runAstar(pixels,W,H,start,goal,dist,inflRpx)));
  mapStats[mi]['A* Query']=stats(times);
});

// ICP Fusion
MAPS.forEach((m,mi)=>{
  const {width:W,height:H,pixels}=parsePGM(rawBufs[mi]);
  const wallPts=[]; for(let y=0;y<H;y+=3) for(let x=0;x<W;x+=3) if(pixels[y*W+x]===0) wallPts.push({x,y});
  const times=[]; for(let r=0;r<N_RUNS;r++) times.push(timeMs(()=>runICP(wallPts,wallPts)));
  mapStats[mi]['ICP Fusion (25 iters)']=stats(times);
});

// Print table and collect CSV rows
ops.forEach(op=>{
  const row={operation:op};
  const line=[op.padEnd(20)];
  MAPS.forEach((m,mi)=>{
    const {mean,std}=mapStats[mi][op];
    line.push((`${mean}±${std}ms`).padStart(14));
    row[m.label]=`${mean}±${std}`;
  });
  console.log(line.join(''));
  results.push(row);
});

// Write CSV
fs.mkdirSync('results',{recursive:true});
const header='operation,512px,1024px,2048px\n';
const body=results.map(r=>`${r.operation},${r['512px']},${r['1024px']},${r['2048px']}`).join('\n');
fs.writeFileSync('results/latency_results.csv',header+body+'\n');
console.log('\nResults written to results/latency_results.csv');
