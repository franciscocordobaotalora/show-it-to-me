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
const cameraSelectWrap = document.getElementById('cameraSelectWrap');
const cameraSelect = document.getElementById('cameraSelect');
const camBackBtn = document.getElementById('camBack');
const camFrontBtn = document.getElementById('camFront');

let currentFrame = null;
let pendingFrameId = null;
let pendingRequestId = null;
let lastRegions = [];
let lastFrame = null;
let uploadSeq = 0;
let abortController = null;
let currentStream = null;
let selectedDeviceId = null;

function setStatus(s){ statusEl.textContent = s; statusEl.setAttribute('aria-live','polite'); }

function sendClientEvent(eventName, detailObj){ try{ const payload = { event:eventName, detail: String(detailObj||'') .slice(0,300), userAgent: navigator.userAgent.slice(0,160), viewport:{w:window.innerWidth,h:window.innerHeight}, online:navigator.onLine }; const body = JSON.stringify(payload); if(navigator.sendBeacon){ const blob = new Blob([body],{type:'application/json'}); navigator.sendBeacon('/api/client-event', blob); } else { fetch('/api/client-event',{method:'POST', headers:{'Content-Type':'application/json'}, body, keepalive:true}); } }catch(e){} }

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

async function startCamera(deviceIdOrConstraints){
  try{
    if(currentStream){ currentStream.getTracks().forEach(t=>t.stop()); currentStream=null; }
    let constraints = {video:true};
    if(deviceIdOrConstraints){
      if(typeof deviceIdOrConstraints==='string'){
        constraints.video = {deviceId:{exact:deviceIdOrConstraints}};
      }else{
        constraints = deviceIdOrConstraints;
      }
    }else{
      const saved = (()=>{ try{ return localStorage.getItem('cameraDeviceId'); }catch(e){ return null; }})();
      if(saved){ constraints.video = {deviceId:{exact:saved}}; }
      else { constraints.video = {facingMode:'environment'}; }
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    currentStream = stream;
    video.srcObject = stream;
    video.hidden = false;
    setStatus('Camera ready');
    if(cameraSelectWrap){ cameraSelectWrap.hidden = false; }
    // enumerate devices after permission
    await enumerateCameras();
    sendClientEvent('camera_selected', 'camera ready');
  }catch(e){
    const name = e.name||'';
    let msg = '';
    if(name==='NotAllowedError' || name==='PermissionDeniedError') msg='Camera permission denied \u2013 allow access or use upload';
    else if(name==='NotFoundError' || name==='DevicesNotFoundError') msg='No camera found \u2013 use upload';
    else if(name==='NotReadableError' || name==='AbortError') msg='Camera busy \u2013 close other apps or try another camera';
    else if(name==='OverconstrainedError') msg='Selected camera not available \u2013 choose another';
    else if(name==='SecurityError') msg='Camera blocked \u2013 use upload';
    else msg='Camera unavailable \u2013 use upload';
    sendClientEvent('camera_error', name||String(e));
    setStatus(msg);
    // keep video hidden if never captured
    if(!currentFrame) video.hidden = true;
    if(cameraSelectWrap) cameraSelectWrap.hidden = false;
  }
}

async function enumerateCameras(){
  try{
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(d=>d.kind==='videoinput');
    if(cameraSelect){
      cameraSelect.innerHTML='';
      if(videoInputs.length===0){
        const opt=document.createElement('option'); opt.value=''; opt.textContent='No cameras'; cameraSelect.appendChild(opt);
        sendClientEvent('camera_list', 0);
        setStatus('No camera found \u2013 use upload');
        return;
      }
      videoInputs.forEach(d=>{ const opt=document.createElement('option'); opt.value=d.deviceId; opt.textContent=d.label||('Camera '+(cameraSelect.options.length+1)); cameraSelect.appendChild(opt); });
    }
    sendClientEvent('camera_list', videoInputs.length);
    // select saved or first
    let chosen = null;
    try{ chosen = localStorage.getItem('cameraDeviceId'); }catch(e){}
    if(chosen && videoInputs.find(d=>d.deviceId===chosen)){ cameraSelect.value = chosen; selectedDeviceId = chosen; }
    else if(videoInputs.length){ cameraSelect.value = videoInputs[0].deviceId; selectedDeviceId = videoInputs[0].deviceId; try{ localStorage.setItem('cameraDeviceId', selectedDeviceId); }catch(e){} }
  }catch(e){ sendClientEvent('camera_error', e.name||String(e)); }
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
  sendClientEvent('photo_selected', w + 'x' + h + ' bytes:' + (w*h*3));
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
    sendClientEvent('photo_selected', 'bytes:'+file.size+' '+img.naturalWidth+'x'+img.naturalHeight);
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
  const stages = ['Looking at the photo...','Finding the part...','Writing the answer...'];
  let stageIdx = 0;
  setStatus(stages[stageIdx]);
  const stageInterval = setInterval(()=>{ stageIdx = (stageIdx+1)%stages.length; setStatus(stages[stageIdx]); }, 6000);
  askBtn.disabled = true;
  clearOverlay();
  clearAnswer();
  if(abortController){ try{ abortController.abort(); }catch{} }
  abortController = new AbortController();
  const t0 = performance.now();
  sendClientEvent('ask_sent', q);
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
      const ms = Math.round(performance.now() - t0);
      sendClientEvent('ask_failed', resp.status + ' ' + code + ' ' + ms);
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
    const ms = Math.round(performance.now() - t0);
    sendClientEvent('ask_ok', ms);
    setStatus('Answer ready');
  }catch(e){
    if(e.name === 'AbortError'){
      setStatus('Cancelled');
    }else{
      setStatus('Network error');
    }
  }finally{
    clearInterval(stageInterval);
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

if(cameraSelect){ cameraSelect.onchange = async ()=>{ const id = cameraSelect.value; if(!id) return; try{ localStorage.setItem('cameraDeviceId', id); }catch(e){} selectedDeviceId = id; const label = cameraSelect.options[cameraSelect.selectedIndex]?.textContent || id; sendClientEvent('camera_selected', label); await startCamera(id); } }
if(camBackBtn){ camBackBtn.onclick = async ()=>{ try{ await startCamera({video:{facingMode:'environment'}}); sendClientEvent('camera_selected','back'); }catch(e){} } }
if(camFrontBtn){ camFrontBtn.onclick = async ()=>{ try{ await startCamera({video:{facingMode:'user'}}); sendClientEvent('camera_selected','front'); }catch(e){} } }
if(navigator.mediaDevices){ navigator.mediaDevices.addEventListener('devicechange', async ()=>{
  const hadSelection = selectedDeviceId;
  await enumerateCameras();
  // if previous selection disappeared, notify
  const stillThere = cameraSelect && Array.from(cameraSelect.options).some(o=>o.value===hadSelection);
  if(hadSelection && !stillThere){
    setStatus('Selected camera disconnected \u2013 choose another');
    sendClientEvent('camera_error','device_unplugged');
  } else {
    sendClientEvent('camera_list','devicechange');
  }
}); }

video.onloadedmetadata = syncOverlaySize;
preview.onload = syncOverlaySize;
window.onresize = syncOverlaySize;

// suggested chips
const chips = document.getElementById('suggestedChips');
if(chips){ chips.addEventListener('click', e=>{ const btn=e.target.closest('.chip'); if(!btn) return; const q=btn.dataset.q||btn.textContent; if(questionInput){ questionInput.value=q; questionInput.focus(); } sendClientEvent('suggested_tap', q.slice(0,80)); }); }

// loading overlay
const loadingEl = document.getElementById('loading');
const loadingTextEl = loadingEl ? loadingEl.querySelector('.loading-text') : null;
function showLoading(text){ if(loadingEl){ loadingEl.hidden=false; if(loadingTextEl) loadingTextEl.textContent=text; } }
function hideLoading(){ if(loadingEl) loadingEl.hidden=true; }

// patch ask loading integration
const _origSetStatus = setStatus;
// tap-to-zoom
const zoomModal = document.getElementById('zoomModal');
const zoomImg = document.getElementById('zoomImg');
const zoomClose = document.getElementById('zoomClose');
function openZoom(src){ if(!zoomModal||!zoomImg) return; zoomImg.src=src; zoomModal.hidden=false; sendClientEvent('zoom_open',''); }
function closeZoom(){ if(zoomModal) zoomModal.hidden=true; }
if(zoomModal){ zoomModal.addEventListener('click', e=>{ if(e.target===zoomModal || e.target.classList.contains('zoom-backdrop')) closeZoom(); }); }
if(zoomClose) zoomClose.onclick=closeZoom;
if(preview) preview.addEventListener('click', ()=>{ if(preview.src && !preview.hidden) openZoom(preview.src); });
canvas.addEventListener('click', ()=>{ if(preview.src && !preview.hidden) openZoom(preview.src); else if(currentStream) openZoom(video.srcObject ? '' : ''); });

// retry helper (expose via status retry)
const retryBtn = document.getElementById('retryBtn');
if(retryBtn) retryBtn.onclick = ()=>{ clearAnswer(); setStatus('Ready'); ask(); };
// enhance setStatus to show retry on errors
const _setStatusOrig = setStatus;
setStatus = function(msg){
  _setStatusOrig(msg);
  if(loadingTextEl && loadingEl && !loadingEl.hidden){ loadingTextEl.textContent=msg; }
  const isError = /error|busy|timeout|unreachable|failed|denied/i.test(msg);
  if(retryBtn){ retryBtn.hidden = !isError; }
};

// hook loading into ask: wrap fetch stages
// monkey-patch ask to show loading
const _askOrig = ask;
ask = async function(){
  const q = questionInput.value.trim();
  if(!currentFrame && !askBtn.disabled){ _setStatusOrig('Capture first'); return; }
  if(!q && !askBtn.disabled){ _setStatusOrig('Enter a question'); return; }
  showLoading('Looking at the photo...');
  try{ await _askOrig(); } finally { hideLoading(); }
};

// page load client event
sendClientEvent('page_load','');
window.addEventListener('error', e=>{ sendClientEvent('window_error', e.message||'error'); });
window.addEventListener('unhandledrejection', e=>{ sendClientEvent('unhandledrejection', String(e.reason||'error')); });
window.addEventListener('offline', ()=> sendClientEvent('offline_online','offline'));
window.addEventListener('online', ()=> sendClientEvent('offline_online','online'));

startCamera();
