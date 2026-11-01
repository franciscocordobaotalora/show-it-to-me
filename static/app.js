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
const tapStart = document.getElementById('tapStart');
let wakeLock = null;
// Live mode elements
const liveToggle = document.getElementById('liveToggle');
const liveBar = document.getElementById('liveBar');
const liveStateEl = document.getElementById('liveState');
const levelMeter = document.getElementById('levelMeter');
const levelBar = document.getElementById('levelBar');
const stopBtn = document.getElementById('stopBtn');
const transcriptBubble = document.getElementById('transcriptBubble');
const subtitlesEl = document.getElementById('subtitles');
// Live audio state (an earlier voice project pattern)
let liveEnabled = false;
let liveCtx = null, liveStream = null, liveMicNode = null, liveSink = null, liveMaster = null, liveOutputEl = null, liveOutDest = null, liveSources = new Set();
let liveNextTime = 0;
let liveBlocks = []; // collected Int16 blocks for current utterance
let liveVADState = null;
let liveSpeaking = false;
let liveSpeechStartFrame = null;
let liveLatency = {};
let livePausedForPlayback = false;
let liveAudioUnlocked = false;

// iOS API guards: check availability with fallbacks (an earlier voice project pattern)
function safeAt(arr, idx){ try{ if(Array.prototype.at) return arr.at(idx); }catch(e){} return arr[idx<0?arr.length+idx:idx]; }
function safeStructuredClone(obj){ try{ if(typeof structuredClone==='function') return structuredClone(obj); }catch(e){} return JSON.parse(JSON.stringify(obj)); }

// wakeLock for iPhone (keep screen awake during camera, like our earlier voice app call)
async function requestWakeLock(){ try{ if('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }catch(e){} }
function releaseWakeLock(){ try{ if(wakeLock){ wakeLock.release(); wakeLock=null; } }catch(e){} }
// audioSession guard (iOS, like our earlier voice app)
function audioSession(type){ try{ if(navigator.audioSession) navigator.audioSession.type = type; }catch(e){} }

// demo hook via URL ?demo=1 (no checkbox on page)
const demoFlag = (()=>{ try{ return new URLSearchParams(window.location.search).get('demo') === '1'; }catch(e){ return false; } })();
const demoMode = { checked: demoFlag };

// helpers
function setStatus(s){ if(statusEl) statusEl.textContent = s; if(statusEl) statusEl.setAttribute('aria-live','polite'); }
function sendClientEvent(eventName, detailObj){ try{ const payload = { event:eventName, detail: String(detailObj||'').slice(0,300), userAgent: navigator.userAgent.slice(0,160), viewport:{w:window.innerWidth,h:window.innerHeight}, online:navigator.onLine }; const body = JSON.stringify(payload); if(navigator.sendBeacon){ const blob = new Blob([body],{type:'application/json'}); navigator.sendBeacon('/api/client-event', blob); } else { fetch('/api/client-event',{method:'POST', headers:{'Content-Type':'application/json'}, body, keepalive:true}); } }catch(e){} }
// Live helpers
function setLiveState(s){ if(liveStateEl) liveStateEl.textContent = s; logLatency(s.toLowerCase().replace(' ','_')); }
function updateLevelMeter(level){ if(levelBar) levelBar.style.width = Math.min(100, Math.round(level*300))+'%'; }
function logLatency(evt){ const ts = Date.now(); liveLatency[evt] = ts; try{ sendClientEvent(evt, String(ts)); }catch(e){} }
function buildWavFromBlocks(blocks, sampleRate=16000){
  const total = blocks.reduce((a,b)=>a+b.length,0);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  function ws(o,str){ for(let i=0;i<str.length;i++) view.setUint8(o+i,str.charCodeAt(i)); }
  const byteRate = sampleRate*2; ws(0,'RIFF'); view.setUint32(4,36+total*2,true); ws(8,'WAVE'); ws(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,sampleRate,true); view.setUint32(28,byteRate,true); view.setUint16(32,2,true); view.setUint16(34,16,true); ws(36,'data'); view.setUint32(40,total*2,true);
  const wav = new Uint8Array(44+total*2);
  wav.set(new Uint8Array(header),0);
  let off=44;
  for(const b of blocks){ for(let i=0;i<b.length;i++){ const s=b[i]; wav[off++]=s & 0xff; wav[off++]=(s>>8)&0xff; } }
  return wav;
}
function computeLevelInt16(block){ let sum=0; for(let i=0;i<block.length;i++){ const v=block[i]/32768; sum+=v*v; } return Math.sqrt(sum/block.length); }
function splitSentencesLive(text){
  if(window.LiveAudio && window.LiveAudio.splitSentences) return window.LiveAudio.splitSentences(text);
  if(!text) return [];
  const raw=text.split(/(?<=[.!?])\s+/);
  const out=[]; let cur='';
  for(const s of raw){ const t=s.trim(); if(!t) continue; const cand=cur?cur+' '+t:t; if(cand.length>400){ if(cur) out.push(cur); if(t.length>400){ let p=0; while(p<t.length){ out.push(t.slice(p,p+400)); p+=400;} cur='';} else cur=t; } else cur=cand; }
  if(cur) out.push(cur); return out.map(s=>/[.!?]$/.test(s)?s:s+'.');
}
async function unlockAudioForIOS(){
  try{
    if(!liveCtx) return;
    if(liveCtx.state==='suspended') await liveCtx.resume();
    // speak empty utterance to unlock SpeechSynthesis on iOS if fallback needed
    try{ const u=new SpeechSynthesisUtterance(''); u.volume=0; window.speechSynthesis.speak(u); }catch(e){}
    liveAudioUnlocked=true;
  }catch(e){}
}
async function connectLiveOutput(){
  if(!liveCtx) return;
  liveMaster = liveCtx.createGain();
  // try hidden audio element with setSinkId like an earlier voice project
  if(typeof HTMLMediaElement.prototype.setSinkId==='function' && navigator.mediaDevices.enumerateDevices){
    try{
      liveOutDest = liveCtx.createMediaStreamDestination();
      liveOutputEl = document.createElement('audio');
      liveOutputEl.autoplay=true; liveOutputEl.playsInline=true; liveOutputEl.srcObject=liveOutDest.stream;
      liveOutputEl.hidden=true; document.body.appendChild(liveOutputEl);
      liveMaster.connect(liveOutDest);
      await liveOutputEl.play().catch(()=>{});
      // speaker selection if available
      try{
        const devices=await navigator.mediaDevices.enumerateDevices();
        const sp=devices.find(d=>d.kind==='audiooutput' && /(?:main )?speaker/i.test(d.label) && !/default|receiver|earpiece/i.test(d.label));
        if(sp && liveOutputEl.setSinkId) await liveOutputEl.setSinkId(sp.deviceId);
      }catch(e){}
      return;
    }catch(e){ try{ liveMaster.disconnect(liveOutDest);}catch(e2){} if(liveOutputEl){ liveOutputEl.pause(); liveOutputEl.srcObject=null; liveOutputEl.remove();} liveOutputEl=null; liveOutDest=null; }
  }
  try{ liveMaster.connect(liveCtx.destination); }catch(e){}
}
function livePlayPCM(pcmBytes){
  if(!liveCtx || !liveMaster) return;
  const i16 = new Int16Array(pcmBytes.byteLength>>1); new Uint8Array(i16.buffer).set(new Uint8Array(pcmBytes,0,i16.length*2));
  const f=new Float32Array(i16.length); for(let i=0;i<i16.length;i++) f[i]=i16[i]/32768;
  const buf=liveCtx.createBuffer(1,f.length,24000); buf.copyToChannel(f,0);
  const src=liveCtx.createBufferSource(); src.buffer=buf; src.connect(liveMaster);
  const now=liveCtx.currentTime; if(liveNextTime < now+0.04) liveNextTime=now+0.08;
  src.start(liveNextTime); liveNextTime+=buf.duration; liveSources.add(src); src.onended=()=> liveSources.delete(src);
}
function liveFlush(){ liveSources.forEach(s=>{ try{ s.stop(); }catch(e){} }); liveSources.clear(); liveNextTime=0; }
function liveFallbackTTS(text){
  try{
    if(!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(text);
    // wait for voices if needed
    const voices=window.speechSynthesis.getVoices();
    if(voices && voices.length){
      // simple language match: check answer language heuristic
      const isSpanish=/[áéíóúñ¿¡]/i.test(text);
      const v=voices.find(v=> isSpanish? v.lang.toLowerCase().includes('es') : v.lang.toLowerCase().includes('en'));
      if(v) u.voice=v;
    }
    window.speechSynthesis.speak(u);
    sendClientEvent('tts_fallback','used');
  }catch(e){}
}
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
// iOS capture guard: prevent blank/black frames, disable Ask until video has dimensions
function isBlankImageData(imageData){
  if(!imageData || !imageData.data) return true;
  const data=imageData.data;
  let sum=0, sumSq=0, count=0;
  // sample every 16th pixel to keep fast
  for(let i=0;i<data.length;i+=64){
    const r=data[i], g=data[i+1], b=data[i+2];
    const lum=0.299*r+0.587*g+0.114*b;
    sum+=lum; sumSq+=lum*lum; count++;
  }
  if(count===0) return true;
  const avg=sum/count;
  const variance=sumSq/count - avg*avg;
  // blank if very dark and low variance (black frame) or pure single color
  if(avg<15 && variance<80) return true;
  if(avg<5) return true;
  return false;
}
function updateAskEnabled(){
  if(!askBtn) return;
  const hasPreview = !!(preview && !preview.hidden && preview.src);
  const hasVideoDims = !!(video && video.videoWidth>0 && video.videoHeight>0 && currentStream);
  const enabled = hasPreview || hasVideoDims;
  askBtn.disabled = !enabled || asking;
  if(enabled) askBtn.removeAttribute('aria-disabled');
  else askBtn.setAttribute('aria-disabled','true');
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
  // guard navigator.mediaDevices (iOS missing without fallback)
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ throw new Error('mediaDevices not available'); }
  try{
    // iOS back camera default: ideal facingMode environment, fallback to exact then generic
    let stream=null;
    try{
      const constraints = { video: { facingMode: { ideal: facingMode } } };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    }catch(errIdeal){
      try{
        const constraints2 = { video: { facingMode: facingMode } };
        stream = await navigator.mediaDevices.getUserMedia(constraints2);
      }catch(err2){
        const constraints3 = { video: true };
        stream = await navigator.mediaDevices.getUserMedia(constraints3);
      }
    }
    currentStream = stream;
    if(video){
      video.srcObject = stream;
      video.hidden = false;
      // iOS guard: always playsinline muted autoplay (our earlier voice app pattern)
      try{ video.setAttribute('playsinline',''); video.playsInline=true; video.muted=true; video.autoplay=true; }catch(e){}
      try{ await video.play(); if(tapStart) tapStart.hidden=true; requestWakeLock(); audioSession('play-and-record'); }catch(playErr){ // autoplay blocked - show Tap to start camera (never black box)
        if(tapStart){ tapStart.hidden=false; const btn=tapStart.querySelector('button'); if(btn) btn.onclick=async()=>{ try{ await video.play(); tapStart.hidden=true; requestWakeLock(); }catch(e){} updateAskEnabled(); }; }
        setStatus('Tap to start camera');
      }
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
    // enable Ask only after video has dimensions (guard against blank)
    updateAskEnabled();
    // video may need time to get dimensions; listen for metadata
    if(video){
      const onReady=()=> updateAskEnabled();
      video.addEventListener('loadedmetadata', onReady, {once:true});
      video.addEventListener('canplay', onReady, {once:true});
      // iOS fallback: check again after short delay
      setTimeout(updateAskEnabled, 400);
      setTimeout(updateAskEnabled, 1200);
    }
  }catch(e){
    const name = e && e.name ? e.name : '';
    let msg='';
    // permission messages reuse an earlier voice project mic pattern: instruct to allow in browser settings
    if(name==='NotAllowedError' || name==='PermissionDeniedError') msg='I do not have permission to use the camera. Allow it for this site in the browser settings and try again, or choose a photo.';
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
    updateAskEnabled();
  }
}

// capture from live preview (video) or from fallback preview image
function captureLiveFrame(){
  return new Promise((resolve, reject)=>{
    // if frozen preview is visible and no video stream, use preview src (fallback upload)
    const usePreview = (preview && !preview.hidden && preview.src) && (!currentStream || (video && video.hidden));

    if(usePreview){
      // iOS gallery: handle EXIF orientation via createImageBitmap with imageOrientation from-image (our earlier voice app pattern), fallback to <img> decode
      (async()=>{
        try{
          if(typeof createImageBitmap==='function'){
            try{
              const resp = await fetch(preview.src);
              const blob = await resp.blob();
              const bmp = await createImageBitmap(blob, {imageOrientation:'from-image'});
              const maxSide=1280;
              const scale=Math.min(1, maxSide/Math.max(bmp.width,bmp.height));
              const cw=Math.round(bmp.width*scale), ch=Math.round(bmp.height*scale);
              const c=document.createElement('canvas'); c.width=cw; c.height=ch;
              const cx=c.getContext('2d');
              cx.drawImage(bmp,0,0,cw,ch);
              try{ bmp.close(); }catch(e){}
              const dataUrl=c.toDataURL('image/jpeg',0.85);
              const b64=dataUrl.split(',')[1]||'';
              const bytes=Math.round(b64.length*3/4);
              resolve({dataUrl, width:cw, height:ch, bytes});
              return;
            }catch(bmpErr){ /* fall through to img fallback */ }
          }
          const img = new Image();
          img.onload = ()=>{
            try{
              const maxSide=1280;
              const w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
              const scale=Math.min(1, maxSide/Math.max(w,h));
              const cw=Math.round(w*scale), ch=Math.round(h*scale);
              const c=document.createElement('canvas'); c.width=cw; c.height=ch;
              const cx=c.getContext('2d');
              cx.drawImage(img,0,0,cw,ch);
              const dataUrl=c.toDataURL('image/jpeg',0.85);
              const b64=dataUrl.split(',')[1]||'';
              const bytes=Math.round(b64.length*3/4);
              resolve({dataUrl, width:cw, height:ch, bytes});
            }catch(err){ reject(err); }
          };
          img.onerror = ()=> reject(new Error('image load failed'));
          // decode fallback if available
          try{ if(img.decode) { img.src=preview.src; await img.decode(); } else { img.src=preview.src; } }catch(e){ img.src=preview.src; }
        }catch(err){ reject(err); }
      })();
      return;
    }
    // live video path
    if(!video || !currentStream){
      reject(new Error('no video'));
      return;
    }
    // capture guard: need video dimensions, else blank
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if(!vw || !vh){
      reject(new Error('video_not_ready'));
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
      // iOS blank/black frame guard
      try{
        const imgData = cx.getImageData(0,0, Math.min(cw,64), Math.min(ch,64));
        if(isBlankImageData(imgData)){
          reject(new Error('blank_frame'));
          return;
        }
      }catch(blankErr){ /* ignore if getImageData fails due to taint */ }
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
  updateAskEnabled();
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
    updateAskEnabled();
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
    updateAskEnabled();
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
  // capture frame with iOS guards
  let captured=null;
  try{
    captured=await captureLiveFrame();
  }catch(e){
    const msg = e && e.message || '';
    if(msg==='blank_frame'){
      setStatus('Captured image was blank — try again with camera ready');
    } else if(msg==='video_not_ready'){
      setStatus('Camera not ready — wait a moment and try again');
    } else {
      setStatus('No image to send — allow camera or choose a photo');
    }
    if(retryBtn) retryBtn.hidden=false;
    sendClientEvent('ask_failed', 'no_image_'+msg);
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
    updateAskEnabled();
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

// ------- Live mode (T10) -------
function resetLiveLatency(){ liveLatency={}; }
function showTranscript(text){ if(!transcriptBubble) return; transcriptBubble.textContent=text; transcriptBubble.hidden=false; }
function showSubtitles(text){ if(!subtitlesEl) return; subtitlesEl.textContent=text; subtitlesEl.hidden=false; }
function clearLiveBubbles(){ if(transcriptBubble) transcriptBubble.hidden=true; if(subtitlesEl) subtitlesEl.hidden=true; }
async function startLive(){
  if(liveEnabled) return;
  // user gesture required
  liveEnabled=true;
  if(liveToggle) liveToggle.classList.add('active');
  if(liveBar) liveBar.hidden=false;
  if(stopBtn) stopBtn.hidden=false;
  clearLiveBubbles();
  resetLiveLatency();
  setLiveState('Listening');
  liveBlocks=[]; liveSpeaking=false; liveVADState={ speechMs:0, silenceMs:0, totalMs:0 };
  // start camera if not already
  if(!currentStream) { try{ await startCamera(currentFacing); }catch(e){} }
  // audioSession like an earlier voice project
  audioSession('auto');
  try{
    liveStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1}});
  }catch(e){
    setStatus('Microphone permission denied — allow it in browser settings and try Live again');
    if(liveStateEl) liveStateEl.textContent='Mic denied';
    sendClientEvent('mic_denied', String(e&&e.message||'').slice(0,100));
    stopLive();
    return;
  }
  audioSession('play-and-record');
  const AC=window.AudioContext||window.webkitAudioContext;
  liveCtx=new AC({latencyHint:'interactive'});
  if(liveCtx.state==='suspended') await liveCtx.resume();
  await unlockAudioForIOS();
  try{ await liveCtx.audioWorklet.addModule('mic-worklet.js'); }catch(e){
    // fallback to ScriptProcessor path
    try{
      const src=liveCtx.createMediaStreamSource(liveStream);
      let fbPos=0, fbLast=0;
      const proc=liveCtx.createScriptProcessor(4096,1,1);
      proc.onaudioprocess=(ev)=>{
        const ch=ev.inputBuffer.getChannelData(0);
        // Linear resample from the context rate (usually 48 kHz) to 16 kHz, with carry-over between blocks.
        const ratio=liveCtx.sampleRate/16000;
        const ext=new Float32Array(ch.length+1); ext[0]=fbLast; ext.set(ch,1);
        const out=[]; let pos=fbPos;
        while(pos<ext.length-1){ const i=Math.floor(pos), f=pos-i; let v=ext[i]*(1-f)+ext[i+1]*f; v=Math.max(-1,Math.min(1,v)); out.push(v<0? v*32768 : v*32767); pos+=ratio; }
        fbPos=pos-ch.length; fbLast=ch[ch.length-1];
        if(livePausedForPlayback) return;
        handleLiveBlock(Int16Array.from(out));
      };
      src.connect(proc); proc.connect(liveCtx.destination);
      liveMicNode=proc;
    }catch(e2){}
    await connectLiveOutput();
    try{ if('wakeLock' in navigator) wakeLock=await navigator.wakeLock.request('screen'); }catch(e){}
    return;
  }
  await connectLiveOutput();
  const srcNode=liveCtx.createMediaStreamSource(liveStream);
  liveMicNode=new AudioWorkletNode(liveCtx,'mic-processor');
  // sink to keep worklet alive
  liveSink=liveCtx.createGain(); liveSink.gain.value=0;
  liveMicNode.connect(liveSink); liveSink.connect(liveCtx.destination);
  srcNode.connect(liveMicNode);
  liveMicNode.port.onmessage=(e)=>{
    if(livePausedForPlayback) return;
    const int16=new Int16Array(e.data);
    handleLiveBlock(int16);
  };
  try{ if('wakeLock' in navigator) wakeLock=await navigator.wakeLock.request('screen'); }catch(e){}
  // offline handling
  window.addEventListener('offline', ()=>{ if(liveEnabled) setLiveState('Offline — check connection'); });
  window.addEventListener('online', ()=>{ if(liveEnabled) setLiveState('Listening'); });
}
function stopLive(){
  liveEnabled=false;
  if(liveToggle) liveToggle.classList.remove('active');
  if(liveBar) liveBar.hidden=true;
  if(stopBtn) stopBtn.hidden=true;
  setLiveState('Idle');
  liveFlush();
  if(liveMicNode){ try{ liveMicNode.disconnect(); }catch(e){} liveMicNode=null; }
  if(liveSink){ try{ liveSink.disconnect(); }catch(e){} liveSink=null; }
  if(liveStream){ liveStream.getTracks().forEach(t=>t.stop()); liveStream=null; }
  if(liveCtx){ try{ liveCtx.close(); }catch(e){} liveCtx=null; }
  if(liveOutputEl){ liveOutputEl.pause(); liveOutputEl.srcObject=null; liveOutputEl.remove(); liveOutputEl=null; } liveOutDest=null; liveMaster=null; liveNextTime=0;
  audioSession('playback'); audioSession('auto');
  if(wakeLock){ try{ wakeLock.release(); }catch(e){} wakeLock=null; }
  liveBlocks=[]; liveSpeaking=false; liveSpeechStartFrame=null;
}
function handleLiveBlock(int16){
  const level=computeLevelInt16(int16);
  updateLevelMeter(level);
  const isSpeech= level > 0.02;
  if(!liveSpeaking){
    if(isSpeech) liveVADState.speechMs+=100; else liveVADState.speechMs=0;
    if(liveVADState.speechMs >= 150){
      // speech start
      liveSpeaking=true;
      liveVADState.silenceMs=0; liveVADState.totalMs=liveVADState.speechMs;
      liveBlocks=[];
      liveLatency.speech_start=Date.now(); sendClientEvent('speech_start','');
      setLiveState('Hearing you');
      // capture frame at speech START
      captureLiveFrame().then(c=>{
        liveSpeechStartFrame=c;
        // store frame for later analyze: we need to freeze it to get canvas size correct
        // but don't freeze UI yet; just keep dataUrl
      }).catch(()=>{ liveSpeechStartFrame=null; });
    }
  } else {
    liveVADState.totalMs+=100;
    liveBlocks.push(int16);
    if(isSpeech) liveVADState.silenceMs=0; else liveVADState.silenceMs+=100;
    // max 15s utterance
    if(liveVADState.totalMs >= 15000){
      triggerSpeechEnd();
      return;
    }
    if(liveVADState.silenceMs >= 900){
      triggerSpeechEnd();
    }
  }
}
async function triggerSpeechEnd(){
  if(!liveSpeaking) return;
  liveSpeaking=false;
  const wasBlocks=liveBlocks.slice();
  liveBlocks=[]; liveVADState={speechMs:0,silenceMs:0,totalMs:0};
  logLatency('speech_end');
  setLiveState('Thinking');
  if(!wasBlocks.length){ setLiveState('Listening'); return; }
  const wav=buildWavFromBlocks(wasBlocks,16000);
  if(wav.length> 2*1024*1024){ setStatus('Audio too long'); setLiveState('Listening'); return; }
  // show capturing frame or fallback to current video capture
  let frame=liveSpeechStartFrame;
  if(!frame){
    try{ frame=await captureLiveFrame(); }catch(e){}
  }
  liveSpeechStartFrame=null;
  if(!frame || !frame.dataUrl){ setLiveState('Listening'); return; }
  // keep frame for analyze
  const captured=frame;
  // transcribe
  try{
    const resp=await fetch('/api/transcribe',{method:'POST', headers:{'Content-Type':'audio/wav'}, body:wav});
    if(!resp.ok){
      let err={}; try{ err=await resp.json(); }catch(e){}
      setLiveState('Listening');
      if(resp.status===503) setStatus('Voice service unavailable');
      else if(resp.status===400) setStatus('Could not understand audio — try speaking clearly or type');
      else if(resp.status===504) setStatus('Voice timed out — try again or type');
      else setStatus('Transcribe failed — you can type instead');
      sendClientEvent('transcribe_fail', resp.status);
      return;
    }
    const data=await resp.json();
    const transcript=(data.transcript||'').trim();
    logLatency('transcript'); sendClientEvent('transcript', transcript.slice(0,80));
    if(!transcript || transcript.length<3){
      setLiveState('Listening');
      return;
    }
    showTranscript(transcript);
    if(questionInput) questionInput.value=transcript;
    // analyze with captured frame (same pipeline)
    await runLiveAnalyze(captured, transcript);
  }catch(e){
    if(e.name==='AbortError'){} else { setStatus('Network error — try typing'); setLiveState('Listening'); sendClientEvent('transcribe_fail','network'); }
    if(!navigator.onLine) setStatus('Offline — check connection');
  }
}
async function runLiveAnalyze(captured, question){
  const frameId=makeFrameId(); const requestId=(()=>{ try{ return crypto.randomUUID(); }catch(e){ return 'r'+Math.random().toString(16).slice(2); } })();
  // freeze preview to show captured frame
  try{ freezeFrame(captured.dataUrl, captured.width, captured.height); }catch(e){}
  pendingFrameId=frameId; pendingRequestId=requestId;
  logLatency('analyze_sent'); sendClientEvent('analyze_sent', question.slice(0,60));
  setLiveState('Thinking');
  let sayMomentTimer=setTimeout(()=>{
    // say "One moment" via TTS if takes >3s
    speakTextLive('One moment', true);
  },3000);
  try{
    const resp=await fetch('/api/analyze',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({frameId, requestId, question, image:captured.dataUrl})});
    clearTimeout(sayMomentTimer);
    if(!resp.ok){ setStatus('Could not analyze — try again'); setLiveState('Listening'); return; }
    const data=await resp.json();
    if(!data || data.frameId!==frameId) return;
    lastRegions=data.regions||[]; lastFrame=currentFrame; drawRegions(lastRegions, currentFrame); renderAnswer(data);
    logLatency('answer'); sendClientEvent('answer', String(data.explanation||'').slice(0,80));
    setStatus('Answer ready');
    // speak answer
    const answerText=data.explanation||'';
    if(answerText) await speakAnswerLive(answerText); else setLiveState('Listening');
  }catch(e){ clearTimeout(sayMomentTimer); setStatus('Network error'); setLiveState('Listening'); }
}
async function speakAnswerLive(answerText){
  setLiveState('Speaking'); showSubtitles(answerText);
  livePausedForPlayback=true; audioSession('playback');
  const sentences=splitSentencesLive(answerText);
  let firstByteTime=null;
  for(let idx=0; idx<sentences.length; idx++){
    const sent=sentences[idx];
    // prefetch next while one plays: we do sequential but start fetch early for next
    try{
      const t0=performance.now();
      const resp=await fetch('/api/speak',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text:sent})});
      if(!resp.ok){
        liveFallbackTTS(sent);
        continue;
      }
      const pcm=await resp.arrayBuffer();
      if(firstByteTime===null){ firstByteTime=performance.now(); const ms=Math.round(firstByteTime - (liveLatency.answer||firstByteTime)); sendClientEvent('spoken', String(ms)); }
      livePlayPCM(pcm);
      // wait until this buffer finished? We schedule nextTime like our-earlier-voice-app; to keep order we don't wait strictly but allow overlap
      // small delay to ensure ordering
    }catch(e){
      liveFallbackTTS(sent);
      sendClientEvent('tts_fallback', String(e).slice(0,80));
    }
  }
  // wait for all sources to finish then resume listening
  const checkDone=setInterval(()=>{
    if(liveSources.size===0){
      clearInterval(checkDone);
      livePausedForPlayback=false;
      audioSession('play-and-record');
      if(liveEnabled) setLiveState('Listening');
      // after speaking, update subtitles? keep visible
    }
  },200);
  // fallback timeout: if no audio, resume after 10s
  setTimeout(()=>{ clearInterval(checkDone); if(livePausedForPlayback){ livePausedForPlayback=false; audioSession('play-and-record'); if(liveEnabled) setLiveState('Listening'); } }, 12000);
}
function speakTextLive(text, isMoment){
  // used for "One moment" immediate
  fetch('/api/speak',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text})}).then(r=>r.ok? r.arrayBuffer():null).then(buf=>{ if(buf) livePlayPCM(buf); }).catch(()=>{ liveFallbackTTS(text); });
}
// Live controls
if(liveToggle) liveToggle.onclick=async ()=>{
  if(!liveEnabled) await startLive(); else stopLive();
};
if(stopBtn) stopBtn.onclick=()=>{
  liveFlush(); if(window.speechSynthesis) window.speechSynthesis.cancel();
  livePausedForPlayback=false; audioSession('play-and-record'); if(liveEnabled) setLiveState('Listening');
  if(subtitlesEl) subtitlesEl.hidden=true;
  sendClientEvent('stop','');
};
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

video.onloadedmetadata=()=>{ syncOverlaySize(); updateAskEnabled(); };
video.oncanplay=()=>{ syncOverlaySize(); updateAskEnabled(); };
video.onplay=()=>{ updateAskEnabled(); };
if(preview) preview.onload=()=>{ syncOverlaySize(); updateAskEnabled(); };
// iOS guards: navigator.mediaDevices availability already checked in startCamera; handle missing APIs with fallbacks
// ResizeObserver guard (our earlier voice app pattern: fallback to resize)
try{ if(typeof ResizeObserver!=='undefined'){ const ro=new ResizeObserver(()=> syncOverlaySize()); const wrap=document.getElementById('cameraWrap'); if(wrap) ro.observe(wrap); }}catch(e){}
// AbortSignal.timeout guard: wrap in try/catch and fallback to AbortController+setTimeout (already used)
function timeoutSignal(ms){ try{ if(typeof AbortSignal!=='undefined' && typeof AbortSignal.timeout==='function') return AbortSignal.timeout(ms); }catch(e){} const c=new AbortController(); setTimeout(()=>c.abort(), ms); return c.signal; }
window.onresize=()=>{ syncOverlaySize(); updateAskEnabled(); };
// iOS orientation change
window.addEventListener('orientationchange', ()=>{ setTimeout(()=>{ syncOverlaySize(); updateAskEnabled(); }, 300); });
// visibilitychange: stop tracks when hidden, restart when visible (our earlier voice app pattern)
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState==='visible'){ if(!currentStream && !isFrozen){ startCamera(currentFacing); } try{ if(video && video.paused && currentStream) video.play(); }catch(e){} requestWakeLock(); }
  else { try{ if(wakeLock){ wakeLock.release(); wakeLock=null; } }catch(e){} audioSession('auto'); }
});
window.addEventListener('pagehide', ()=>{ try{ if(currentStream) currentStream.getTracks().forEach(t=>t.stop()); }catch(e){} releaseWakeLock(); });
// visualViewport keyboard handling: keep question input above keyboard (an earlier voice project ~617)
if(window.visualViewport){
  const vv=visualViewport, container=document.querySelector('.container'), qCard=document.querySelector('.question-card');
  const sh=qCard||container;
  const f=()=>{ if(!sh) return; const kbdOpen = window.innerHeight - vv.height > 120; document.documentElement.classList.toggle('kbd', kbdOpen); if(sh){ sh.style.transform = vv.offsetTop ? 'translateY('+vv.offsetTop+'px)' : ''; } if(window.scrollY) try{ window.scrollTo(0,0); }catch(e){} };
  vv.addEventListener('resize', f); vv.addEventListener('scroll', f); window.addEventListener('scroll', f); f();
}
document.addEventListener('focusin', e=>{ if(e.target.closest('.question-card') && e.target.matches('input:not([type=checkbox]),textarea,select')){ const t=e.target; setTimeout(()=>{ try{ t.scrollIntoView({block:'center', behavior:'smooth'}); }catch(err){} }, 320); } });
document.addEventListener('focusin', e=>{ if(e.target.matches('#question')){ const app=document.querySelector('.container'); if(app) app.classList.add('kb'); setTimeout(()=>{ try{ const th=document.documentElement; th.scrollTop=th.scrollHeight; }catch(er){} },300); } });
document.addEventListener('focusout', e=>{ if(e.target.matches('#question')) setTimeout(()=>{ if(document.activeElement!==document.getElementById('question')){ const app=document.querySelector('.container'); if(app) app.classList.remove('kb'); } },100); });

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
  if(askBtn) askBtn.disabled=true; // guard until camera ready
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
