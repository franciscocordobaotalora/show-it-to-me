const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const preview = document.getElementById('preview');
const statusEl = document.getElementById('status');
const captureBtn = document.getElementById('capture');
const retakeBtn = document.getElementById('retake');
const uploadBtn = document.getElementById('upload');
const fileInput = document.getElementById('file');
const questionInput = document.getElementById('question');
const askBtn = document.getElementById('ask');
const demoMode = document.getElementById('demoMode');
const answerEl = document.getElementById('answer');

let currentFrame = null;
let pendingFrameId = null;
let pendingRequestId = null;
let lastRegions = [];
let lastFrame = null;
let uploadSeq = 0;
let abortController = null;

function setStatus(s){ statusEl.textContent = s; statusEl.setAttribute('aria-live','polite'); }

function getActiveMedia(){ return preview.hidden ? video : preview; }

function syncOverlaySize(){
  const media = getActiveMedia();
  if(!media || media.hidden){ return; }
  const rect = media.getBoundingClientRect();
  let w = 0, h = 0;
  if(media.tagName === 'VIDEO'){
    w = media.videoWidth || rect.width;
    h = media.videoHeight || rect.height;
  }else{
    w = media.naturalWidth || rect.width;
    h = media.naturalHeight || rect.height;
  }
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  if(lastRegions.length && lastFrame){
    drawRegions(lastRegions, lastFrame);
  }
}

async function startCamera(){
  try{
    const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
    video.srcObject = stream;
    setStatus('Camera ready');
  }catch(e){
    // Do not overwrite a newer user status
    if(!currentFrame && statusEl.textContent === 'Ready'){
      setStatus('Camera unavailable – use upload');
      video.hidden = true;
    }
  }
}

function makeFrameId(){ return crypto.randomUUID(); }
function orientationFrom(w,h){ return w>=h?'landscape':'portrait'; }

function captureFromVideo(){
  const w = video.videoWidth, h = video.videoHeight;
  if(!w||!h){ setStatus('No video'); return; }
  uploadSeq++;
  lastRegions = [];
  lastFrame = null;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d').drawImage(video,0,0,w,h);
  preview.src = tmp.toDataURL('image/png');
  preview.hidden = false;
  video.hidden = true;
  currentFrame = {
    frameId: makeFrameId(),
    width: w, height: h,
    orientation: orientationFrom(w,h),
    timestamp: Date.now(),
    src: 'camera'
  };
  retakeBtn.hidden = false;
  setStatus('Frame captured');
  clearOverlay();
  clearAnswer();
}

let currentObjectUrl = null;
function captureFromFile(file){
  const MAX_MB = 10;
  if(file.size > MAX_MB*1024*1024){ setStatus('Image too large'); return; }
  if(!file.type.startsWith('image/')){ setStatus('Unsupported file'); return; }
  if(currentObjectUrl){ URL.revokeObjectURL(currentObjectUrl); }
  const url = URL.createObjectURL(file);
  currentObjectUrl = url;
  const mySeq = ++uploadSeq;
  const img = new Image();
  img.onload = ()=>{
    if(mySeq !== uploadSeq){ URL.revokeObjectURL(url); return; }
    preview.src = url;
    preview.hidden = false;
    video.hidden = true;
    currentFrame = {
      frameId: makeFrameId(),
      width: img.naturalWidth,
      height: img.naturalHeight,
      orientation: orientationFrom(img.naturalWidth, img.naturalHeight),
      timestamp: Date.now(),
      src: 'upload'
    };
    retakeBtn.hidden = false;
    setStatus('Image uploaded');
    requestAnimationFrame(syncOverlaySize);
    clearOverlay();
    clearAnswer();
  };
  img.onerror = ()=>{ setStatus('Corrupt image'); URL.revokeObjectURL(url); currentObjectUrl = null; };
  img.src = url;
}

function clearOverlay(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
}

function clearAnswer(){
  if(answerEl){
    answerEl.innerHTML = '';
    answerEl.hidden = true;
  }
}

function prepareImageDataUrl(){
  return new Promise((resolve)=>{
    if(!preview.src){ resolve(null); return; }
    const img = new Image();
    img.onload = ()=>{
      const maxSide = 1280;
      const w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, maxSide / Math.max(w,h));
      const cw = Math.round(w*scale), ch = Math.round(h*scale);
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const cx = c.getContext('2d');
      cx.drawImage(img,0,0,cw,ch);
      const dataUrl = c.toDataURL('image/jpeg',0.88);
      resolve(dataUrl);
    };
    img.onerror = ()=> resolve(null);
    img.src = preview.src;
  });
}

function drawRegions(regions, frame){
  clearOverlay();
  const w = canvas.width, h = canvas.height;
  if(!w || !h) return;
  const observed = [];
  regions.forEach(r=>{
    if(r.source !== 'sam3') return;
    if(r.status === 'observed'){
      observed.push(r);
    }
  });
  const lineWidthOuter = Math.max(3, w*0.003);
  const lineWidthHalo = Math.max(1, w*0.0015);
  observed.forEach(r=>{
    const poly = r.polygon;
    if(!Array.isArray(poly) || poly.length < 3) return;
    ctx.beginPath();
    poly.forEach((pt,i)=>{
      const x = Math.max(0, Math.min(w, pt[0]*w));
      const y = Math.max(0, Math.min(h, pt[1]*h));
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,98,0,0.35)';
    ctx.fill();
    // white halo
    ctx.lineWidth = lineWidthHalo + lineWidthOuter;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.stroke();
    // orange outline
    ctx.lineWidth = lineWidthOuter;
    ctx.strokeStyle = '#ff6200';
    ctx.stroke();
    // centroid
    let cx = 0, cy = 0;
    poly.forEach(p=>{ cx += p[0]; cy += p[1]; });
    cx = cx/poly.length * w;
    cy = cy/poly.length * h;
    const label = r.label || r.part || 'region';
    const pad = 6;
    ctx.font = '14px sans-serif';
    const metrics = ctx.measureText(label);
    let lx = cx - metrics.width/2 - pad;
    let ly = cy - 40;
    // keep chip inside image
    lx = Math.max(pad, Math.min(w - metrics.width - pad*2 - pad, lx));
    ly = Math.max(pad, Math.min(h - 28 - pad, ly));
    // label chip
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(lx - pad, ly - pad, metrics.width + pad*2, 20 + pad*2);
    ctx.strokeStyle = '#ff6200';
    ctx.lineWidth = 2;
    ctx.strokeRect(lx - pad, ly - pad, metrics.width + pad*2, 20 + pad*2);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx, ly + 14);
    // arrow
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(lx + metrics.width/2, ly);
    ctx.strokeStyle = '#ff6200';
    ctx.lineWidth = Math.max(2, w*0.002);
    ctx.stroke();
  });
  // demo label
  if(demoMode && demoMode.checked){
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('DEMO', 12, 24);
  }
  canvas.dataset.drawn = Date.now();
}

function renderAnswer(data){
  if(!answerEl) return;
  answerEl.innerHTML = '';
  answerEl.hidden = false;
  // needs_view banner
  if(data.needs_view){
    const banner = document.createElement('div');
    banner.style.color = '#ffcc00';
    banner.style.marginBottom = '0.5rem';
    const msg = data.needs_view === 'flip_board'
      ? 'Turn the board over so the underside faces the camera, then Retake and Ask again.'
      : data.needs_view === 'closer'
      ? 'Move closer to the board so details are visible, then Retake and Ask again.'
      : '';
    banner.textContent = msg;
    answerEl.appendChild(banner);
  }
  // explanation with id stripping
  let explanation = (data.explanation || '').replace(/\([a-z_]+\)/gi, '').replace(/\b[a-z]+_[a-z_]+\b/gi, '').replace(/\s+/g, ' ').trim();
  const expl = document.createElement('div');
  expl.textContent = explanation;
  answerEl.appendChild(expl);
  // sources
  if(Array.isArray(data.sources) && data.sources.length){
    const srcDiv = document.createElement('div');
    srcDiv.style.marginTop = '0.5rem';
    data.sources.forEach(url=>{
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = url;
      srcDiv.appendChild(a);
      srcDiv.appendChild(document.createElement('br'));
    });
    answerEl.appendChild(srcDiv);
  }
  // not found list
  const notFoundItems = (data.regions||[]).filter(r=> r.source==='sam3' && r.status==='not_found');
  if(notFoundItems.length){
    const nf = document.createElement('div');
    nf.style.marginTop = '0.5rem';
    nf.style.color = '#f88';
    notFoundItems.forEach(r=>{
      const p = document.createElement('p');
      p.textContent = 'Could not locate: ' + (r.label || r.part || r.id);
      nf.appendChild(p);
    });
    answerEl.appendChild(nf);
  }
  // provenance sam status - honest
  const prov = data.provenance || {};
  const samModel = prov.sam_model;
  const regions = data.regions || [];
  const hasObserved = regions.some(r=> r.source==='sam3' && r.status==='observed');
  const hasNotFound = regions.some(r=> r.source==='sam3' && r.status==='not_found');
  let samText = '';
  if(samModel === 'sam_unavailable' || samModel === 'sam_error'){
    samText = 'SAM unavailable';
  }else if(hasObserved){
    samText = 'SAM3 mask';
  }else if(hasNotFound){
    samText = 'no mask found';
  }else{
    samText = 'SAM3 mask';
  }
  const sam = document.createElement('div');
  sam.style.fontSize = '0.8rem';
  sam.style.opacity = '0.8';
  sam.style.marginTop = '0.5rem';
  sam.textContent = samText;
  answerEl.appendChild(sam);
}

async function ask(){
  if(askBtn.disabled){ setStatus('Busy, please try again'); return; }
  if(!currentFrame){ setStatus('Capture first'); return; }
  const q = questionInput.value.trim();
  if(!q){ setStatus('Enter a question'); return; }
  const imageDataUrl = await prepareImageDataUrl();
  if(!imageDataUrl){ setStatus('Image unavailable'); return; }
  const frameId = currentFrame.frameId;
  const requestId = crypto.randomUUID();
  pendingFrameId = frameId;
  pendingRequestId = requestId;
  setStatus('Looking... can take up to a minute');
  askBtn.disabled = true;
  clearOverlay();
  clearAnswer();
  if(abortController){ try{ abortController.abort(); }catch{} }
  abortController = new AbortController();
  try{
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({frameId, requestId, question: q, image: imageDataUrl}),
      signal: abortController.signal
    });
    if(!resp.ok){
      let err = {};
      try{ err = await resp.json(); }catch{}
      const code = err.error || '';
      let msg = 'Error';
      if(code === 'too_many_requests') msg = 'Busy, please try again';
      else if(code === 'glimmer_timeout' || code === 'timeout') msg = 'Timeout, try again';
      else if(code === 'glimmer_unreachable' || code === 'glimmer_bad_json' || code === 'model_unreachable') msg = 'Model unreachable';
      else if(code === 'image_too_large' || resp.status === 413) msg = 'Image too big';
      else if(resp.status === 429) msg = 'Busy, please try again';
      else if(resp.status === 504) msg = 'Timeout, try again';
      else if(resp.status === 502) msg = 'Model unreachable';
      else if(resp.status >=500) msg = 'Server error';
      else msg = 'Request failed';
      setStatus(msg);
      return;
    }
    const data = await resp.json();
    // stale check
    if(!data || data.frameId !== pendingFrameId || data.requestId !== pendingRequestId || data.frameId !== currentFrame.frameId){
      setStatus('Stale answer ignored');
      return;
    }
    lastRegions = data.regions || [];
    lastFrame = currentFrame;
    drawRegions(lastRegions, currentFrame);
    renderAnswer(data);
    setStatus('Answer ready');
  }catch(e){
    if(e.name === 'AbortError'){
      setStatus('Cancelled');
    }else{
      setStatus('Network error');
    }
  }finally{
    askBtn.disabled = false;
    abortController = null;
  }
}

captureBtn.onclick = captureFromVideo;
retakeBtn.onclick = ()=>{
  if(abortController){ try{ abortController.abort(); }catch{} }
  uploadSeq++;
  currentFrame = null;
  pendingFrameId = null;
  pendingRequestId = null;
  lastRegions = [];
  lastFrame = null;
  if(currentObjectUrl){ URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
  preview.hidden = true;
  video.hidden = false;
  retakeBtn.hidden = true;
  setStatus('Ready');
  clearOverlay();
  clearAnswer();
  syncOverlaySize();
};
uploadBtn.onclick = ()=> fileInput.click();
fileInput.onchange = e=>{ const f=e.target.files[0]; if(f) captureFromFile(f); };
askBtn.onclick = ask;

video.onloadedmetadata = syncOverlaySize;
preview.onload = syncOverlaySize;
window.onresize = syncOverlaySize;
startCamera();
