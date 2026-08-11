// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────
const S = {
  pgm:          null,   // {width, height, maxVal, pixels: Uint8Array}
  yamlText:     null,
  origPixels:   null,   // read-only original
  work:         null,   // Uint8Array being edited
  undoStack:    [],
  redoStack:    [],
  tool:         'pan',
  polyMode:     'open',
  polyPts:      [],     // [{x,y}] in image coords
  brush:        3,
  color:        'wall',
  view:         {scale:1, tx:0, ty:0},
  panning:      false,
  drawing:      false,
  panStart:     null,
  lastPt:       null,
  lastMouse:    null,   // canvas coords for polygon preview
  showOrig:     false,
  measureMouse: null,   // canvas coords for live measure preview
  // grid
  showGrid:     false,
  gridSpacingM: 1.0,
  // inflation
  showInflation:false,
  inflRadiusM:  0.2,
  // shapes (rect / circle)
  shapeStart:   null,
  shapeEnd:     null,
  shapeFill:    false,
  // Merge state
  mergePgm:     null,
  mTx:          0,
  mTy:          0,
  mRot:         0,
  mFlipX:       false,
  mFlipY:       false,
  mergeDragging:false,
  // waypoints
  wpDragging:   false,
  wpStart:      null,   // image coords, position of waypoint being placed
  wpEnd:        null,   // image coords, drag point used to derive heading
  // A* state
  astarStart:   null,
  astarEnd:     null,
  astarPath:    null,
};

const THEME = {
  isDark: false,
  labelBg: () => THEME.isDark ? 'rgba(13,17,23,0.88)' : 'rgba(255,255,255,0.92)',
  gridStroke: () => THEME.isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)',
  gridFill: () => THEME.isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.8)',
  scaleBg: () => THEME.isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)',
  scaleStroke: () => THEME.isDark ? '#ddd' : '#475569',
  scaleText: () => THEME.isDark ? '#ddd' : '#0f172a',
};

function toggleTheme() {
  THEME.isDark = !THEME.isDark;
  document.documentElement.setAttribute('data-theme', THEME.isDark ? 'dark' : 'light');
  render();
}

// ─────────────────────────────────────────────────────────────────
// CANVAS SETUP
// ─────────────────────────────────────────────────────────────────
const wrap    = $('canvas-wrap');
const mCanvas = $('main-canvas');
const oCanvas = $('overlay-canvas');
const mCtx    = mCanvas.getContext('2d');
const oCtx    = oCanvas.getContext('2d');
const offC    = document.createElement('canvas');   // image pixels
const offCtx  = offC.getContext('2d');
const inflC   = document.createElement('canvas');   // inflation overlay
const inflCtx = inflC.getContext('2d');
const origC   = document.createElement('canvas');   // original pixels (read-only)
const origCtx = origC.getContext('2d');
const mOffC   = document.createElement('canvas');   // merge map pixels
const mOffCtx = mOffC.getContext('2d');

function resizeCanvases() {
  mCanvas.width = oCanvas.width = wrap.clientWidth;
  mCanvas.height = oCanvas.height = wrap.clientHeight;
  render();
}
window.addEventListener('resize', resizeCanvases);
resizeCanvases();

// ─────────────────────────────────────────────────────────────────
// PGM PARSER  (P5 binary + P2 ASCII)
// ─────────────────────────────────────────────────────────────────
function parsePGM(buf) {
  const b = new Uint8Array(buf);
  let p = 0;

  const ws  = c => c===0x20||c===0x09||c===0x0a||c===0x0d;
  const dig = c => c>=0x30 && c<=0x39;

  function skipWC() {
    for(;;) {
      while(p<b.length && ws(b[p])) p++;
      if(p<b.length && b[p]===0x23) { while(p<b.length && b[p]!==0x0a) p++; }
      else break;
    }
  }
  function token() {
    skipWC();
    let s='';
    while(p<b.length && !ws(b[p])) s+=String.fromCharCode(b[p++]);
    return s;
  }
  function readInt() {
    skipWC();
    let n=0;
    while(p<b.length && dig(b[p])) n=n*10+(b[p++]-0x30);
    return n;
  }

  const magic = token();
  if(magic!=='P5'&&magic!=='P2')
    throw new Error(`Not a PGM file — magic "${magic}" (need P5 or P2)`);

  const W = readInt(), H = readInt(), MV = readInt();
  if(W<=0||H<=0||MV<=0) throw new Error('Invalid PGM header values');

  const pixels = new Uint8Array(W*H);

  if(magic==='P5'){
    // Exactly one whitespace byte separates header from binary data
    if(ws(b[p])) p++;
    const bpp = MV>255?2:1;
    for(let i=0;i<W*H;i++){
      if(bpp===1){
        pixels[i] = MV===255 ? b[p++] : Math.round(b[p++]*255/MV);
      } else {
        const v=(b[p]<<8)|b[p+1]; p+=2;
        pixels[i]=Math.round(v*255/MV);
      }
    }
  } else {
    for(let i=0;i<W*H;i++) pixels[i]=Math.round(readInt()*255/MV);
  }

  return {width:W, height:H, maxVal:Math.min(255,MV), pixels};
}

// ─────────────────────────────────────────────────────────────────
// PGM WRITER  (always P5 8-bit)
// ─────────────────────────────────────────────────────────────────
function writePGM(pixels, W, H) {
  const hdr = new TextEncoder().encode(`P5\n# ROS2 Map Editor\n${W} ${H}\n255\n`);
  const out  = new Uint8Array(hdr.length + pixels.length);
  out.set(hdr); out.set(pixels, hdr.length);
  return out;
}

// ─────────────────────────────────────────────────────────────────
// OFFSCREEN IMAGE DATA
// ─────────────────────────────────────────────────────────────────
function px2rgba(pixels, W, H, isMerge=false) {
  const img = new ImageData(W, H);
  for(let i=0;i<pixels.length;i++){
    img.data[i*4]=img.data[i*4+1]=img.data[i*4+2]=pixels[i];
    img.data[i*4+3]= (isMerge && pixels[i]===205) ? 0 : 255;
  }
  return img;
}

function syncOffscreen() {
  if(!S.pgm) return;
  const {width:W, height:H} = S.pgm;
  offC.width=W; offC.height=H;
  offCtx.putImageData(px2rgba(S.work, W, H), 0, 0);
}

// ─────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────
function render() {
  const W=mCanvas.width, H=mCanvas.height;
  mCtx.clearRect(0,0,W,H);

  if(!S.pgm) return;

  mCtx.save();
  mCtx.translate(S.view.tx, S.view.ty);
  mCtx.scale(S.view.scale, S.view.scale);
  mCtx.imageSmoothingEnabled = false;

  // Draw working map OR original (A/B toggle)
  mCtx.drawImage(S.showOrig ? origC : offC, 0, 0);

  // Inflation overlay
  if(S.showInflation && inflC.width>0){
    mCtx.globalAlpha = 0.75;
    mCtx.imageSmoothingEnabled = false;
    mCtx.drawImage(inflC, 0, 0);
    mCtx.globalAlpha = 1;
  }

  // Grid
  if(S.showGrid) renderGrid(mCtx);

  mCtx.restore();

  // Scale bar (screen-space, always)
  renderScaleBar();

  renderOverlay();
  $('st-zoom').textContent = Math.round(S.view.scale*100)+'%';
}

function renderOverlay() {
  const W=oCanvas.width, H=oCanvas.height;
  oCtx.clearRect(0,0,W,H);

  // Draw merge map if active
  if(S.tool==='merge' && S.mergePgm){
    oCtx.save();
    oCtx.globalAlpha = 0.65;
    oCtx.translate(S.view.tx, S.view.ty);
    oCtx.scale(S.view.scale, S.view.scale);
    oCtx.translate(S.mTx, S.mTy);
    oCtx.rotate(S.mRot * Math.PI / 180);
    oCtx.scale(S.mFlipX?-1:1, S.mFlipY?-1:1);
    oCtx.imageSmoothingEnabled = false;
    oCtx.drawImage(mOffC, -S.mergePgm.width/2, -S.mergePgm.height/2);
    // Draw bounding box for clarity
    oCtx.strokeStyle = '#3b82f6'; oCtx.lineWidth = 2/S.view.scale; oCtx.setLineDash([5/S.view.scale]);
    oCtx.strokeRect(-S.mergePgm.width/2, -S.mergePgm.height/2, S.mergePgm.width, S.mergePgm.height);
    oCtx.restore();
  }

  renderMeasure(); // saved measurements always visible
  renderWaypoints(); // saved waypoints always visible
  renderShapePreview();
  renderAStar(); // A* path preview
  
  if(S.tool!=='polygon' || S.polyPts.length===0) return;

  const pts = S.polyPts.map(p=>i2c(p.x,p.y));

  oCtx.save();
  oCtx.lineCap='round'; oCtx.lineJoin='round';

  // Filled preview for closed mode
  if(S.polyMode==='closed' && pts.length>2 && $('fill-chk').checked){
    oCtx.beginPath();
    oCtx.moveTo(pts[0].x,pts[0].y);
    pts.slice(1).forEach(p=>oCtx.lineTo(p.x,p.y));
    oCtx.closePath();
    oCtx.fillStyle='rgba(56,139,253,0.15)';
    oCtx.fill();
  }

  // Line segments
  oCtx.strokeStyle='#58a6ff'; oCtx.lineWidth=1.5;
  oCtx.setLineDash([5,4]);
  oCtx.beginPath();
  oCtx.moveTo(pts[0].x,pts[0].y);
  pts.slice(1).forEach(p=>oCtx.lineTo(p.x,p.y));
  if(S.polyMode==='closed' && pts.length>2) oCtx.closePath();
  oCtx.stroke();

  // Preview segment to mouse
  if(S.lastMouse && pts.length>0){
    const last=pts[pts.length-1];
    oCtx.setLineDash([3,5]);
    oCtx.strokeStyle='rgba(88,166,255,0.5)';
    oCtx.beginPath();
    oCtx.moveTo(last.x,last.y);
    oCtx.lineTo(S.lastMouse.x,S.lastMouse.y);
    oCtx.stroke();
    // Closing preview
    if(S.polyMode==='closed' && pts.length>=2){
      oCtx.setLineDash([2,6]);
      oCtx.strokeStyle='rgba(88,166,255,0.25)';
      oCtx.beginPath();
      oCtx.moveTo(S.lastMouse.x,S.lastMouse.y);
      oCtx.lineTo(pts[0].x,pts[0].y);
      oCtx.stroke();
    }
  }

  // Dots
  oCtx.setLineDash([]);
  pts.forEach((pt,i)=>{
    const isFirst = i===0;
    oCtx.beginPath();
    oCtx.arc(pt.x,pt.y,5,0,Math.PI*2);
    oCtx.fillStyle = isFirst ? '#ff7b72' : '#58a6ff';
    oCtx.fill();
    oCtx.strokeStyle='#fff'; oCtx.lineWidth=1;
    oCtx.stroke();
    // Number label
    oCtx.fillStyle='#fff'; oCtx.font='bold 10px monospace';
    oCtx.fillText(i+1, pt.x+7, pt.y-5);
  });

  oCtx.restore();

  // Update point counter
  $('poly-count').textContent = S.polyPts.length + ' point' + (S.polyPts.length!==1?'s':'');
  $('st-pts').textContent = S.polyPts.length;
}

// ─────────────────────────────────────────────────────────────────
// MEASURE SYSTEM
// ─────────────────────────────────────────────────────────────────
const MCOLORS=['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'];
const MSR={
  mode:'line',
  active:[],          // points in progress [{x,y} image coords]
  saved:[],           // [{name,type,pts,color,label}]
  nextNum:{line:1,path:1,area:1},
};

function getResolution(){
  if(S.yamlText){
    const m=S.yamlText.match(/resolution\s*:\s*([\d.eE+\-]+)/);
    if(m) return parseFloat(m[1]);
  }
  return null;
}

function fmtDist(px){
  const r=getResolution();
  const pxStr=px.toFixed(1)+' px';
  if(!r) return {main:pxStr, sub:'load YAML for metres'};
  const m=px*r;
  return {main:(m>=1?m.toFixed(3)+' m':(m*100).toFixed(1)+' cm'), sub:pxStr};
}

function fmtArea(pxArea){
  const r=getResolution();
  const pxStr=pxArea.toFixed(0)+' px²';
  if(!r) return {main:pxStr, sub:'load YAML for m²'};
  const m2=pxArea*r*r;
  return {main:(m2>=1?m2.toFixed(2)+' m²':(m2*10000).toFixed(1)+' cm²'), sub:pxStr};
}

function pathDist(pts){
  let d=0;
  for(let i=0;i<pts.length-1;i++) d+=Math.hypot(pts[i+1].x-pts[i].x,pts[i+1].y-pts[i].y);
  return d;
}

function shoelace(pts){
  let a=0;
  for(let i=0;i<pts.length;i++){
    const j=(i+1)%pts.length;
    a+=pts[i].x*pts[j].y - pts[j].x*pts[i].y;
  }
  return Math.abs(a)/2;
}

function setMsrMode(m){
  MSR.mode=m;
  cancelActive();
  ['line','path','area'].forEach(n=>$('mbtn-'+n).classList.toggle('active',n===m));
  $('msr-hint').textContent={
    line:'Click point A, then point B. Auto-saves.',
    path:'Click points along path. Double-click or Enter to save.',
    area:'Click polygon vertices. Double-click or Enter to save.',
  }[m];
}

function msrMakeLabel(type, pts){
  if(type==='area' && pts.length>=3){
    const f=fmtArea(shoelace(pts));
    const fp=fmtDist(pathDist([...pts,pts[0]]));
    return f.main+'\n'+f.sub+'\nPerim: '+fp.main;
  }
  const f=fmtDist(pathDist(pts));
  return f.main+'\n'+f.sub;
}

function saveMeasure(){
  const pts=MSR.active.slice();
  if(pts.length<2) return;
  const type=MSR.mode;
  const num=MSR.nextNum[type]++;
  const name=(type==='line'?'Line':type==='path'?'Path':'Area')+' '+num;
  const color=MCOLORS[MSR.saved.length%MCOLORS.length];
  const label=msrMakeLabel(type,pts);
  MSR.saved.push({name,type,pts,color,label});
  cancelActive();
  renderMsrList();
  renderOverlay();
}

function cancelActive(){
  MSR.active=[];
  S.measureMouse=null;
  $('msr-live').textContent='—';
  $('msr-sub').textContent='';
  $('msr-info').textContent='';
  $('msr-save-btn').style.display='none';
  renderOverlay();
}

// alias used by setTool when switching away from measure
function clearMeasure(){ cancelActive(); }

function clearAllMsr(){
  MSR.active=[];
  MSR.saved=[];
  MSR.nextNum={line:1,path:1,area:1};
  S.measureMouse=null;
  cancelActive();
  renderMsrList();
}

function deleteMsr(i){
  MSR.saved.splice(i,1);
  renderMsrList();
  renderOverlay();
}

function renderMsrList(){
  const el=$('msr-list'), ca=$('msr-clearall');
  if(!MSR.saved.length){el.innerHTML='';ca.style.display='none';return;}
  ca.style.display='';
  el.innerHTML=MSR.saved.map((m,i)=>`
    <div style="display:flex;align-items:flex-start;gap:4px;padding:5px 6px;
      background:var(--panel);border-radius:5px;border-left:3px solid ${m.color};box-shadow:0 1px 2px rgba(0,0,0,0.05)">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:600;color:${m.color}">${m.name}</div>
        <div style="font-size:10px;color:var(--text2);white-space:pre-line;line-height:1.4">${m.label}</div>
      </div>
      <button onclick="deleteMsr(${i})"
        style="background:none;border:none;color:#666;cursor:pointer;font-size:16px;
               line-height:1;padding:0;flex-shrink:0" title="Delete">×</button>
    </div>`).join('');
}

function updateActiveDisplay(){
  const pts=MSR.active, mouse=S.measureMouse;
  const n=pts.length;
  if(n===0 && !mouse){$('msr-live').textContent='—';$('msr-sub').textContent='';$('msr-info').textContent='';return;}

  const imgMouse = mouse ? c2i(mouse.x,mouse.y) : null;

  // Preview points set (placed + live mouse)
  let previewPts = pts.slice();
  if(imgMouse && (MSR.mode!=='line' || n<2)) previewPts=[...pts,imgMouse];

  // Info line
  const hints={line:'',path:' — double-click to finish',area:' — double-click to finish'};
  $('msr-info').textContent=n+' point'+(n!==1?'s':'')+hints[MSR.mode];

  let main='—', sub='';
  if(MSR.mode==='line'){
    if(previewPts.length>=2){const f=fmtDist(pathDist(previewPts));main=f.main+(mouse&&n<2?' …':'');sub=f.sub;}
  } else if(MSR.mode==='path'){
    if(previewPts.length>=2){const f=fmtDist(pathDist(previewPts));main=f.main+(mouse?' …':'');sub=f.sub;}
  } else {
    if(previewPts.length>=3){const f=fmtArea(shoelace(previewPts));main=f.main+(mouse?' …':'');sub=f.sub;}
  }
  $('msr-live').textContent=main;
  $('msr-sub').textContent=sub;
  $('st-msr').textContent=main;

  const canSave=(MSR.mode==='line'&&n>=2)||(MSR.mode==='path'&&n>=2)||(MSR.mode==='area'&&n>=3);
  $('msr-save-btn').style.display=canSave?'':'none';
}

// ─── Shape renderer (used for both active and saved) ───────────────
function drawMsrShape(pts,type,color,dashed,label,mousePt){
  if(!pts||pts.length===0) return;
  const cPts=pts.map(p=>i2c(p.x,p.y));
  let drawPts=[...cPts];
  if(mousePt&&(type!=='line'||cPts.length<2)) drawPts=[...cPts,mousePt];
  if(drawPts.length<1) return;

  oCtx.save();
  oCtx.lineCap='round'; oCtx.lineJoin='round';

  // Segment path
  if(drawPts.length>=2){
    oCtx.beginPath();
    oCtx.moveTo(drawPts[0].x,drawPts[0].y);
    drawPts.slice(1).forEach(p=>oCtx.lineTo(p.x,p.y));
    const close=type==='area'&&!mousePt;
    if(close) oCtx.closePath();

    // Area fill
    if(type==='area'&&drawPts.length>=3){
      oCtx.save(); oCtx.globalAlpha=0.1;
      oCtx.fillStyle=color; oCtx.fill(); oCtx.restore();
    }

    oCtx.strokeStyle=color; oCtx.lineWidth=1.5;
    oCtx.setLineDash(dashed?[5,4]:[]);
    oCtx.stroke(); oCtx.setLineDash([]);

    // Closing dashed preview for area+mouse
    if(type==='area'&&mousePt&&drawPts.length>=3){
      oCtx.save(); oCtx.globalAlpha=0.35;
      oCtx.strokeStyle=color; oCtx.lineWidth=1; oCtx.setLineDash([3,5]);
      oCtx.beginPath();
      oCtx.moveTo(mousePt.x,mousePt.y);
      oCtx.lineTo(drawPts[0].x,drawPts[0].y);
      oCtx.stroke(); oCtx.restore();
    }

    // Tick marks for line type
    if(type==='line'&&drawPts.length>=2){
      const dx=drawPts[1].x-drawPts[0].x, dy=drawPts[1].y-drawPts[0].y;
      const len=Math.hypot(dx,dy)||1;
      const nx=-dy/len*7, ny=dx/len*7;
      oCtx.strokeStyle=color; oCtx.lineWidth=1.5;
      [drawPts[0],drawPts[1]].forEach(p=>{
        oCtx.beginPath(); oCtx.moveTo(p.x+nx,p.y+ny); oCtx.lineTo(p.x-nx,p.y-ny); oCtx.stroke();
      });
    }
  }

  // Dots at placed points
  cPts.forEach((p,i)=>{
    oCtx.beginPath(); oCtx.arc(p.x,p.y,4,0,Math.PI*2);
    oCtx.fillStyle=color; oCtx.fill();
    oCtx.strokeStyle='#fff'; oCtx.lineWidth=1; oCtx.stroke();
  });

  // Label at centroid
  if(label&&cPts.length>=1){
    const lx=cPts.reduce((s,p)=>s+p.x,0)/cPts.length;
    const ly=cPts.reduce((s,p)=>s+p.y,0)/cPts.length;
    const lines=label.split('\n');
    const fh=11, pad=4, lh=fh+2;
    oCtx.font='bold '+fh+'px monospace';
    const tw=Math.max(...lines.map(l=>oCtx.measureText(l).width));
    const bh=lines.length*lh+pad*2;
    oCtx.fillStyle=THEME.labelBg();
    oCtx.strokeStyle=color; oCtx.lineWidth=1;
    oCtx.beginPath();
    if(oCtx.roundRect) oCtx.roundRect(lx-tw/2-pad,ly-bh/2,tw+pad*2,bh,4);
    else               oCtx.rect(lx-tw/2-pad,ly-bh/2,tw+pad*2,bh);
    oCtx.fill(); oCtx.stroke();
    oCtx.fillStyle=color; oCtx.textAlign='center'; oCtx.textBaseline='top';
    lines.forEach((l,i)=>{
      oCtx.font=(i===0?'bold ':'')+'11px monospace';
      oCtx.fillText(l,lx,ly-bh/2+pad+i*lh);
    });
    oCtx.textAlign='left'; oCtx.textBaseline='alphabetic';
  }

  oCtx.restore();
}

function renderMeasure(){
  // Always draw saved measurements (visible regardless of active tool)
  MSR.saved.forEach(m=>drawMsrShape(m.pts,m.type,m.color,false,m.name+'\n'+m.label.split('\n')[0],null));

  if(S.tool!=='measure') return;
  updateActiveDisplay();
  if(MSR.active.length===0&&!S.measureMouse) return;

  const mouse=S.measureMouse;
  let liveLabel=null;
  const imgM=mouse?c2i(mouse.x,mouse.y):null;
  const preview=imgM&&(MSR.mode!=='line'||MSR.active.length<2)?[...MSR.active,imgM]:MSR.active;
  if(MSR.mode==='line'&&preview.length>=2){const f=fmtDist(pathDist(preview));liveLabel=f.main+'\n'+f.sub;}
  else if(MSR.mode==='path'&&preview.length>=2){const f=fmtDist(pathDist(preview));liveLabel=f.main+'\n'+f.sub;}
  else if(MSR.mode==='area'&&preview.length>=3){const f=fmtArea(shoelace(preview));liveLabel=f.main+'\n'+f.sub;}
  drawMsrShape(MSR.active,MSR.mode,'#f59e0b',true,liveLabel,mouse);
}

// ─────────────────────────────────────────────────────────────────
// WAYPOINTS
// ─────────────────────────────────────────────────────────────────
const WP = {
  saved:   [],   // [{id,name,px,py,theta}]  px/py = image coords, theta = radians in world frame
  nextNum: 1,
};

// Convert an image-space position + heading into world-frame {x,y,theta} (meters/radians),
// or null fields if no YAML/resolution has been loaded.
function wpWorldFromImage(px,py,thetaImg){
  const res=getResolution();
  if(!res || !S.pgm) return {x:null,y:null,theta:thetaImg};
  const ori=getOrigin();
  const H=S.pgm.height;
  const wx=ori.x+px*res;
  const wy=ori.y+(H-1-py)*res;
  return {x:wx,y:wy,theta:thetaImg};
}

// Heading in the *world* frame given a drag from (x0,y0) to (x1,y1) in image coords.
// Image y grows downward while world y grows upward, so the y component is inverted.
function wpThetaFromDrag(x0,y0,x1,y1){
  const dx=x1-x0, dy=y1-y0;
  if(Math.abs(dx)<1e-6 && Math.abs(dy)<1e-6) return 0;
  return Math.atan2(-dy,dx);
}

function addWaypoint(px,py,theta){
  const id=WP.nextNum++;
  const name='wp'+id;
  WP.saved.push({id,name,px,py,theta});
  renderWpList();
  renderOverlay();
}

function deleteWaypoint(i){
  WP.saved.splice(i,1);
  renderWpList();
  renderOverlay();
}

// Delete whichever saved waypoint is nearest a screen point, if within a small pixel radius.
function deleteWaypointNear(screenPt){
  if(!WP.saved.length) return;
  let bestI=-1,bestD=1e9;
  WP.saved.forEach((w,i)=>{
    const c=i2c(w.px,w.py);
    const d=Math.hypot(c.x-screenPt.x,c.y-screenPt.y);
    if(d<bestD){bestD=d;bestI=i;}
  });
  if(bestI>=0 && bestD<=14) deleteWaypoint(bestI);
}

function renameWaypoint(i,name){
  if(WP.saved[i]) WP.saved[i].name=(name.trim()||WP.saved[i].name);
  renderOverlay();
}

function clearAllWaypoints(){
  WP.saved=[];
  WP.nextNum=1;
  renderWpList();
  renderOverlay();
}

function renderWpList(){
  const el=$('wp-list'), ca=$('wp-clearall'), cnt=$('wp-count');
  cnt.textContent=WP.saved.length+' waypoint'+(WP.saved.length!==1?'s':'');
  if(!WP.saved.length){el.innerHTML='';ca.style.display='none';return;}
  ca.style.display='';
  el.innerHTML=WP.saved.map((w,i)=>{
    const world=wpWorldFromImage(w.px,w.py,w.theta);
    const sub = world.x!==null
      ? `x:${world.x.toFixed(2)}m y:${world.y.toFixed(2)}m θ:${(w.theta*180/Math.PI).toFixed(0)}°`
      : `px:${w.px|0} py:${w.py|0} θ:${(w.theta*180/Math.PI).toFixed(0)}°`;
    return `
    <div style="display:flex;align-items:flex-start;gap:4px;padding:5px 6px;
      background:var(--panel);border-radius:5px;border-left:3px solid #f59e0b;box-shadow:0 1px 2px rgba(0,0,0,0.05)">
      <div style="flex:1;min-width:0">
        <input value="${w.name}" onchange="renameWaypoint(${i},this.value)"
          style="width:100%;font-size:11px;font-weight:600;color:#b45309;border:none;background:transparent;padding:0">
        <div style="font-size:10px;color:var(--text2);line-height:1.4">${sub}</div>
      </div>
      <button onclick="deleteWaypoint(${i})"
        style="background:none;border:none;color:#666;cursor:pointer;font-size:16px;
               line-height:1;padding:0;flex-shrink:0" title="Delete">×</button>
    </div>`;
  }).join('');
}

function drawWaypointMarker(px,py,theta,color,label,ctx){
  const c=i2c(px,py);
  const len=26; // arrow length in screen px
  const hx=c.x+len*Math.cos(theta), hy=c.y-len*Math.sin(theta); // screen y is flipped vs world y

  ctx.save();
  ctx.lineCap='round'; ctx.lineJoin='round';

  // Heading arrow shaft
  ctx.strokeStyle=color; ctx.lineWidth=2.5;
  ctx.beginPath(); ctx.moveTo(c.x,c.y); ctx.lineTo(hx,hy); ctx.stroke();
  ctx.restore();

  // Arrowhead, computed from the screen-space direction vector
  const alen=8;
  const dxs=hx-c.x, dys=hy-c.y, dlen=Math.hypot(dxs,dys)||1;
  const ux=dxs/dlen, uy=dys/dlen;
  const leftX=hx-alen*(ux*Math.cos(0.5)-uy*Math.sin(0.5));
  const leftY=hy-alen*(ux*Math.sin(0.5)+uy*Math.cos(0.5));
  const rightX=hx-alen*(ux*Math.cos(-0.5)-uy*Math.sin(-0.5));
  const rightY=hy-alen*(ux*Math.sin(-0.5)+uy*Math.cos(-0.5));

  ctx.save();
  ctx.fillStyle=color;
  ctx.beginPath();
  ctx.moveTo(hx,hy); ctx.lineTo(leftX,leftY); ctx.lineTo(rightX,rightY); ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Base marker (pin)
  ctx.save();
  ctx.beginPath(); ctx.arc(c.x,c.y,6,0,Math.PI*2);
  ctx.fillStyle=color; ctx.fill();
  ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();
  ctx.restore();

  // Label
  if(label){
    ctx.save();
    ctx.font='bold 10px monospace';
    const tw=ctx.measureText(label).width;
    const lx=c.x+9, ly=c.y-9;
    ctx.fillStyle=THEME.labelBg();
    ctx.strokeStyle=color; ctx.lineWidth=1;
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(lx-3,ly-12,tw+6,15,3);
    else ctx.rect(lx-3,ly-12,tw+6,15);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle=color;
    ctx.textAlign='left'; ctx.textBaseline='alphabetic';
    ctx.fillText(label,lx,ly);
    ctx.restore();
  }
}

function renderWaypoints(){
  // Saved waypoints are always visible, regardless of active tool
  WP.saved.forEach(w=>drawWaypointMarker(w.px,w.py,w.theta,'#f59e0b',w.name,oCtx));

  if(S.tool!=='waypoint') return;
  if(S.wpDragging && S.wpStart && S.wpEnd){
    const theta=wpThetaFromDrag(S.wpStart.x,S.wpStart.y,S.wpEnd.x,S.wpEnd.y);
    drawWaypointMarker(S.wpStart.x,S.wpStart.y,theta,'#3b82f6','new',oCtx);
  }
}

function exportWaypoints(){
  if(!WP.saved.length){ alert('No waypoints placed yet!'); return; }
  const res=getResolution();
  const ori=getOrigin();
  const name=($('save-name').value.trim()||'map').replace(/[^\w\-_.]/g,'_');

  const waypoints = WP.saved.map(w=>{
    const world=wpWorldFromImage(w.px,w.py,w.theta);
    const entry={
      id: w.id,
      name: w.name,
      pixel: {x: Math.round(w.px), y: Math.round(w.py)},
      theta_rad: w.theta,
      theta_deg: w.theta*180/Math.PI,
    };
    if(world.x!==null){
      entry.position = {x: +world.x.toFixed(4), y: +world.y.toFixed(4), z: 0};
      entry.orientation = {
        x: 0, y: 0,
        z: +Math.sin(w.theta/2).toFixed(6),
        w: +Math.cos(w.theta/2).toFixed(6)
      };
    }
    return entry;
  });

  const out = {
    map: name,
    resolution: res || null,
    origin: res ? [ori.x, ori.y, 0] : null,
    frame_id: 'map',
    waypoints
  };

  download(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}), name+'_waypoints.json');
}

// ─────────────────────────────────────────────────────────────────
// COORDINATE TRANSFORMS
// ─────────────────────────────────────────────────────────────────
function c2i(cx,cy){
  return {x:(cx-S.view.tx)/S.view.scale, y:(cy-S.view.ty)/S.view.scale};
}
function i2c(ix,iy){
  return {x:ix*S.view.scale+S.view.tx, y:iy*S.view.scale+S.view.ty};
}
function mPos(e){
  const r=mCanvas.getBoundingClientRect();
  return {x:e.clientX-r.left, y:e.clientY-r.top};
}

// ─────────────────────────────────────────────────────────────────
// PIXEL EDITING
// ─────────────────────────────────────────────────────────────────
function colorVal(){
  switch(S.color){case'wall':return 0;case'free':return 254;default:return 205;}
}


function paintDot(ix,iy,val,r){
  if(!S.pgm) return;
  const {width:W,height:H}=S.pgm;
  const ri=Math.max(0,r-1);
  for(let dy=-ri;dy<=ri;dy++){
    for(let dx=-ri;dx<=ri;dx++){
      if(dx*dx+dy*dy<=ri*ri){
        const px=Math.round(ix+dx), py=Math.round(iy+dy);
        if(px>=0&&px<W&&py>=0&&py<H) S.work[py*W+px]=val;
      }
    }
  }
}

function paintLine(x0,y0,x1,y1,val,r){
  // Bresenham + circle brush
  x0=Math.round(x0);y0=Math.round(y0);
  x1=Math.round(x1);y1=Math.round(y1);
  let dx=Math.abs(x1-x0),sx=x0<x1?1:-1;
  let dy=-Math.abs(y1-y0),sy=y0<y1?1:-1;
  let err=dx+dy;
  for(;;){
    paintDot(x0,y0,val,r);
    if(x0===x1&&y0===y1) break;
    const e2=2*err;
    if(e2>=dy){err+=dy;x0+=sx;}
    if(e2<=dx){err+=dx;y0+=sy;}
  }
}

// ─────────────────────────────────────────────────────────────────
// POLYGON → PIXELS
// ─────────────────────────────────────────────────────────────────
function burnPolygon(){
  if(!S.pgm||S.polyPts.length<2) return;
  saveUndo();
  const val=colorVal(), r=Math.max(1,S.brush);
  const pts=S.polyPts;

  // Outline
  for(let i=0;i<pts.length-1;i++)
    paintLine(pts[i].x,pts[i].y,pts[i+1].x,pts[i+1].y,val,r);
  if(S.polyMode==='closed'&&pts.length>2)
    paintLine(pts[pts.length-1].x,pts[pts.length-1].y,pts[0].x,pts[0].y,val,r);

  // Fill
  if(S.polyMode==='closed'&&pts.length>2&&$('fill-chk').checked)
    fillPoly(pts,val);

  syncOffscreen();
  render();
}

function fillPoly(pts,val){
  const {width:W,height:H}=S.pgm;
  const minY=Math.max(0,Math.floor(Math.min(...pts.map(p=>p.y))));
  const maxY=Math.min(H-1,Math.ceil(Math.max(...pts.map(p=>p.y))));
  for(let y=minY;y<=maxY;y++){
    const xs=[];
    for(let i=0;i<pts.length;i++){
      const a=pts[i],b=pts[(i+1)%pts.length];
      if((a.y<=y&&b.y>y)||(b.y<=y&&a.y>y))
        xs.push(a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y));
    }
    xs.sort((a,b)=>a-b);
    for(let i=0;i<xs.length-1;i+=2){
      const x0=Math.max(0,Math.ceil(xs[i]));
      const x1=Math.min(W-1,Math.floor(xs[i+1]));
      for(let x=x0;x<=x1;x++) S.work[y*W+x]=val;
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// UNDO / REDO
// ─────────────────────────────────────────────────────────────────
function updUndoBtns(){
  const u = S.undoStack.length > 0;
  const r = S.redoStack.length > 0;
  $('btn-undo').disabled = !u; 
  $('btn-redo').disabled = !r;
  const sbU = $('sb-undo'); if(sbU) sbU.disabled = !u;
  const sbR = $('sb-redo'); if(sbR) sbR.disabled = !r;
}
function saveUndo(){
  S.undoStack.push({work:S.work.slice(), w:S.pgm.width, h:S.pgm.height, y:S.yamlText});
  if(S.undoStack.length>40) S.undoStack.shift();
  S.redoStack=[];
  updUndoBtns();
}
function undo(){
  if(!S.undoStack.length) return;
  S.redoStack.push({work:S.work.slice(), w:S.pgm.width, h:S.pgm.height, y:S.yamlText});
  restoreState(S.undoStack.pop());
}
function redo(){
  if(!S.redoStack.length) return;
  S.undoStack.push({work:S.work.slice(), w:S.pgm.width, h:S.pgm.height, y:S.yamlText});
  restoreState(S.redoStack.pop());
}
function restoreState(s){
  S.work = s.work;
  S.pgm.width = s.w;
  S.pgm.height = s.h;
  S.yamlText = s.y;
  syncOffscreen(); render(); updUndoBtns();
  $('st-size').textContent=`${s.w}×${s.h}`;
}

// ─────────────────────────────────────────────────────────────────
// TOOLS
// ─────────────────────────────────────────────────────────────────
function setTool(t){
  if(S.polyPts.length>0) cancelPoly();
  if(t!=='measure') clearMeasure();
  if(t!=='waypoint'){ S.wpDragging=false; S.wpStart=null; S.wpEnd=null; }
  if(t!=='astar'){ S.astarStart=null; S.astarEnd=null; S.astarPath=null; }
  S.tool=t;
  ['draw','polygon','measure','rect','circle','waypoint','astar'].forEach(n=>{
    const el=$('tbtn-'+n); if(el) el.classList.toggle('active',n===t);
  });
  $('poly-section').style.display=t==='polygon'?'':'none';
  $('measure-section').style.display=t==='measure'?'':'none';
  $('shape-section').style.display=(t==='rect'||t==='circle')?'':'none';
  $('merge-section').style.display=t==='merge'?'':'none';
  $('waypoint-section').style.display=t==='waypoint'?'':'none';
  $('st-poly-wrap').style.display=t==='polygon'?'':'none';
  $('st-msr-wrap').style.display=t==='measure'?'':'none';
  wrap.style.cursor=(t==='merge'?'move':'crosshair');
  const names={draw:'Brush Draw',polygon:'Polygon Draw',measure:'Measure',
               rect:'Rect Draw',circle:'Circle Draw',pan:'Pan',merge:'Merge',waypoint:'Waypoint',astar:'A* Path Preview'};
  $('st-tool').textContent=names[t]||t;
}

function setPolyMode(m){
  S.polyMode=m;
  $('mbtn-open').classList.toggle('active',m==='open');
  $('mbtn-closed').classList.toggle('active',m==='closed');
  $('fill-row').style.display=m==='closed'?'flex':'none';
}

function setColor(c){
  S.color=c;
  ['wall','free','unknown'].forEach(n=>$('sw-'+n).classList.toggle('active',n===c));
}

function toggleOriginal(){
  S.showOrig=!S.showOrig;
  $('btn-orig').textContent=(S.showOrig?'👁 Working':'👁 Original');
  $('btn-orig').classList.toggle('active', S.showOrig);
  // Red border on canvas when viewing original
  $('canvas-wrap').style.outline = S.showOrig ? '3px solid #3b82f6' : 'none';
  render();
}

// ─────────────────────────────────────────────────────────────────
// POLYGON MANAGEMENT
// ─────────────────────────────────────────────────────────────────
function finishPoly(){
  if(S.polyPts.length>=2) burnPolygon();
  S.polyPts=[];
  S.lastMouse=null;
  $('poly-count').textContent='0 points';
  renderOverlay();
}
function cancelPoly(){
  S.polyPts=[];
  S.lastMouse=null;
  $('poly-count').textContent='0 points';
  renderOverlay();
}

// ─────────────────────────────────────────────────────────────────
// MERGE MANAGEMENT
// ─────────────────────────────────────────────────────────────────
function cancelMerge(){
  S.mergePgm=null;
  setTool('draw');
  renderOverlay();
}

function burnMerge(){
  if(!S.pgm || !S.mergePgm) return;
  saveUndo();
  const {width:bW, height:bH} = S.pgm;
  const {width:mW, height:mH, pixels:mPx} = S.mergePgm;
  const rad = S.mRot * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad); // forward
  
  // 1. Calculate bounding box
  let minX = 0, minY = 0, maxX = bW, maxY = bH;
  const corners = [ [-mW/2, -mH/2], [mW/2, -mH/2], [mW/2, mH/2], [-mW/2, mH/2] ];
  for(let [px, py] of corners){
    let sx = S.mFlipX ? -px : px, sy = S.mFlipY ? -py : py;
    let rx = sx * cos - sy * sin, ry = sx * sin + sy * cos;
    let cx = rx + S.mTx, cy = ry + S.mTy;
    if(cx < minX) minX = cx;
    if(cx > maxX) maxX = cx;
    if(cy < minY) minY = cy;
    if(cy > maxY) maxY = cy;
  }
  minX = Math.floor(minX); minY = Math.floor(minY);
  maxX = Math.ceil(maxX); maxY = Math.ceil(maxY);
  
  const nW = maxX - minX;
  const nH = maxY - minY;
  const offsetX = -minX;
  const offsetY = -minY;
  
  const newWork = new Uint8Array(nW * nH);
  newWork.fill(205); // fill with unknown
  
  // 2. Copy base map
  for(let y=0; y<bH; y++){
    for(let x=0; x<bW; x++){
      newWork[(y + offsetY)*nW + (x + offsetX)] = S.work[y*bW + x];
    }
  }
  
  // 3. Burn second map
  const invRad = -rad;
  const invCos = Math.cos(invRad), invSin = Math.sin(invRad);
  
  const mMinX = Math.floor(Math.min(...corners.map(c=>{
    let sx = S.mFlipX ? -c[0] : c[0], sy = S.mFlipY ? -c[1] : c[1];
    return (sx * cos - sy * sin) + S.mTx;
  })));
  const mMaxX = Math.ceil(Math.max(...corners.map(c=>{
    let sx = S.mFlipX ? -c[0] : c[0], sy = S.mFlipY ? -c[1] : c[1];
    return (sx * cos - sy * sin) + S.mTx;
  })));
  const mMinY = Math.floor(Math.min(...corners.map(c=>{
    let sx = S.mFlipX ? -c[0] : c[0], sy = S.mFlipY ? -c[1] : c[1];
    return (sx * sin + sy * cos) + S.mTy;
  })));
  const mMaxY = Math.ceil(Math.max(...corners.map(c=>{
    let sx = S.mFlipX ? -c[0] : c[0], sy = S.mFlipY ? -c[1] : c[1];
    return (sx * sin + sy * cos) + S.mTy;
  })));

  for(let y = mMinY; y <= mMaxY; y++){
    for(let x = mMinX; x <= mMaxX; x++){
      let dx = x - S.mTx, dy = y - S.mTy;
      let rx = dx * invCos - dy * invSin;
      let ry = dx * invSin + dy * invCos;
      if(S.mFlipX) rx = -rx;
      if(S.mFlipY) ry = -ry;
      let mx = Math.floor(rx + mW/2), my = Math.floor(ry + mH/2);
      
      if(mx>=0 && mx<mW && my>=0 && my<mH){
        const val = mPx[my*mW + mx];
        if(val !== 205) {
          const nx = x + offsetX, ny = y + offsetY;
          if(nx>=0 && nx<nW && ny>=0 && ny<nH){
             newWork[ny*nW + nx] = val;
          }
        }
      }
    }
  }
  
  // 4. Update YAML Origin
  if(S.yamlText) {
    const res = getResolution() || 0.05;
    const ori = getOrigin();
    const newOx = ori.x + minX * res;
    const newOy = ori.y - (maxY - bH) * res;
    S.yamlText = S.yamlText.replace(/origin\s*:\s*\[([^\]]+)\]/, (match, p1) => {
      const parts = p1.split(',');
      parts[0] = newOx.toFixed(6);
      parts[1] = newOy.toFixed(6);
      return `origin: [${parts.join(',')}]`;
    });
  }
  
  // 5. Expand origC to keep aligned
  const nOrig = document.createElement('canvas');
  nOrig.width = nW; nOrig.height = nH;
  const nOrigCtx = nOrig.getContext('2d');
  nOrigCtx.drawImage(origC, offsetX, offsetY);
  origC.width = nW; origC.height = nH;
  origCtx.drawImage(nOrig, 0, 0);

  // 6. Apply state
  S.work = newWork;
  S.pgm.width = nW;
  S.pgm.height = nH;
  S.mergePgm = null;
  
  $('st-size').textContent=`${nW}×${nH}`;
  syncOffscreen();
  setTool('draw');
  renderOverlay();
  resetView(); // auto zoom
}

// ─────────────────────────────────────────────────────────────────
// MOUSE EVENTS
// ─────────────────────────────────────────────────────────────────
let pendingUndo=false;

mCanvas.addEventListener('mousedown', e=>{
  if(!S.pgm) return;
  e.preventDefault();
  const m=mPos(e);
  const img=c2i(m.x,m.y);

  // Middle mouse or Alt+Left or tool=pan or space-bar temp-pan → pan
  const isPanTool = S.tool==='pan' || S.tool==='__temp_pan';
  if(e.button===1 || (e.button===0&&e.altKey) || (e.button===0&&isPanTool)){
    S.panning=true;
    S.panStart={mx:m.x,my:m.y,tx:S.view.tx,ty:S.view.ty};
    wrap.style.cursor='grabbing';
    return;
  }

  if(e.button===2){
    // Right click → remove last polygon point, or delete nearest waypoint
    if(S.tool==='polygon'&&S.polyPts.length>0){
      S.polyPts.pop(); renderOverlay();
    }
    if(S.tool==='waypoint'){
      deleteWaypointNear(m);
    }
    return;
  }

  if(e.button===0){
    if(S.tool==='merge'){
      S.mergeDragging=true;
      S.lastPt=img;
      return;
    }
    if(S.tool==='measure'){
      MSR.active.push({x:img.x,y:img.y});
      S.measureMouse=null;
      if(MSR.mode==='line'&&MSR.active.length>=2){
        saveMeasure(); // auto-save on 2nd click
      } else {
        renderOverlay();
        updateActiveDisplay();
      }
      return;
    }
    if(S.tool==='polygon'){
      S.polyPts.push({x:img.x,y:img.y});
      renderOverlay();
      return;
    }
    if(S.tool==='waypoint'){
      S.wpDragging=true;
      S.wpStart=img; S.wpEnd=img;
      renderOverlay();
      return;
    }
    if(S.tool==='astar'){
      if(!S.astarStart){
         S.astarStart={x:Math.round(img.x),y:Math.round(img.y)};
      } else if(!S.astarEnd) {
         S.astarEnd={x:Math.round(img.x),y:Math.round(img.y)};
         computeAStarPath();
      } else {
         S.astarStart={x:Math.round(img.x),y:Math.round(img.y)};
         S.astarEnd=null; S.astarPath=null;
      }
      renderOverlay();
      return;
    }
    if(S.tool==='rect'||S.tool==='circle'){
      saveUndo();
      S.drawing=true;
      S.shapeStart=img; S.shapeEnd=img;
      renderOverlay(); return;
    }

    if(S.tool==='draw'){
      saveUndo();
      pendingUndo=true;
      S.drawing=true;
      const v=colorVal();
      paintDot(img.x,img.y,v,S.brush);
      S.lastPt=img;
      syncOffscreen(); render();
    }
  }
});

mCanvas.addEventListener('mousemove', e=>{
  if(!S.pgm) return;
  const m=mPos(e);
  const img=c2i(m.x,m.y);
  const px=Math.floor(img.x), py=Math.floor(img.y);

  $('st-pos').textContent=`(${px}px, ${py}px)`;
  if(S.pgm&&px>=0&&px<S.pgm.width&&py>=0&&py<S.pgm.height){
    const v=S.work[py*S.pgm.width+px];
    const lbl=v===0?'Wall':v>=250?'Free':'Unknown';
    $('st-px').textContent=`${v} — ${lbl}`;
    const res=getResolution();
    if(res){
      const ori=getOrigin();
      const wx=(ori.x+px*res).toFixed(2), wy=(ori.y+(S.pgm.height-1-py)*res).toFixed(2);
      $('st-world').textContent=`(${wx}m, ${wy}m)`;
      $('st-world-wrap').style.display='';
    }
  }

  if(S.panning){
    S.view.tx=S.panStart.tx+(m.x-S.panStart.mx);
    S.view.ty=S.panStart.ty+(m.y-S.panStart.my);
    render(); return;
  }

  if(S.tool==='merge'){
    if(S.mergeDragging){
      S.mTx += img.x - S.lastPt.x;
      S.mTy += img.y - S.lastPt.y;
      S.lastPt = img;
      renderOverlay();
    }
    return;
  }

  if(S.tool==='measure'){
    if(MSR.active.length>=1&&(MSR.mode!=='line'||MSR.active.length<2)){
      S.measureMouse=m;
      renderOverlay();
    }
    return;
  }

  if(S.tool==='polygon'){
    S.lastMouse=m;
    renderOverlay(); return;
  }

  if(S.wpDragging&&S.tool==='waypoint'){
    S.wpEnd=img;
    renderOverlay(); return;
  }

  if(S.drawing&&(S.tool==='rect'||S.tool==='circle')){
    S.shapeEnd=img;
    renderOverlay(); return;
  }

  if(S.drawing&&S.tool==='draw'){
    const v=colorVal();
    if(S.lastPt) paintLine(S.lastPt.x,S.lastPt.y,img.x,img.y,v,S.brush);
    else paintDot(img.x,img.y,v,S.brush);
    S.lastPt=img;
    syncOffscreen(); render();
  }
});

mCanvas.addEventListener('mouseup', e=>{
  if(S.panning){
    S.panning=false;
    wrap.style.cursor=(S.tool==='pan'?'grab':(S.tool==='merge'?'move':'crosshair'));
  }
  S.mergeDragging=false;
  if(S.drawing&&(S.tool==='rect'||S.tool==='circle')&&S.shapeStart&&S.shapeEnd){
    burnShape();
    S.shapeStart=null; S.shapeEnd=null;
    renderOverlay();
  }
  if(S.wpDragging&&S.tool==='waypoint'&&S.wpStart){
    const end=S.wpEnd||S.wpStart;
    const theta=wpThetaFromDrag(S.wpStart.x,S.wpStart.y,end.x,end.y);
    addWaypoint(S.wpStart.x,S.wpStart.y,theta);
    S.wpDragging=false; S.wpStart=null; S.wpEnd=null;
    renderOverlay();
  }
  S.drawing=false;
  S.lastPt=null;
  pendingUndo=false;
});

mCanvas.addEventListener('mouseleave', ()=>{
  S.panning=false;
  S.drawing=false;
  S.mergeDragging=false;
  S.lastPt=null;
  S.lastMouse=null;
  S.measureMouse=null;
  if(S.tool==='polygon') renderOverlay();
  if(S.tool==='measure') { S.measureMouse=null; renderOverlay(); }
  if(S.tool==='rect'||S.tool==='circle'){S.shapeStart=null;S.shapeEnd=null;S.drawing=false;renderOverlay();}
  if(S.tool==='waypoint'){S.wpDragging=false;S.wpStart=null;S.wpEnd=null;renderOverlay();}
});

// Double-click → finish polygon / path / area
mCanvas.addEventListener('dblclick', e=>{
  if(S.tool==='polygon'&&S.polyPts.length>=2){
    S.polyPts.pop();
    finishPoly();
  }
  if(S.tool==='measure'&&(MSR.mode==='path'||MSR.mode==='area')&&MSR.active.length>=2){
    MSR.active.pop(); // remove extra from 2nd click of dblclick
    if(MSR.mode==='area'&&MSR.active.length<3) return;
    saveMeasure();
  }
});

// Context menu suppress
mCanvas.addEventListener('contextmenu', e=>e.preventDefault());

// Scroll to zoom
mCanvas.addEventListener('wheel', e=>{
  e.preventDefault();
  const m=mPos(e);
  const f=e.deltaY<0?1.12:1/1.12;
  S.view.tx=m.x-f*(m.x-S.view.tx);
  S.view.ty=m.y-f*(m.y-S.view.ty);
  S.view.scale*=f;
  render();
},{passive:false});

// ─────────────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e=>{
  const tag=document.activeElement.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA') return;

  if((e.ctrlKey||e.metaKey)&&e.code==='KeyZ'){
    e.preventDefault();
    if(e.shiftKey) redo(); else undo();
    return;
  }
  if((e.ctrlKey||e.metaKey)&&e.code==='KeyY'){
    e.preventDefault(); redo(); return;
  }
  switch(e.code){
    case'KeyD': setTool('draw'); break;
    case'KeyG': setTool('polygon'); break;
    case'KeyM': setTool('measure'); break;
    case'KeyR': setTool('rect'); break;
    case'KeyC': setTool('circle'); break;
    case'KeyW': setTool('waypoint'); break;
    case'BracketLeft': if(S.tool==='merge'){ e.preventDefault(); S.mRot=(S.mRot-1)%360; $('merge-rot').value=S.mRot; $('mrot-lbl').textContent=S.mRot+'°'; renderOverlay(); } break;
    case'BracketRight': if(S.tool==='merge'){ e.preventDefault(); S.mRot=(S.mRot+1)%360; $('merge-rot').value=S.mRot; $('mrot-lbl').textContent=S.mRot+'°'; renderOverlay(); } break;
    case'Escape': if(S.tool==='polygon') cancelPoly(); else if(S.tool==='measure'){if(MSR.active.length>0){MSR.active.pop();renderOverlay();updateActiveDisplay();}} else if(S.tool==='merge'){cancelMerge();} else if(S.tool==='waypoint'){S.wpDragging=false;S.wpStart=null;S.wpEnd=null;renderOverlay();} break;
    case'Enter': if(S.tool==='polygon') finishPoly(); else if(S.tool==='measure'&&MSR.active.length>=2) saveMeasure(); else if(S.tool==='merge'){burnMerge();} break;
    case'Equal':case'NumpadAdd': e.preventDefault(); zoomBy(1.3); break;
    case'Minus':case'NumpadSubtract': e.preventDefault(); zoomBy(1/1.3); break;
    case'KeyF': resetView(); break;
  }
});

// Space bar pan (hold)
let spaceDown=false;
window.addEventListener('keydown', e=>{
  if(e.code==='Space'&&!spaceDown){
    const tag=document.activeElement.tagName;
    if(tag==='INPUT'||tag==='TEXTAREA') return;
    spaceDown=true;
    if(S.tool!=='pan') wrap.dataset.prevTool=S.tool;
    if(S.tool!=='pan') { S.tool='__temp_pan'; wrap.style.cursor='grab'; }
    e.preventDefault();
  }
});
window.addEventListener('keyup', e=>{
  if(e.code==='Space'&&spaceDown){
    spaceDown=false;
    const prev=wrap.dataset.prevTool;
    if(prev){ setTool(prev); delete wrap.dataset.prevTool; }
  }
});

// ─────────────────────────────────────────────────────────────────
// VIEW
// ─────────────────────────────────────────────────────────────────
function zoomBy(f){
  const cx=mCanvas.width/2, cy=mCanvas.height/2;
  S.view.tx=cx-f*(cx-S.view.tx);
  S.view.ty=cy-f*(cy-S.view.ty);
  S.view.scale*=f;
  render();
}

function resetView(){
  if(!S.pgm) return;
  const {width:W,height:H}=S.pgm;
  const cw=mCanvas.width, ch=mCanvas.height;
  const sc=Math.min(cw/W,ch/H)*0.92;
  S.view={scale:sc, tx:(cw-W*sc)/2, ty:(ch-H*sc)/2};
  render();
}

// ─────────────────────────────────────────────────────────────────
// FILE LOADING
// ─────────────────────────────────────────────────────────────────
$('pgm-in').addEventListener('change', async e=>{
  const f=e.target.files[0]; if(!f) return;
  try {
    const buf=await f.arrayBuffer();
    S.pgm=parsePGM(buf);
    S.origPixels=S.pgm.pixels.slice();
    S.work=S.pgm.pixels.slice();
    S.undoStack=[]; S.redoStack=[];
    S.polyPts=[]; S.lastMouse=null;
    inflC.width=0; inflC.height=0; S.showInflation=false; $('infl-on').checked=false;
    updUndoBtns();

    // Sync offscreens
    const {width:W,height:H}=S.pgm;
    origC.width=W; origC.height=H;
    origCtx.putImageData(px2rgba(S.origPixels,W,H), 0, 0);
    syncOffscreen();

    $('hint').classList.add('hidden');
    $('hdr-pgm').textContent='✔ '+f.name;
    $('hdr-pgm').style.color='var(--success)';
    $('st-size').textContent=`${W}×${H}`;

    // Default export name
    $('save-name').value=f.name.replace(/\.pgm$/i,'')+'_edited';

    resetView();
  } catch(err){
    alert('Error loading PGM:\n'+err.message);
    console.error(err);
  }
  e.target.value='';
});

$('merge-pgm-in').addEventListener('change', async e=>{
  const f=e.target.files[0]; if(!f) return;
  if(!S.pgm){alert('Please load a primary map first.');e.target.value='';return;}
  try {
    const buf=await f.arrayBuffer();
    S.mergePgm=parsePGM(buf);
    const {width:W,height:H}=S.mergePgm;
    mOffC.width=W; mOffC.height=H;
    mOffCtx.putImageData(px2rgba(S.mergePgm.pixels,W,H,true), 0, 0);
    
    S.mTx = S.pgm.width/2; S.mTy = S.pgm.height/2;
    S.mRot = 0; S.mFlipX = false; S.mFlipY = false;
    $('merge-rot').value = 0; $('mrot-lbl').textContent = '0°';
    setTool('merge'); renderOverlay();
  } catch(err){
    alert('Error loading merge map:\n'+err.message);
  }
  e.target.value='';
});

$('yaml-in').addEventListener('change', async e=>{
  const f=e.target.files[0]; if(!f) return;
  S.yamlText=await f.text();
  $('hdr-yaml').textContent='✔ '+f.name;
  $('hdr-yaml').style.color='var(--success)';
  $('st-world-wrap').style.display='';
  if(S.showInflation) recomputeInflation();
  e.target.value='';
});

// ─────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────
function exportAll(){
  if(!S.pgm){ alert('No map loaded!'); return; }

  const name=($('save-name').value.trim()||'edited_map').replace(/[^\w\-_.]/g,'_');

  // PGM
  const pgmBytes=writePGM(S.work, S.pgm.width, S.pgm.height);
  download(new Blob([pgmBytes],{type:'image/x-portable-graymap'}), name+'.pgm');

  // YAML
  let yaml;
  if(S.yamlText){
    yaml=S.yamlText.replace(/^(\s*image\s*:\s*)(.+)$/m, `$1${name}.pgm`);
  } else {
    yaml=[
      `image: ${name}.pgm`,
      `mode: trinary`,
      `resolution: 0.050000`,
      `origin: [0.000000, 0.000000, 0.000000]`,
      `negate: 0`,
      `occupied_thresh: 0.65`,
      `free_thresh: 0.25`,
      ``
    ].join('\n');
  }
  setTimeout(()=>download(new Blob([yaml],{type:'text/yaml'}), name+'.yaml'), 120);

  // Confirm
  const info=document.createElement('div');
  info.textContent=`✔ Exported ${name}.pgm and ${name}.yaml`;
  info.style.cssText='position:fixed;bottom:48px;right:20px;background:#f0fdf4;color:#15803d;border:1px solid #16a34a;border-radius:8px;padding:10px 16px;font-size:13px;font-weight:500;z-index:999;pointer-events:none;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1)';
  document.body.appendChild(info);
  setTimeout(()=>info.remove(), 3000);
}

function download(blob, name){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────
setTool('draw');
setPolyMode('open');
setColor('wall');
render();
// ─────────────────────────────────────────────────────────────────
// WORLD COORDINATES
// ─────────────────────────────────────────────────────────────────
function getOrigin(){
  if(S.yamlText){
    const m=S.yamlText.match(/origin\s*:\s*\[([^\]]+)\]/);
    if(m){const p=m[1].split(',').map(Number);return {x:p[0]||0,y:p[1]||0};}
  }
  return {x:0,y:0};
}

// ─────────────────────────────────────────────────────────────────
// GRID
// ─────────────────────────────────────────────────────────────────
function renderGrid(ctx){
  if(!S.pgm) return;
  const res=getResolution();
  const spacingPx=res?S.gridSpacingM/res:50;
  const {width:W,height:H}=S.pgm;
  const sc=S.view.scale;

  ctx.save();
  ctx.strokeStyle=THEME.gridStroke();
  ctx.lineWidth=1/sc;
  ctx.beginPath();
  for(let x=0;x<W;x+=spacingPx){ctx.moveTo(x,0);ctx.lineTo(x,H);}
  for(let y=0;y<H;y+=spacingPx){ctx.moveTo(0,y);ctx.lineTo(W,y);}
  ctx.stroke();

  // Labels when zoomed in enough
  if(sc*spacingPx>60 && res){
    const ori=getOrigin();
    ctx.fillStyle=THEME.gridFill();
    ctx.font=`${9/sc}px monospace`;
    ctx.textBaseline='top';
    for(let x=0;x<W;x+=spacingPx){
      for(let y=0;y<H;y+=spacingPx){
        const wx=(ori.x+x*res).toFixed(0);
        const wy=(ori.y+(H-y)*res).toFixed(0);
        ctx.fillText(`${wx},${wy}m`,x+2/sc,y+2/sc);
      }
    }
    ctx.textBaseline='alphabetic';
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────
// SCALE BAR
// ─────────────────────────────────────────────────────────────────
function renderScaleBar(){
  if(!S.pgm) return;
  const cW=mCanvas.width, cH=mCanvas.height;
  const res=getResolution();
  const sc=S.view.scale;
  const pad=14;
  let screenLen, label;

  if(res){
    const NICE=[0.1,0.25,0.5,1,2,5,10,20,50,100];
    const targetM=(120/sc)*res;
    const m=NICE.find(n=>n>=targetM)||NICE[NICE.length-1];
    screenLen=(m/res)*sc;
    label=m>=1?`${m} m`:`${m*100} cm`;
  } else {
    const NICE=[1,2,5,10,20,50,100,200,500];
    const targetPx=120/sc;
    const p=NICE.find(n=>n>=targetPx)||NICE[NICE.length-1];
    screenLen=p*sc;
    label=`${p} px`;
  }

  const x2=cW-pad, x1=x2-screenLen, y=cH-pad-6;
  mCtx.save();
  mCtx.fillStyle=THEME.scaleBg();
  mCtx.beginPath();
  if(mCtx.roundRect) mCtx.roundRect(x1-6,y-14,screenLen+12,18,3);
  else mCtx.rect(x1-6,y-14,screenLen+12,18);
  mCtx.fill();
  mCtx.strokeStyle=THEME.scaleStroke(); mCtx.lineWidth=1.5;
  mCtx.beginPath(); mCtx.moveTo(x1,y); mCtx.lineTo(x2,y); mCtx.stroke();
  mCtx.beginPath(); mCtx.moveTo(x1,y-4); mCtx.lineTo(x1,y+4); mCtx.stroke();
  mCtx.beginPath(); mCtx.moveTo(x2,y-4); mCtx.lineTo(x2,y+4); mCtx.stroke();
  mCtx.fillStyle=THEME.scaleText(); mCtx.font='10px monospace';
  mCtx.textAlign='center'; mCtx.textBaseline='bottom';
  mCtx.fillText(label,(x1+x2)/2,y-1);
  mCtx.textAlign='left'; mCtx.textBaseline='alphabetic';
  mCtx.restore();
}

// ─────────────────────────────────────────────────────────────────
// INFLATION PREVIEW
// ─────────────────────────────────────────────────────────────────
function toggleInflation(){
  S.showInflation=$('infl-on').checked;
  if(S.showInflation) recomputeInflation();
  else render();
}

function recomputeInflation(){
  if(!S.pgm){render();return;}
  const {width:W,height:H}=S.pgm;
  const res=getResolution()||0.05;
  const radiusPx=S.inflRadiusM/res;

  // BFS Chebyshev distance from wall pixels
  const dist=new Float32Array(W*H).fill(1e9);
  const q=[]; let head=0;
  for(let i=0;i<S.work.length;i++) if(S.work[i]===0){dist[i]=0;q.push(i);}

  while(head<q.length){
    const idx=q[head++];
    const y=(idx/W)|0, x=idx%W, d=dist[idx];
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      if(!dy&&!dx) continue;
      const nx=x+dx,ny=y+dy;
      if(nx<0||nx>=W||ny<0||ny>=H) continue;
      const nd=d+(dx&&dy?Math.SQRT2:1);
      if(nd<dist[ny*W+nx]){
        dist[ny*W+nx]=nd;
        if(nd<=radiusPx) q.push(ny*W+nx);
      }
    }
  }
  S.inflDist = dist;

  inflC.width=W; inflC.height=H;
  const img=new ImageData(W,H);
  for(let i=0;i<W*H;i++){
    const d=dist[i];
    if(d>0&&d<=radiusPx&&S.work[i]!==0){
      const t=1-d/radiusPx;
      img.data[i*4]=255; img.data[i*4+1]=Math.round(80*(1-t));
      img.data[i*4+2]=0; img.data[i*4+3]=Math.round(200*t+30);
    }
  }
  inflCtx.putImageData(img,0,0);
  render();
}

// ─────────────────────────────────────────────────────────────────
// RECT / CIRCLE DRAW
// ─────────────────────────────────────────────────────────────────
function colorHexPreview(){
  return '#58a6ff';
}

function renderShapePreview(){
  if(!S.shapeStart||!S.shapeEnd) return;
  if(S.tool!=='rect'&&S.tool!=='circle') return;
  const a=i2c(S.shapeStart.x,S.shapeStart.y);
  const b=i2c(S.shapeEnd.x,S.shapeEnd.y);
  const fill=$('shape-fill').checked;

  oCtx.save();
  oCtx.strokeStyle='#58a6ff'; oCtx.lineWidth=1.5; oCtx.setLineDash([4,3]);

  if(S.tool==='rect'){
    const rx=Math.min(a.x,b.x),ry=Math.min(a.y,b.y);
    const rw=Math.abs(b.x-a.x),rh=Math.abs(b.y-a.y);
    if(fill){oCtx.globalAlpha=0.15;oCtx.fillStyle='#58a6ff';oCtx.fillRect(rx,ry,rw,rh);oCtx.globalAlpha=1;}
    oCtx.strokeRect(rx,ry,rw,rh);
    // Size label
    const res=getResolution();
    const imgW=Math.abs(S.shapeEnd.x-S.shapeStart.x), imgH=Math.abs(S.shapeEnd.y-S.shapeStart.y);
    const lbl=res?`${(imgW*res).toFixed(1)}×${(imgH*res).toFixed(1)}m`:`${imgW|0}×${imgH|0}px`;
    oCtx.setLineDash([]);oCtx.fillStyle='#58a6ff';oCtx.font='10px monospace';
    oCtx.textAlign='center';oCtx.fillText(lbl,(a.x+b.x)/2,(Math.min(a.y,b.y))-4);
  } else {
    const r=Math.hypot(b.x-a.x,b.y-a.y);
    if(fill){oCtx.globalAlpha=0.15;oCtx.fillStyle='#58a6ff';oCtx.beginPath();oCtx.arc(a.x,a.y,r,0,Math.PI*2);oCtx.fill();oCtx.globalAlpha=1;}
    oCtx.beginPath();oCtx.arc(a.x,a.y,r,0,Math.PI*2);oCtx.stroke();
    oCtx.setLineDash([]);oCtx.lineWidth=1;
    oCtx.beginPath();oCtx.moveTo(a.x,a.y);oCtx.lineTo(b.x,b.y);oCtx.stroke();
    const res=getResolution();
    const imgR=Math.hypot(S.shapeEnd.x-S.shapeStart.x,S.shapeEnd.y-S.shapeStart.y);
    const lbl=res?`r=${(imgR*res).toFixed(2)}m`:`r=${imgR|0}px`;
    oCtx.fillStyle='#58a6ff';oCtx.font='10px monospace';
    oCtx.textAlign='left';oCtx.fillText(lbl,(a.x+b.x)/2+4,(a.y+b.y)/2-4);
  }
  oCtx.setLineDash([]);
  oCtx.restore();
}

function burnShape(){
  if(!S.shapeStart||!S.shapeEnd||!S.pgm) return;
  saveUndo();
  const v=colorVal(), {width:W,height:H}=S.pgm;
  const fill=$('shape-fill').checked;

  if(S.tool==='rect'){
    const x0=Math.round(Math.min(S.shapeStart.x,S.shapeEnd.x));
    const y0=Math.round(Math.min(S.shapeStart.y,S.shapeEnd.y));
    const x1=Math.round(Math.max(S.shapeStart.x,S.shapeEnd.x));
    const y1=Math.round(Math.max(S.shapeStart.y,S.shapeEnd.y));
    if(fill){
      for(let y=Math.max(0,y0);y<=Math.min(H-1,y1);y++)
        for(let x=Math.max(0,x0);x<=Math.min(W-1,x1);x++) S.work[y*W+x]=v;
    } else {
      const r=Math.max(1,S.brush);
      for(let x=x0;x<=x1;x++){paintDot(x,y0,v,r);paintDot(x,y1,v,r);}
      for(let y=y0;y<=y1;y++){paintDot(x0,y,v,r);paintDot(x1,y,v,r);}
    }
  } else { // circle
    const cx=S.shapeStart.x, cy=S.shapeStart.y;
    const r=Math.hypot(S.shapeEnd.x-cx,S.shapeEnd.y-cy);
    if(fill){
      const ri=Math.ceil(r);
      for(let dy=-ri;dy<=ri;dy++) for(let dx=-ri;dx<=ri;dx++){
        if(dx*dx+dy*dy<=r*r){
          const nx=Math.round(cx+dx),ny=Math.round(cy+dy);
          if(nx>=0&&nx<W&&ny>=0&&ny<H) S.work[ny*W+nx]=v;
        }
      }
    } else {
      const steps=Math.max(8,Math.ceil(2*Math.PI*r));
      const br=Math.max(1,S.brush);
      for(let i=0;i<steps;i++){
        const a=2*Math.PI*i/steps;
        paintDot(Math.round(cx+r*Math.cos(a)),Math.round(cy+r*Math.sin(a)),v,br);
      }
    }
  }
  if(S.showInflation) recomputeInflation();
  syncOffscreen(); render();
}

// ─────────────────────────────────────────────────────────────────
// EXPORT IMAGE
// ─────────────────────────────────────────────────────────────────
function exportImage(){
  if(!S.pgm){alert('No map loaded!');return;}
  // Draw full map at 1:1 scale to a temp canvas
  const {width:W,height:H}=S.pgm;
  const tmp=document.createElement('canvas');
  tmp.width=W; tmp.height=H;
  const tCtx=tmp.getContext('2d');
  tCtx.imageSmoothingEnabled=false;
  tCtx.drawImage(offC,0,0);
  if(S.showInflation&&inflC.width>0){tCtx.save();tCtx.globalAlpha=0.75;tCtx.drawImage(inflC,0,0);tCtx.restore();}
  // Draw overlays at 1:1
  const savedTx=S.view.tx, savedTy=S.view.ty, savedSc=S.view.scale;
  S.view={scale:1,tx:0,ty:0};
  const tmpO=document.createElement('canvas');
  tmpO.width=W; tmpO.height=H;
  const oBackup=oCanvas.width;
  // Temporarily swap overlay ctx target — easier: just reuse oCtx
  const realOCtx=oCtx;
  // Draw overlays manually on tCtx

  S.view={scale:savedSc,tx:savedTx,ty:savedTy};

  const name=($('save-name').value.trim()||'map').replace(/[^\w\-_.]/g,'_');
  tmp.toBlob(blob=>download(blob,name+'.png'),'image/png');
}

// ─────────────────────────────────────────────────────────────────
// ALGORITHMS (Noise Reduction, A*, Extraction, ICP)
// ─────────────────────────────────────────────────────────────────
function applyMedianFilter() {
  if(!S.pgm) return;
  saveUndo();
  const {width:W,height:H}=S.pgm;
  let src = new Uint8Array(S.work);
  let dst = new Uint8Array(S.work);
  
  for(let y=1; y<H-1; y++){
    for(let x=1; x<W-1; x++){
      let idx = y*W+x;
      if (src[idx] === 205) continue; // Skip unknown space to preserve boundaries
      
      let counts = {0:0, 254:0, 205:0};
      for(let dy=-1;dy<=1;dy++){
        for(let dx=-1;dx<=1;dx++){
           if (dx===0 && dy===0) continue;
           counts[src[(y+dy)*W+(x+dx)]]++;
        }
      }
      // If majority of 8 neighbors are of one type, flip it
      if (src[idx] === 0 && counts[254] >= 5) {
         dst[idx] = 254; // Erode isolated wall pixel
      } else if (src[idx] === 254 && counts[0] >= 5) {
         dst[idx] = 0; // Fill isolated free pixel hole
      }
    }
  }
  S.work.set(dst);
  if(S.showInflation) recomputeInflation();
  syncOffscreen(); render();
}


function autoAlignMerge() {
  if(!S.pgm || !S.mergePgm) return;
  
  const W = S.pgm.width, H = S.pgm.height;
  const targetPts = [];
  for(let y=0; y<H; y+=3){
    for(let x=0; x<W; x+=3){
      if(S.work[y*W+x] === 0) targetPts.push({x, y});
    }
  }
  
  const cellSize = 15;
  const hash = {};
  targetPts.forEach(p => {
    const cx = Math.floor(p.x/cellSize), cy = Math.floor(p.y/cellSize);
    const key = cx+','+cy;
    if(!hash[key]) hash[key] = [];
    hash[key].push(p);
  });
  
  const mW = S.mergePgm.width, mH = S.mergePgm.height;
  const sourcePts = [];
  for(let y=0; y<mH; y+=3){
    for(let x=0; x<mW; x+=3){
      if(S.mergePgm.pixels[y*mW+x] === 0) {
         sourcePts.push({x: x - mW/2, y: y - mH/2});
      }
    }
  }
  
  if(targetPts.length === 0 || sourcePts.length === 0){
     alert('Not enough wall pixels to align.');
     return;
  }
  
  let tx = S.mTx, ty = S.mTy, rot = S.mRot * Math.PI / 180;
  const fx = S.mFlipX ? -1 : 1, fy = S.mFlipY ? -1 : 1;
  
  const maxIters = 25;
  for(let iter=0; iter<maxIters; iter++){
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    
    const transformed = sourcePts.map(p => {
       const px = p.x * fx, py = p.y * fy;
       return {
         orig: p,
         x: px * cosR - py * sinR + tx,
         y: px * sinR + py * cosR + ty
       };
    });
    
    const matches = [];
    for(let i=0; i<transformed.length; i++){
       const tp = transformed[i];
       const cx = Math.floor(tp.x/cellSize), cy = Math.floor(tp.y/cellSize);
       let bestPt = null; let bestDist = 625; // 25px max distance squared
       
       for(let dcy=-2; dcy<=2; dcy++){
         for(let dcx=-2; dcx<=2; dcx++){
           const bucket = hash[(cx+dcx)+','+(cy+dcy)];
           if(bucket){
             for(let j=0; j<bucket.length; j++){
               const bp = bucket[j];
               const distSq = (tp.x-bp.x)**2 + (tp.y-bp.y)**2;
               if(distSq < bestDist){
                 bestDist = distSq;
                 bestPt = bp;
               }
             }
           }
         }
       }
       if(bestPt) matches.push({src: tp, tgt: bestPt});
    }
    
    if(matches.length < 10) break;
    
    let sumSrcX = 0, sumSrcY = 0, sumTgtX = 0, sumTgtY = 0;
    for(let i=0; i<matches.length; i++){
       sumSrcX += matches[i].src.orig.x * fx;
       sumSrcY += matches[i].src.orig.y * fy;
       sumTgtX += matches[i].tgt.x;
       sumTgtY += matches[i].tgt.y;
    }
    const N = matches.length;
    const meanSrcX = sumSrcX / N, meanSrcY = sumSrcY / N;
    const meanTgtX = sumTgtX / N, meanTgtY = sumTgtY / N;
    
    let Sxx = 0, Sxy = 0, Syx = 0, Syy = 0;
    for(let i=0; i<matches.length; i++){
       const sx = (matches[i].src.orig.x * fx) - meanSrcX;
       const sy = (matches[i].src.orig.y * fy) - meanSrcY;
       const tx_c = matches[i].tgt.x - meanTgtX;
       const ty_c = matches[i].tgt.y - meanTgtY;
       Sxx += sx * tx_c;
       Sxy += sx * ty_c;
       Syx += sy * tx_c;
       Syy += sy * ty_c;
    }
    
    rot = Math.atan2(Sxy - Syx, Sxx + Syy);
    tx = meanTgtX - (meanSrcX * Math.cos(rot) - meanSrcY * Math.sin(rot));
    ty = meanTgtY - (meanSrcX * Math.sin(rot) + meanSrcY * Math.cos(rot));
  }
  
  S.mTx = tx;
  S.mTy = ty;
  S.mRot = rot * 180 / Math.PI;
  renderOverlay();
}

// ─────────────────────────────────────────────────────────────────
// A* PATHFINDING
// ─────────────────────────────────────────────────────────────────
class MinHeap {
  constructor() { this.heap = []; }
  push(node) {
    this.heap.push(node);
    this.bubbleUp(this.heap.length - 1);
  }
  pop() {
    if (this.heap.length === 1) return this.heap.pop();
    const top = this.heap[0];
    this.heap[0] = this.heap.pop();
    this.sinkDown(0);
    return top;
  }
  bubbleUp(idx) {
    const node = this.heap[idx];
    while (idx > 0) {
      const pIdx = Math.floor((idx - 1) / 2);
      const parent = this.heap[pIdx];
      if (node.f >= parent.f) break;
      this.heap[idx] = parent;
      this.heap[pIdx] = node;
      idx = pIdx;
    }
  }
  sinkDown(idx) {
    const len = this.heap.length;
    const node = this.heap[idx];
    while (true) {
      let left = 2 * idx + 1, right = 2 * idx + 2;
      let swap = null;
      if (left < len && this.heap[left].f < node.f) swap = left;
      if (right < len && this.heap[right].f < (swap === null ? node.f : this.heap[left].f)) swap = right;
      if (swap === null) break;
      this.heap[idx] = this.heap[swap];
      this.heap[swap] = node;
      idx = swap;
    }
  }
  isEmpty() { return this.heap.length === 0; }
}

function computeAStarPath() {
  if(!S.pgm || !S.astarStart || !S.astarEnd) return;
  
  if(!S.showInflation) {
    alert("Please enable 'Show Inflation Costmap' and set your robot radius first.");
    S.astarStart = null; S.astarEnd = null;
    renderOverlay(); return;
  }
  
  const {width:W, height:H} = S.pgm;

  // Always recompute fresh inflation distance map
  recomputeInflation();
  const grid  = S.work;
  const distMap = S.inflDist;
  const inflRadiusPx = S.yamlText && getResolution() ? S.inflRadiusM / getResolution() : 0;

  // --- Snap point to nearest non-wall pixel (BFS) ---
  const snapToFree = (pt) => {
    const startIdx = pt.y * W + pt.x;
    if (grid[startIdx] !== 0) return pt;           // already free
    const visited = new Uint8Array(W * H);
    const q = [startIdx]; visited[startIdx] = 1; let head = 0;
    while (head < q.length) {
      const idx = q[head++];
      if (grid[idx] !== 0) return { x: idx % W, y: Math.floor(idx / W) };
      const y = Math.floor(idx / W), x = idx % W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x+dx, ny = y+dy;
        if (nx>=0&&nx<W&&ny>=0&&ny<H) {
          const ni = ny*W+nx;
          if (!visited[ni]) { visited[ni]=1; q.push(ni); }
        }
      }
    }
    return pt; // fallback (shouldn't happen)
  };

  const start = snapToFree(S.astarStart);
  const goal  = snapToFree(S.astarEnd);
  S.astarStart = start; S.astarEnd = goal;

  const startIdx = start.y*W + start.x;
  const goalIdx  = goal.y*W  + goal.x;

  if (grid[startIdx] === 0) { alert("Start is inside a wall."); return; }
  if (grid[goalIdx]  === 0) { alert("Goal is inside a wall.");  return; }

  // --- A* with proper closed set (visited array) ---
  // Inflation = soft penalty only. ONLY solid walls (value 0) are obstacles.
  const INF = 1e30;
  const gScore  = new Float32Array(W * H).fill(INF);
  const cameFrom = new Int32Array(W * H).fill(-1);
  const closed   = new Uint8Array(W * H);   // closed set = already-settled nodes

  const h = (x, y) => Math.hypot(x - goal.x, y - goal.y);

  gScore[startIdx] = 0;
  const openSet = new MinHeap();
  openSet.push({ idx: startIdx, f: h(start.x, start.y) });

  const DIRS = [
    [1,0,1],[-1,0,1],[0,1,1],[0,-1,1],
    [1,1,1.414],[-1,1,1.414],[1,-1,1.414],[-1,-1,1.414]
  ];

  let found = false;

  while (!openSet.isEmpty()) {
    const cur = openSet.pop();
    const ci  = cur.idx;
    if (closed[ci]) continue;   // stale entry — skip
    closed[ci] = 1;
    if (ci === goalIdx) { found = true; break; }

    const cy = Math.floor(ci / W), cx = ci % W;

    for (let d = 0; d < 8; d++) {
      const [dx, dy, w] = DIRS[d];
      const nx = cx+dx, ny = cy+dy;
      if (nx<0||nx>=W||ny<0||ny>=H) continue;
      const ni = ny*W+nx;
      if (closed[ni]) continue;
      if (grid[ni] === 0) continue;   // solid wall — skip

      // Soft costmap penalty: strongly prefer cells far from walls
      let penalty = 0;
      if (distMap) {
        const d2w = distMap[ni];               // distance-to-wall in pixels
        if (d2w < 1) penalty = 200;            // right next to wall
        else if (d2w <= inflRadiusPx) penalty = 100 / d2w;  // inside inflation
        else penalty = 5 / (d2w - inflRadiusPx + 1);        // outside — small nudge
      }

      const unknown_pen = (grid[ni] === 205) ? 10 : 0;  // unknown grey cells

      const tg = gScore[ci] + w + penalty + unknown_pen;
      if (tg < gScore[ni]) {
        gScore[ni]   = tg;
        cameFrom[ni] = ci;
        openSet.push({ idx: ni, f: tg + h(nx, ny) });
      }
    }
  }

  if (!found) {
    S.astarPath = [];
    setTimeout(() => alert('No path exists between these two points (the map is completely blocked).'), 10);
    return;
  }

  // Reconstruct raw path
  const rawPath = [];
  let cur = goalIdx;
  while (cur !== -1) {
    rawPath.push({ x: cur % W, y: Math.floor(cur / W) });
    cur = cameFrom[cur];
  }
  rawPath.reverse();

  // Smooth path with sliding-window average (wall-aware)
  const WIN = 8;
  const smoothPath = [rawPath[0]];
  for (let i = 1; i < rawPath.length - 1; i++) {
    let sumX = 0, sumY = 0, cnt = 0;
    for (let j = Math.max(0, i-WIN); j <= Math.min(rawPath.length-1, i+WIN); j++) {
      sumX += rawPath[j].x; sumY += rawPath[j].y; cnt++;
    }
    const ax = sumX/cnt, ay = sumY/cnt;
    const si = Math.round(ay)*W + Math.round(ax);
    // Only use smoothed point if it doesn't move into a wall
    if (si>=0 && si<W*H && grid[si]!==0) smoothPath.push({x:ax, y:ay});
    else smoothPath.push(rawPath[i]);
  }
  smoothPath.push(rawPath[rawPath.length-1]);
  S.astarPath = smoothPath;
}

function renderAStar(){
  if(S.tool !== 'astar') return;
  
  if(S.astarStart){
    const sc = i2c(S.astarStart.x, S.astarStart.y);
    oCtx.beginPath(); oCtx.arc(sc.x, sc.y, 6, 0, Math.PI*2);
    oCtx.fillStyle = '#22c55e'; oCtx.fill();
    oCtx.lineWidth=2; oCtx.strokeStyle='#fff'; oCtx.stroke();
  }
  if(S.astarEnd){
    const gc = i2c(S.astarEnd.x, S.astarEnd.y);
    oCtx.beginPath(); oCtx.arc(gc.x, gc.y, 6, 0, Math.PI*2);
    oCtx.fillStyle = '#ef4444'; oCtx.fill();
    oCtx.lineWidth=2; oCtx.strokeStyle='#fff'; oCtx.stroke();
  }
  
  if(S.astarPath && S.astarPath.length > 0){
    oCtx.save();
    oCtx.beginPath();
    for(let i=0; i<S.astarPath.length; i++){
      const c = i2c(S.astarPath[i].x, S.astarPath[i].y);
      if(i===0) oCtx.moveTo(c.x, c.y);
      else oCtx.lineTo(c.x, c.y);
    }
    oCtx.lineJoin = 'round';
    oCtx.lineCap = 'round';
    oCtx.lineWidth = 4;
    oCtx.strokeStyle = '#3b82f6';
    oCtx.globalAlpha = 0.8;
    oCtx.stroke();
    oCtx.restore();
  }
}