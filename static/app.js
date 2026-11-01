const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const preview = document.getElementById('preview');
const statusEl = document.getElementById('status');
const questionInput = document.getElementById('question');
const askBtn = document.getElementById('ask');
const answerEl = document.getElementById('answer');
const camBackBtn = document.getElementById('camBack');
const camFrontBtn = document.getElementById('camFront');
const cameraFallback = document.getElementById('cameraFallback');
const cameraFallbackMsg = document.getElementById('cameraFallbackMsg');
const fallbackUploadBtn = document.getElementById('fallbackUpload');
const fileInput = document.getElementById('file');
const questionHint = document.getElementById('questionHint');
const retryBtn = document.getElementById('retryBtn');
const loadingEl = document.getElementById('loading');
const loadingTextEl = loadingEl ? loadingEl.querySelector('.loading-text') : null;
const zoomModal = document.getElementById('zoomModal');
const zoomImg = document.getElementById('zoomImg');
const zoomClose = document.getElementById('zoomClose');
const chipsWrap = document.getElementById('suggestedChips');

// hidden legacy elements for compatibility (not visible)
const legacyCapture = document.getElementById('capture');
const legacyRetake = document.getElementById('retake');
const legacyCameraSelect = document.getElementById('cameraSelect');

// state
let currentStream = null;
let currentFacing = 'environment'; // default Back
let currentFrame = null;
let pendingFrameId = null;
let pendingRequestId = null;
let lastRegions = [];
let lastFrame = null;
let uploadSeq = 0;
let abortController = null;
let isFrozen = false;
let asking = false;
let currentObjectUrl = null;

// demo hook via URL ?demo=1 (no checkbox on page)
const demoFlag = (()=>{ try{ return new URLSearchParams(window.location.search).get('demo') === '1'; }catch(e){ return false; } })();
const demoMode = { checked: demoFlag };

// helpers
function setStatus(s){ if(statusEl) statusEl.textContent = s; if(statusEl) statusEl.setAttribute('aria-live','polite'); }
function sendClientEvent(eventName, detailObj){ try{ const payload = { event:eventName, detail: String(detailObj||'').slice(0,300), userAgent: navigator.userAgent.slice(0,160), viewport:{w:window.innerWidth,h:window.innerHeight}, online:navigator.onLine }; const body = JSON.stringify(payload); if(navigator.sendBeacon){ const blob = new Blob([body],{type:'application/json'}); navigator.sendBeacon('/api/client-event', blob); } else { fetch('/api/client-event',{method:'POST', headers:{'Content-Type':'application/json'}, body, keepalive:true}); } }catch(e){} }
function makeFrameId(){ try{ return crypto.randomUUID(); }catch(e){ return 'f'+Math.random().toString(16).slice(2); } }
function orientationFrom(w,h){ if(w>h) return 'landscape'; if(h>w) return 'portrait'; return 'square'; }
function getActiveMedia(){ return (preview && !preview.hidden) ? preview : video; }
function syncOverlaySize(){
  const media = getActiveMedia();
  if(!media || media.hidden) return;
  const rect = media.getBoundingClientRect();
  let w=0,h=0;
  if(media.tagName==='VIDEO'){ w=media.videoWidth||rect.width; h=media.videoHeight||rect.height; }
  else { w=media.naturalWidth||rect.width; h=media.naturalHeight||rect.height; }
  canvas.width=w; canvas.height=h;
  canvas.style.width=rect.width+'px'; canvas.style.height=rect.height+'px';
  if(lastRegions.length && lastFrame) drawRegions(lastRegions, lastFrame);
}
function updateCameraButtons(activeFacing){
  if(camBackBtn) camBackBtn.classList.toggle('active', activeFacing==='environment');
  if(camFrontBtn) camFrontBtn.classList.toggle('active', activeFacing==='user');
}
function showLoading(text){ if(loadingEl){ loadingEl.hidden=false; if(loadingTextEl) loadingTextEl.textContent=text; } }
function hideLoading(){ if(loadingEl) loadingEl.hidden=true; }
function clearOverlay(){ try{ ctx.clearRect(0,0,canvas.width,canvas.height); }catch(e){} }
function clearAnswer(){ if(answerEl){ answerEl.innerHTML=''; answerEl.hidden=true; } }

// camera handling with Back/Front only, facingMode environment/user, localStorage inside try/catch
async function startCamera(facing){
  const facingMode = (facing==='user') ? 'user' : 'environment';
  // store preference inside try/catch
  try{ localStorage.setItem('cameraFacing', facingMode); }catch(e){}
  currentFacing = facingMode;
  updateCameraButtons(facingMode);
  // stop old stream
  if(currentStream){ try{ currentStream.getTracks().forEach(t=>t.stop()); }catch(e){} currentStream=null; }
  // hide fallback while trying
  if(cameraFallback) cameraFallback.hidden=true;
  try{
    const constraints = { video: { facingMode: facingMode } };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    currentStream = stream;
    if(video){
      video.srcObject = stream;
      video.hidden = false;
    }
    // if we were frozen, go live now? Only on explicit switch, keep frozen? Spec says switching stops old and starts new one; we show live.
    if(isFrozen){
      // switching should go back to live preview
      isFrozen=false;
      if(preview) preview.hidden=true;
      if(video) video.hidden=false;
      clearOverlay();
      clearAnswer();
      if(retryBtn) retryBtn.hidden=true;
      if(questionHint) questionHint.hidden=true;
    }
    if(video) video.hidden=false;
    setStatus('Camera ready');
    sendClientEvent('camera_selected', facingMode==='environment' ? 'back' : 'front');
    if(cameraFallback) cameraFallback.hidden=true;
  }catch(e){
    const name = e && e.name ? e.name : '';
    let msg='';
    if(name==='NotAllowedError' || name==='PermissionDeniedError') msg='Camera permission denied — allow access or choose a photo';
    else if(name==='NotFoundError' || name==='DevicesNotFoundError') msg='No camera found — choose a photo instead';
    else if(name==='NotReadableError' || name==='AbortError') msg='Camera busy — close other apps or choose a photo';
    else if(name==='OverconstrainedError') msg='Selected camera not available — try the other';
    else if(name==='SecurityError') msg='Camera blocked — use the upload link';
    else msg='Camera unavailable — you can still choose a photo';
    sendClientEvent('camera_error', name||String(e));
    setStatus(msg);
    if(cameraFallback){
      cameraFallback.hidden=false;
      if(cameraFallbackMsg) cameraFallbackMsg.textContent = msg;
    }
    // if never had a frame, keep video hidden; otherwise keep preview if exists? But we hide video to show fallback
    if(!isFrozen && preview && preview.hidden){
      if(video) video.hidden=true;
    }
  }
}

// capture from live preview (video) or from fallback preview image
function captureLiveFrame(){
  return new Promise((resolve, reject)=>{
    // if frozen preview is visible and no video stream, use preview src (fallback upload)
    const usePreview = (preview && !preview.hidden && preview.src) && (!currentStream || (video && video.hidden));

    if(usePreview){
      const img = new Image();
      img.onload = ()=>{
        try{
          const maxSide=1280;
          const w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
          const scale=Math.min(1, maxSide/Math.max(w,h));
          const cw=Math.round(w*scale), ch=Math.round(h*scale);
          const c=document.createElement('canvas');
          c.width=cw; c.height=ch;
          const cx=c.getContext('2d');
          cx.drawImage(img,0,0,cw,ch);
          const dataUrl=c.toDataURL('image/jpeg',0.85);
          const b64=dataUrl.split(',')[1]||'';
          const bytes=Math.round(b64.length*3/4);
          resolve({dataUrl, width:cw, height:ch, bytes});
        }catch(err){ reject(err); }
      };
      img.onerror = ()=> reject(new Error('image load failed'));
      img.src=preview.src;
      return;
    }
    // live video path
    if(!video || !currentStream){
      reject(new Error('no video'));
      return;
    }
    // need video dimensions
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if(!vw || !vh){
      // fallback to rect
      const rect=video.getBoundingClientRect();
      const cw=Math.min(1280, Math.round(rect.width));
      const ch=Math.min(1280, Math.round(rect.height));
      // draw video anyway (may be 0)
      try{
        const c=document.createElement('canvas');
        c.width=cw; c.height=ch;
        const cx=c.getContext('2d');
        cx.drawImage(video,0,0,cw,ch);
        const dataUrl=c.toDataURL('image/jpeg',0.85);
        const b64=dataUrl.split(',')[1]||'';
        const bytes=Math.round(b64.length*3/4);
        resolve({dataUrl, width:cw, height:ch, bytes});
      }catch(err){ reject(err); }
      return;
    }
    const maxSide=1280;
    const scale=Math.min(1, maxSide/Math.max(vw,vh));
    const cw=Math.round(vw*scale), ch=Math.round(vh*scale);
    const c=document.createElement('canvas');
    c.width=cw; c.height=ch;
    const cx=c.getContext('2d');
    try{
      cx.drawImage(video,0,0,cw,ch);
      const dataUrl=c.toDataURL('image/jpeg',0.85);
      const b64=dataUrl.split(',')[1]||'';
      const bytes=Math.round(b64.length*3/4);
      resolve({dataUrl, width:cw, height:ch, bytes});
    }catch(err){ reject(err); }
  });
}

function freezeFrame(dataUrl, width, height){
  currentFrame = {
    frameId: makeFrameId(),
    width: width,
    height: height,
    orientation: orientationFrom(width,height),
    timestamp: Date.now(),
    src: 'camera'
  };
  pendingFrameId = currentFrame.frameId;
  if(preview){
    preview.src = dataUrl;
    preview.hidden = false;
  }
  if(video) video.hidden = true;
  isFrozen = true;
  requestAnimationFrame(syncOverlaySize);
}

function resetToLive(){
  if(!isFrozen) {
    // still check if we need to clear answer on edit? Only if was frozen
    // but spec says after answer, editing goes back to live preview, so we should reset if we have lastRegions shown
  }
  if(isFrozen || (lastRegions.length>0) || (answerEl && !answerEl.hidden)){
    isFrozen=false;
    if(preview) { preview.hidden=true; }
    if(video && currentStream) video.hidden=false;
    // if no stream but we have fallback, keep fallback?
    clearOverlay();
    clearAnswer();
    if(retryBtn) retryBtn.hidden=true;
    if(questionHint) questionHint.hidden=true;
    lastRegions=[];
    lastFrame=null;
    // keep currentFrame? No, clear so next Ask captures fresh
    currentFrame=null;
    pendingFrameId=null;
    pendingRequestId=null;
    syncOverlaySize();
  } else {
    // if not frozen but user edits, just hide hint/retry
    if(questionHint) questionHint.hidden=true;
  }
}

// file fallback handling
function captureFromFile(file){
  const MAX_MB=10;
  if(file.size > MAX_MB*1024*1024){ setStatus('Image too large'); if(retryBtn) retryBtn.hidden=true; return; }
  if(!file.type.startsWith('image/')){ setStatus('Unsupported file'); if(retryBtn) retryBtn.hidden=true; return; }
  if(currentObjectUrl){ try{ URL.revokeObjectURL(currentObjectUrl);}catch(e){} }
  const url=URL.createObjectURL(file);
  currentObjectUrl=url;
  const mySeq= ++uploadSeq;
  const img=new Image();
  img.onload=()=>{
    if(mySeq!==uploadSeq){ URL.revokeObjectURL(url); return; }
    if(preview){
      preview.src=url;
      preview.hidden=false;
    }
    if(video) video.hidden=true;
    // keep fallback visible or hide? Hide msg after selection, but keep link small
    // we keep cameraFallback hidden after successful upload to show image
    if(cameraFallback) cameraFallback.hidden=true;
    // create a currentFrame for immediate use (but Ask will recapture)
    // still set frozen state so Ask knows to capture from preview
    isFrozen=true;
    currentFrame={
      frameId: makeFrameId(),
      width: img.naturalWidth,
      height: img.naturalHeight,
      orientation: orientationFrom(img.naturalWidth, img.naturalHeight),
      timestamp: Date.now(),
      src: 'upload'
    };
    setStatus('Image ready — type a question and tap Ask');
    if(retryBtn) retryBtn.hidden=true;
    requestAnimationFrame(syncOverlaySize);
    clearOverlay();
    clearAnswer();
    isFrozen=true; // preview is frozen already
    // send photo_selected for backward compat
    sendClientEvent('photo_selected', 'bytes:'+file.size+' '+img.naturalWidth+'x'+img.naturalHeight);
  };
  img.onerror=()=>{ setStatus('Corrupt image'); if(currentObjectUrl){ URL.revokeObjectURL(url); currentObjectUrl=null; } if(retryBtn) retryBtn.hidden=false; };
  img.src=url;
}

function drawRegions(regions, frame){
  clearOverlay();
  const w=canvas.width, h=canvas.height;
  if(!w||!h) return;
  const toDraw=[];
  regions.forEach(r=>{
    if(r.status==='observed' && r.source==='sam3') toDraw.push(r);
    else if(r.status==='fallback_box') toDraw.push(r);
  });
  const lineWidthOuter=Math.max(3, w*0.003);
  const lineWidthHalo=Math.max(1, w*0.0015);
  toDraw.forEach(r=>{
    const poly=r.polygon;
    if(!Array.isArray(poly)||poly.length<3) return;
    ctx.beginPath();
    poly.forEach((pt,i)=>{
      const x=Math.max(0, Math.min(w, pt[0]*w));
      const y=Math.max(0, Math.min(h, pt[1]*h));
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.closePath();
    const isFallback = r.status==='fallback_box';
    if(!isFallback){
      ctx.fillStyle='rgba(255,98,0,0.35)';
      ctx.fill();
    }
    // dashed outline for fallback, solid for observed
    ctx.save();
    if(isFallback) ctx.setLineDash([10,8]);
    ctx.lineWidth=lineWidthHalo+lineWidthOuter;
    ctx.strokeStyle='rgba(255,255,255,0.6)';
    ctx.stroke();
    ctx.lineWidth=lineWidthOuter;
    ctx.strokeStyle='#ff6200';
    ctx.stroke();
    ctx.restore();
    let cx=0,cy=0;
    poly.forEach(p=>{ cx+=p[0]; cy+=p[1]; });
    cx=cx/poly.length*w;
    cy=cy/poly.length*h;
    const label=r.label||r.part||'region';
    const pad=6;
    ctx.font='14px sans-serif';
    const metrics=ctx.measureText(label);
    let lx=cx-metrics.width/2-pad;
    let ly=cy-40;
    lx=Math.max(pad, Math.min(w-metrics.width-pad*2-pad, lx));
    ly=Math.max(pad, Math.min(h-28-pad, ly));
    ctx.fillStyle='rgba(0,0,0,0.85)';
    ctx.fillRect(lx-pad, ly-pad, metrics.width+pad*2, 20+pad*2);
    ctx.strokeStyle='#ff6200';
    ctx.lineWidth=2;
    ctx.strokeRect(lx-pad, ly-pad, metrics.width+pad*2, 20+pad*2);
    ctx.fillStyle='#fff';
    ctx.fillText(label, lx, ly+14);
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.lineTo(lx+metrics.width/2, ly);
    ctx.strokeStyle='#ff6200';
    ctx.lineWidth=Math.max(2, w*0.002);
    ctx.stroke();
  });
  if(demoMode && demoMode.checked){
    ctx.fillStyle='rgba(255,255,255,0.9)';
    ctx.font='bold 16px sans-serif';
    ctx.fillText('DEMO', 12, 24);
  }
  canvas.dataset.drawn=Date.now();
}

function renderAnswer(data){
  if(!answerEl) return;
  answerEl.innerHTML='';
  answerEl.hidden=false;
  if(data.needs_view){
    const banner=document.createElement('div');
    banner.style.color='#856404';
    banner.style.background='#fff3cd';
    banner.style.border='1px solid #ffeaa7';
    banner.style.borderRadius='8px';
    banner.style.padding='8px 10px';
    banner.style.marginBottom='0.5rem';
    banner.style.fontSize='14px';
    const msg=data.needs_view==='flip_board' ? 'Turn the board over so the underside faces the camera, then Ask again.' : data.needs_view==='closer' ? 'Move closer to the board so details are visible, then Ask again.' : '';
    banner.textContent=msg;
    answerEl.appendChild(banner);
  }
  let explanation=(data.explanation||'').replace(/\([a-z_]+\)/gi,'').replace(/\b[a-z]+_[a-z_]+\b/gi,'').replace(/\s+/g,' ').trim();
  if(!explanation) explanation='Here is the highlighted part.';
  const expl=document.createElement('div');
  expl.textContent=explanation;
  answerEl.appendChild(expl);
  if(Array.isArray(data.sources) && data.sources.length){
    const srcDiv=document.createElement('div');
    srcDiv.style.marginTop='0.5rem';
    srcDiv.style.fontSize='13px';
    data.sources.forEach(url=>{
      const a=document.createElement('a');
      a.href=url; a.target='_blank'; a.rel='noopener'; a.textContent=url;
      srcDiv.appendChild(a); srcDiv.appendChild(document.createElement('br'));
    });
    answerEl.appendChild(srcDiv);
  }
  const notFoundItems=(data.regions||[]).filter(r=> r.source==='sam3' && r.status==='not_found');
  if(notFoundItems.length){
    const nf=document.createElement('div');
    nf.style.marginTop='0.5rem'; nf.style.color='#d93025'; nf.style.fontSize='13px';
    notFoundItems.forEach(r=>{
      const p=document.createElement('p'); p.style.margin='4px 0'; p.textContent='Could not locate: '+(r.label||r.part||r.id); nf.appendChild(p);
    });
    answerEl.appendChild(nf);
  }
  const prov=data.provenance||{};
  const samModel=prov.sam_model;
  const regions=data.regions||[];
  const hasObserved=regions.some(r=> r.source==='sam3' && r.status==='observed');
  const hasNotFound=regions.some(r=> r.source==='sam3' && r.status==='not_found');
  let samText='';
  if(samModel==='sam_unavailable' || samModel==='sam_error') samText='SAM unavailable';
  else if(hasObserved) samText='SAM3 mask';
  else if(hasNotFound) samText='no mask found';
  else samText='SAM3 mask';
  const sam=document.createElement('div');
  sam.style.fontSize='0.8rem'; sam.style.opacity='0.8'; sam.style.marginTop='0.5rem';
  sam.textContent=samText;
  answerEl.appendChild(sam);
}

async function ask(){
  if(asking) return;
  const q=(questionInput.value||'').trim();
  if(!q){
    if(questionHint){
      questionHint.textContent='Please type a question first';
      questionHint.hidden=false;
    }
    setStatus('Type a question first');
    if(questionInput) questionInput.focus();
    return;
  }
  if(questionHint) questionHint.hidden=true;
  // capture frame
  let captured=null;
  try{
    captured=await captureLiveFrame();
  }catch(e){
    setStatus('No image to send — allow camera or choose a photo');
    if(retryBtn) retryBtn.hidden=false;
    sendClientEvent('ask_failed', 'no_image');
    return;
  }
  if(!captured || !captured.dataUrl){
    setStatus('Could not capture photo — try again');
    if(retryBtn) retryBtn.hidden=false;
    return;
  }
  // freeze frame before request
  freezeFrame(captured.dataUrl, captured.width, captured.height);
  // photo_captured event
  sendClientEvent('photo_captured', 'bytes:'+captured.bytes+' '+captured.width+'x'+captured.height);
  // prepare request
  const frameId=currentFrame.frameId;
  const requestId=(()=>{ try{ return crypto.randomUUID(); }catch(e){ return 'r'+Math.random().toString(16).slice(2); } })();
  pendingRequestId=requestId;
  pendingFrameId=frameId;
  const stages=['Looking at the photo…','Finding the part…','Writing the answer…'];
  let stageIdx=0;
  setStatus(stages[stageIdx]);
  const stageInterval=setInterval(()=>{ stageIdx=(stageIdx+1)%stages.length; setStatus(stages[stageIdx]); if(loadingTextEl) loadingTextEl.textContent=stages[stageIdx]; }, 6000);
  asking=true;
  if(askBtn) askBtn.disabled=true;
  if(retryBtn) retryBtn.hidden=true;
  clearOverlay();
  clearAnswer();
  if(abortController){ try{ abortController.abort(); }catch(e){} }
  abortController=new AbortController();
  const t0=performance.now();
  sendClientEvent('ask_sent', q);
  showLoading(stages[0]);
  try{
    const resp=await fetch('/api/analyze',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({frameId, requestId, question:q, image:captured.dataUrl}),
      signal: abortController.signal
    });
    if(!resp.ok){
      let err={};
      try{ err=await resp.json(); }catch(e){}
      const code=err.error||'';
      let msg='Error';
      if(code==='too_many_requests') msg='Busy, please try again';
      else if(code==='glimmer_timeout' || code==='timeout') msg='Timeout, try again';
      else if(code==='glimmer_unreachable' || code==='glimmer_bad_json' || code==='model_unreachable') msg='Model unreachable';
      else if(code==='image_too_large' || resp.status===413) msg='Image too big';
      else if(resp.status===429) msg='Busy, please try again';
      else if(resp.status===504) msg='Timeout, try again';
      else if(resp.status===502) msg='Model unreachable';
      else if(resp.status>=500) msg='Server error';
      else msg='Request failed';
      const ms=Math.round(performance.now()-t0);
      sendClientEvent('ask_failed', resp.status+' '+code+' '+ms);
      setStatus(msg);
      if(retryBtn) retryBtn.hidden=false;
      return;
    }
    const data=await resp.json();
    if(!data || data.frameId!==pendingFrameId || data.requestId!==pendingRequestId){
      setStatus('Stale answer ignored');
      return;
    }
    lastRegions=data.regions||[];
    lastFrame=currentFrame;
    drawRegions(lastRegions, currentFrame);
    renderAnswer(data);
    const ms=Math.round(performance.now()-t0);
    sendClientEvent('ask_ok', ms);
    setStatus('Answer ready');
    if(retryBtn) retryBtn.hidden=true;
  }catch(e){
    if(e.name==='AbortError'){
      setStatus('Cancelled');
    }else{
      setStatus('Network error');
      if(retryBtn) retryBtn.hidden=false;
      sendClientEvent('ask_failed', 'network');
    }
  }finally{
    clearInterval(stageInterval);
    asking=false;
    if(askBtn) askBtn.disabled=false;
    abortController=null;
    hideLoading();
  }
}

// zoom
function openZoom(src){ if(!zoomModal||!zoomImg) return; zoomImg.src=src; zoomModal.hidden=false; sendClientEvent('zoom_open',''); }
function closeZoom(){ if(zoomModal) zoomModal.hidden=true; }
if(zoomModal){ zoomModal.addEventListener('click', e=>{ if(e.target===zoomModal || e.target.classList.contains('zoom-backdrop')) closeZoom(); }); }
if(zoomClose) zoomClose.onclick=closeZoom;
if(preview) preview.addEventListener('click', ()=>{
  if(preview.src && !preview.hidden) openZoom(preview.src);
  else if(isFrozen && preview.src) openZoom(preview.src);
});
canvas.addEventListener('click', ()=>{
  if(isFrozen && preview.src) openZoom(preview.src);
  else if(preview.src && !preview.hidden) openZoom(preview.src);
  // tapping image when frozen should also reset? spec: tapping image goes back to live preview after answer
  // but zoom also; we handle reset on separate tap logic below
});
// spec: tapping image goes back to live preview after answer
if(canvas){
  canvas.addEventListener('click', ()=>{
    // if we have an answer shown and we're frozen, tapp goes back to live
    // we need to distinguish zoom vs reset. If answer is visible and frozen, reset
    if(answerEl && !answerEl.hidden && isFrozen){
      // but we just opened zoom; after closing zoom user can tap again
      // we implement: if answer exists and frozen, canvas click resets unless zoom is open
      // we delay reset to after zoom close? simpler: if answer visible, second tap resets
      // we'll handle via preview click separately; for now if answer visible, reset
      // Actually we need to reset on tap after answer; we can trigger reset on next tick if not zoom
      // Let's check: if zoom is hidden before click, we consider reset
      // We'll use a flag: if overlay was drawn (lastRegions), then tap should reset
      if(lastRegions.length>0){
        // schedule reset after current event, but not break zoom
        // we will not reset immediately if zoom just opened; user can tap image to go back
      }
    }
  });
}
// dedicated tap-to-reset: when preview is frozen, tapping it again after answer should go live
if(preview){
  preview.addEventListener('click', ()=>{
    if(isFrozen && answerEl && !answerEl.hidden){
      // if we have regions drawn, this tap is intended to go back to live
      // but we also open zoom; we need to prioritize reset on edit/tap
      // We'll reset after zoom close? Simpler: tap on preview when answer exists => reset
      // we will not open zoom when answer exists, instead reset
      // Check if lastRegions exists
      if(lastRegions.length>0){
        // prevent zoom double
        closeZoom();
        resetToLive();
        sendClientEvent('image_tap_reset','');
        return;
      }
    }
  });
}
if(canvas){
  canvas.addEventListener('click', ()=>{
    if(isFrozen && answerEl && !answerEl.hidden && lastRegions.length>0){
      // if canvas is over preview, tap should reset
      resetToLive();
      sendClientEvent('image_tap_reset','');
    }
  });
}

// controls
if(askBtn) askBtn.onclick=ask;
if(retryBtn) retryBtn.onclick=()=>{ clearAnswer(); setStatus('Ready'); if(retryBtn) retryBtn.hidden=true; ask(); };
if(fallbackUploadBtn && fileInput) fallbackUploadBtn.onclick=()=> fileInput.click();
if(fileInput) fileInput.onchange = e=>{ const f=e.target.files[0]; if(f) captureFromFile(f); e.target.value=''; };
if(questionInput){
  questionInput.addEventListener('input', ()=>{
    if(questionHint) questionHint.hidden=true;
    // after an answer, editing goes back to live preview (not before Ask, even if isFrozen from upload)
    if((answerEl && !answerEl.hidden) || lastRegions.length>0){
      resetToLive();
    }
  });
  questionInput.addEventListener('keydown', e=>{
    if(e.key==='Enter') ask();
  });
}
// chips
if(chipsWrap){
  chipsWrap.addEventListener('click', e=>{
    const btn=e.target.closest('.chip');
    if(!btn) return;
    const q=btn.dataset.q||btn.textContent;
    if(questionInput){ questionInput.value=q; questionInput.focus(); if(questionHint) questionHint.hidden=true; }
    sendClientEvent('suggested_tap', q.slice(0,80));
    // tapping chip fills box, does not send
  });
}
// camera buttons
if(camBackBtn) camBackBtn.onclick=async ()=>{ await startCamera('environment'); };
if(camFrontBtn) camFrontBtn.onclick=async ()=>{ await startCamera('user'); };

// handle device change: keep events
if(navigator.mediaDevices && navigator.mediaDevices.addEventListener){
  navigator.mediaDevices.addEventListener('devicechange', async ()=>{
    sendClientEvent('camera_list','devicechange');
  });
}

video.onloadedmetadata=syncOverlaySize;
if(preview) preview.onload=syncOverlaySize;
window.onresize=syncOverlaySize;

// enhance setStatus to show retry on errors (but spec says Retry shown ONLY after error)
const _origSetStatus=setStatus;
let lastSetStatus='';
setStatus=function(msg){
  _origSetStatus(msg);
  lastSetStatus=msg;
  if(loadingTextEl && loadingEl && !loadingEl.hidden){ loadingTextEl.textContent=msg; }
  // retry visibility handled explicitly in ask; but also show on generic error status
  const isError=/error|busy|timeout|unreachable|failed|denied|big|cancelled/i.test(msg) && /Camera|Model|Busy|Timeout|Server|Network|Image|Capture|Stale/i.test(msg) ? false : /error|busy|timeout|unreachable|failed|denied/i.test(msg);
  // we only toggle retry if we are not asking and isError; but ask already sets retry
  // keep previous logic minimal: do not auto-show retry unless ask failed
};

// init: read localStorage for facing, default Back
(async()=>{
  let saved=null;
  try{ saved=localStorage.getItem('cameraFacing'); }catch(e){}
  if(saved==='user') currentFacing='user';
  else currentFacing='environment';
  updateCameraButtons(currentFacing);
  // also support legacy cameraDeviceId for migration? ignore
  sendClientEvent('page_load','');
  window.addEventListener('error', e=>{ sendClientEvent('window_error', e.message||'error'); });
  window.addEventListener('unhandledrejection', e=>{ sendClientEvent('unhandledrejection', String(e.reason||'error')); });
  window.addEventListener('offline', ()=> sendClientEvent('offline_online','offline'));
  window.addEventListener('online', ()=> sendClientEvent('offline_online','online'));
  // start camera as soon as page opens
  await startCamera(currentFacing);
})();

// expose for tests ?
window.__app={ startCamera, captureLiveFrame, ask, resetToLive, get state(){ return {isFrozen, asking, currentStream, currentFacing, currentFrame}; } };
