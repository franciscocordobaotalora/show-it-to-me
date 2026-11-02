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
// Design B Full screen elements (queried lazily or at init; keep references for sync)
let videoB=null, canvasB=null, ctxB=null, previewB=null, loadingB=null, tapStartB=null, cameraFallbackB=null, cameraFallbackMsgB=null, fallbackUploadB=null;
let bTranscriptBubble=null, bSubtitles=null, bStatePill=null, bStatusText=null, bStateIndicator=null, bLiveBtn=null, bLiveWrap=null, bLiveRing=null, bRingLevel=null, bRingArc=null, bLevelBar=null, bScanDot=null, bAnswerSheet=null, bAnswerText=null, bAnswerMeta=null, bAnswerSources=null, bAnswerChips=null, bSheetContent=null, bHighlightChipLayer=null, bKeyboardSheet=null, bQuestionInput=null, bSendBtn=null, bKeyboardBtn=null, bGalleryBtn=null, bFlipBtn=null, bMenuBtn=null, bLevelMeter=null;
function initBRefs(){
  videoB=document.getElementById('videoB');
  canvasB=document.getElementById('overlayB'); ctxB=canvasB?canvasB.getContext('2d'):null;
  previewB=document.getElementById('previewB');
  loadingB=document.getElementById('loadingB');
  tapStartB=document.getElementById('bTapStart');
  cameraFallbackB=document.getElementById('cameraFallbackB');
  cameraFallbackMsgB=document.getElementById('cameraFallbackMsgB');
  fallbackUploadB=document.getElementById('fallbackUploadB');
  bTranscriptBubble=document.getElementById('bTranscriptBubble');
  bSubtitles=document.getElementById('bSubtitles');
  bStatePill=document.getElementById('bStatePill');
  bStatusText=document.getElementById('bStatusText');
  bStateIndicator=document.getElementById('bStateIndicator');
  bLiveBtn=document.getElementById('bLiveBtn');
  bLiveWrap=document.getElementById('bLiveWrap');
  bLiveRing=document.getElementById('bLiveRing');
  bRingLevel=document.getElementById('bRingLevel');
  bRingArc=document.getElementById('bRingArc');
  bLevelBar=document.getElementById('bLevelBar');
  bScanDot=document.getElementById('bScanDot');
  bAnswerSheet=document.getElementById('bAnswerSheet');
  bAnswerText=document.getElementById('bAnswerText');
  bAnswerMeta=document.getElementById('bAnswerMeta');
  bAnswerSources=document.getElementById('bAnswerSources');
  bAnswerChips=document.getElementById('bAnswerChips');
  bSheetContent=document.getElementById('bSheetContent');
  bHighlightChipLayer=document.getElementById('bHighlightChipLayer');
  bKeyboardSheet=document.getElementById('bKeyboardSheet');
  bQuestionInput=document.getElementById('bQuestionInput');
  bSendBtn=document.getElementById('bSendBtn');
  bKeyboardBtn=document.getElementById('bKeyboardBtn');
  bGalleryBtn=document.getElementById('bGalleryBtn');
  bFlipBtn=document.getElementById('bFlipBtn');
  bMenuBtn=document.getElementById('bMenuBtn');
  bLevelMeter=document.querySelector('.b-level');
}
// Live audio state
let liveEnabled = false;
let liveSrcNode = null;
let liveCtx = null, liveStream = null, liveMicNode = null, liveSink = null, liveMaster = null, liveOutputEl = null, liveOutDest = null, liveSources = new Set();
let liveNextTime = 0;
let liveBlocks = []; // collected Int16 blocks for current utterance
let liveVADState = null;
let liveSpeaking = false;
let liveSpeechStartFrame = null;
let livePreRollBuffer = null; // ring buffer of last 400ms (4 blocks @100ms)
let liveLatency = {};
let livePausedForPlayback = false;
let liveAudioUnlocked = false;
let liveOneMomentActive = false;
let liveOneMomentTimer = null;
let liveResumeAfterSpeakTimeout = null;
// for tests: track PCM chunks
window.__livePCMLog = [];
// T11 scan-ahead state
const scanReadyDot = document.getElementById('scanReadyDot');
let scanLatestId = null;
let scanLatestTs = 0;
let scanInFlight = false;
let scanLastTime = 0;
let scanTick = null;
let scanPrevGray = null;
let scanLastMotion = 0;
let scanHasMoved = false;
let scanSpeechId = null;
const SCAN_THRESHOLD = 0.08;
const SCAN_INTERVAL_MS = 3000;
const SCAN_TICK_MS = 500;
const SCAN_STABLE_MS = 600;

// iOS API guards: check availability with fallbacks
function safeAt(arr, idx){ try{ if(Array.prototype.at) return arr.at(idx); }catch(e){} return arr[idx<0?arr.length+idx:idx]; }
function safeStructuredClone(obj){ try{ if(typeof structuredClone==='function') return structuredClone(obj); }catch(e){} return JSON.parse(JSON.stringify(obj)); }

// wakeLock for iPhone (keep screen awake during camera)
async function requestWakeLock(){ try{ if('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }catch(e){} }
function releaseWakeLock(){ try{ if(wakeLock){ wakeLock.release(); wakeLock=null; } }catch(e){} }
// audioSession guard (iOS)
function audioSession(type){ try{ if(navigator.audioSession) navigator.audioSession.type = type; }catch(e){} }

// demo hook via URL ?demo=1 (no checkbox on page)
const demoFlag = (()=>{ try{ return new URLSearchParams(window.location.search).get('demo') === '1'; }catch(e){ return false; } })();
const demoMode = { checked: demoFlag };

// helpers - single status line only, never duplicate sentence
function collapseDuplicateWords(text){ if(!text) return text; return text.replace(/\b(\w+)\s+\1\b/gi, '$1'); }
function setStatus(s){ const clean=collapseDuplicateWords(s); if(statusEl) statusEl.textContent = clean; if(statusEl) statusEl.setAttribute('aria-live','polite'); // sync single pill
  try{ const sa=document.getElementById('statusA'); if(sa) sa.textContent=clean; }catch(e){}
  try{ if(bStatusText) bStatusText.textContent = clean; }catch(e){} try{ const bLiveSt=document.getElementById('bLiveState'); if(bLiveSt) bLiveSt.textContent=clean; }catch(e){} }
function sendClientEvent(eventName, detailObj){ try{ const payload = { event:eventName, detail: String(detailObj||'').slice(0,300), userAgent: navigator.userAgent.slice(0,160), viewport:{w:window.innerWidth,h:window.innerHeight}, online:navigator.onLine }; const body = JSON.stringify(payload); if(navigator.sendBeacon){ const blob = new Blob([body],{type:'application/json'}); navigator.sendBeacon('/api/client-event', blob); } else { fetch('/api/client-event',{method:'POST', headers:{'Content-Type':'application/json'}, body, keepalive:true}); } }catch(e){} }
// Live helpers
// State machine: ONE small state machine as required
const APP_STATES = ['idle','starting','listening','hearing','thinking','speaking','answer','error','permission_needed'];
let appState = 'idle';
const appStateListeners = [];
function setAppState(next, detail){
  if(!APP_STATES.includes(next)) return;
  const prev = appState;
  appState = next;
  // guard vibrate to avoid Chrome intervention before user gesture
  try{ if(typeof navigator.vibrate==='function' && navigator.userActivation && navigator.userActivation.hasBeenActive){ navigator.vibrate(10); } }catch(e){}
  // dispatch to listeners
  appStateListeners.forEach(fn=>{ try{ fn({state:next, prev, detail}); }catch(e){} });
  try{ document.documentElement.setAttribute('data-app-state', next); }catch(e){}
  try{ sendClientEvent('app_state', prev+'->'+next+' '+(detail||'').slice(0,80)); }catch(e){}
  // also drive legacy liveStateEl
  if(liveStateEl) liveStateEl.textContent = stateLabel(next);
  if(statusEl){ statusEl.textContent = stateStatusText(next, detail); statusEl.setAttribute('aria-live','polite'); }
  if(['hearing','thinking','speaking','answer'].includes(next)) { try{ hideReadyOverlay(); }catch(e){} }
  // update body class for CSS per state
  try{ document.body.setAttribute('data-state', next); }catch(e){}
  // Sync single pill #statusA + dot + animated indicator (bars while hearing/speaking, dots while thinking)
  try{
    const sa=document.getElementById('statusA'); if(sa) sa.textContent=stateStatusText(next, detail);
    const dot=document.getElementById('stateDot'); if(dot){ const colors={idle:'var(--s-idle)',listening:'var(--s-listen)',hearing:'var(--s-hear)',thinking:'var(--s-think)',speaking:'var(--s-speak)',answer:'var(--s-answer)',error:'var(--s-error)',starting:'var(--s-listen)',permission_needed:'var(--s-idle)'}; dot.style.background=colors[next]||'var(--s-idle)'; }
    const ind=document.getElementById('stateIndicator'); if(ind){
      ind.className='state-indicator is-'+next;
      if(next==='hearing'||next==='speaking') ind.innerHTML='<span class="bars"><i></i><i></i><i></i><i></i><i></i></span>';
      else if(next==='thinking') ind.innerHTML='<span class="dots"><i></i><i></i><i></i></span>';
      else ind.innerHTML='';
    }
    // heroLiveBtn toggle: blue Live/Stop or Ask another after answer
    const hero=document.getElementById('heroLiveBtn'); if(hero){
      if(next==='answer'){
        hero.classList.remove('active'); hero.classList.add('is-ask-another'); hero.setAttribute('aria-label','Ask another'); const label=hero.querySelector('.live-label'); if(label) label.textContent='Ask another'; hero.style.background='linear-gradient(135deg,#0866FF,#2e7dfe)'; const glyph=document.querySelector('#heroLiveBtn .wave-glyph'); if(glyph){ const liveSvg=glyph.querySelector('.glyph-live'); const stopSvg=glyph.querySelector('.glyph-stop'); if(liveSvg) liveSvg.hidden=true; if(stopSvg) stopSvg.hidden=true; glyph.hidden=true; }
      } else {
        hero.classList.remove('is-ask-another'); hero.style.background=''; const glyph=document.querySelector('#heroLiveBtn .wave-glyph'); if(glyph) glyph.hidden=false;
        const active=['listening','hearing','thinking','speaking'].includes(next); hero.classList.toggle('active', active); hero.setAttribute('aria-label', active?'Stop live mode':'Start live mode'); const label=hero.querySelector('.live-label'); if(label) label.textContent=active?'Stop':'Live'; const g=document.querySelector('#heroLiveBtn .wave-glyph'); if(g){ const liveSvg=g.querySelector('.glyph-live'); const stopSvg=g.querySelector('.glyph-stop'); if(liveSvg) liveSvg.hidden=active; if(stopSvg) stopSvg.hidden=!active; }
      }
    }
    const wrap=document.getElementById('cameraWrap'); if(wrap){ if(next!=='idle' && (video && video.videoWidth || preview && !preview.hidden)) wrap.classList.add('has-frame'); }
  }catch(e){}
  // Design B top bar mirror
  try{
    if(typeof bStatusText!=='undefined' && bStatusText) bStatusText.textContent = stateStatusText(next, detail);
    if(typeof bStateIndicator!=='undefined' && bStateIndicator){ bStateIndicator.className='b-state-indicator is-'+next; bStateIndicator.setAttribute('data-state', next); }
    if(typeof bLiveBtn!=='undefined' && bLiveBtn){
      if(liveEnabled && (next==='listening'||next==='hearing'||next==='thinking'||next==='speaking')){ bLiveBtn.textContent='Stop'; bLiveBtn.classList.add('is-active'); bLiveBtn.setAttribute('aria-label','Stop live mode'); }
      else { bLiveBtn.textContent='Live'; bLiveBtn.classList.remove('is-active'); bLiveBtn.setAttribute('aria-label','Start live mode'); }
    }
  }catch(e){}
}
function onAppState(fn){ if(typeof fn==='function') appStateListeners.push(fn); }
function getAppState(){ return appState; }
function stateLabel(s){
  const map={idle:'Ready',starting:'Starting...',listening:'Listening',hearing:'Hearing you',thinking:'Thinking',speaking:'Speaking',answer:'Answer ready',error:'Error',permission_needed:'Permission needed'};
  return map[s]||s;
}
function stateStatusText(s, detail){
  const map={idle:'Tap Live to start',starting:'Starting camera and mic…',listening:'Listening...',hearing:'Hearing you...',thinking:'Thinking...',speaking:'Speaking...',answer:'Here is your answer',error:'Could not reach the model',permission_needed:'Camera and microphone needed'};
  return map[s]||detail||s;
}
// expose state machine for view layer and tests
window.AppState = { get: getAppState, set: setAppState, on: onAppState, STATES: APP_STATES, _label: stateLabel };

function setLiveState(s){ // backwards compat wrapper that also drives state machine
  if(liveStateEl) liveStateEl.textContent = s;
  logLatency(s.toLowerCase().replace(' ','_'));
  // map legacy live states to new appState
  const lower=s.toLowerCase();
  if(lower.includes('listening')) setAppState('listening', s);
  else if(lower.includes('hearing')) setAppState('hearing', s);
  else if(lower.includes('thinking')) setAppState('thinking', s);
  else if(lower.includes('speaking')) setAppState('speaking', s);
  else if(lower.includes('idle')) setAppState('idle');
}
function updateLevelMeter(level){
  if(levelBar) levelBar.style.width = Math.min(100, Math.round(level*300))+'%';
  if(bLevelBar) bLevelBar.style.width = Math.min(100, Math.round(level*300))+'%';
  // Hearing ring follows voice level: scale 1 + level*0.3
  try{
    if(bRingLevel){
      const sc = 1 + Math.min(0.5, level*0.9);
      bRingLevel.style.transform = 'scale('+sc.toFixed(3)+')';
      bRingLevel.style.opacity = level>0.02 ? '1' : '0.4';
    }
    const lb=document.getElementById('levelBarB'); if(lb) lb.style.width=Math.min(100, Math.round(level*300))+'%';
  }catch(e){}
}
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
    // (a) FIX weird sound: use silent Web Audio buffer instead of empty SpeechSynthesisUtterance blip
    try{
      const buf = liveCtx.createBuffer(1, Math.round(liveCtx.sampleRate * 0.01), liveCtx.sampleRate);
      // buffer is silent (zeros)
      const src = liveCtx.createBufferSource();
      src.buffer = buf;
      src.connect(liveCtx.destination);
      src.start();
    }catch(e){}
    liveAudioUnlocked=true;
    sendClientEvent('audio_unlock','webaudio_silent');
  }catch(e){}
}
async function connectLiveOutput(){
  if(!liveCtx) return;
  liveMaster = liveCtx.createGain();
  // try hidden audio element with setSinkId
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
// (b) gapless scheduling with 10ms fade-in/out per chunk to fix weird sound at boundaries
function applyFade(float32, sampleRate){
  const fadeSamples = Math.round(sampleRate * 0.01); // 10ms
  const n = float32.length;
  if(n <= 2*fadeSamples){
    // very short: triangular fade
    for(let i=0;i<n;i++){
      const f = i < n/2 ? (i / (n/2)) : ((n - i) / (n/2));
      float32[i] *= Math.max(0, Math.min(1, f));
    }
  } else {
    for(let i=0;i<fadeSamples;i++){
      const g = i / fadeSamples;
      float32[i] *= g;
      float32[n-1 - i] *= g;
    }
  }
  return float32;
}
function livePlayPCM(pcmBytes){
  if(!liveCtx || !liveMaster) return;
  // cancel "One moment" if it was playing when real answer arrives (c)
  if(liveOneMomentActive){
    try{ liveFlush(); if(window.speechSynthesis) window.speechSynthesis.cancel(); }catch(e){}
    liveOneMomentActive=false;
    sendClientEvent('one_moment_cancel','answer_arrived');
  }
  const i16 = new Int16Array(pcmBytes.byteLength>>1); new Uint8Array(i16.buffer).set(new Uint8Array(pcmBytes,0,i16.length*2));
  const f=new Float32Array(i16.length); for(let i=0;i<i16.length;i++) f[i]=i16[i]/32768;
  applyFade(f, 24000);
  const buf=liveCtx.createBuffer(1,f.length,24000); buf.copyToChannel(f,0);
  const src=liveCtx.createBufferSource(); src.buffer=buf; src.connect(liveMaster);
  const now=liveCtx.currentTime; if(liveNextTime < now+0.02) liveNextTime = now + 0.05;
  // gapless: schedule exactly at liveNextTime
  src.start(liveNextTime); liveNextTime += buf.duration; liveSources.add(src); src.onended=()=> liveSources.delete(src);
  // expose for tests: track last PCM for fade verification
  if(window.__livePCMLog) window.__livePCMLog.push({len:f.length, faded:true});
}
function liveFlush(){ liveSources.forEach(s=>{ try{ s.stop(); }catch(e){} }); liveSources.clear(); liveNextTime=0; }
// T11 scan helpers
function captureGrayscale32(){
  try{
    if(!video || video.hidden || !video.videoWidth) return null;
    const c=document.createElement('canvas'); c.width=32; c.height=32;
    const ct=c.getContext('2d');
    ct.drawImage(video,0,0,32,32);
    const d=ct.getImageData(0,0,32,32).data;
    const gray=new Array(1024);
    for(let i=0;i<1024;i++){ const r=d[i*4],g=d[i*4+1],b=d[i*4+2]; gray[i]=Math.round(0.299*r+0.587*g+0.114*b); }
    return gray;
  }catch(e){ return null; }
}
function frameDifference(a,b){
  if(!a||!b||a.length!==b.length) return 1.0;
  let s=0; for(let i=0;i<a.length;i++) s+=Math.abs(a[i]-b[i]);
  return (s/a.length)/255.0;
}
function updateReadyDot(){
  if(!scanReadyDot) return;
  const fresh = scanLatestId && (Date.now()-scanLatestTs) < 60000;
  scanReadyDot.hidden = !fresh;
}
let liveReadyAnnounced=false, liveReadyTimer=null, liveGreetingPromise=null, readyOverlayTimer=null;
function liveUserName(){
  // open the page once with ?name=YourName and the greeting uses it from then on
  try{
    const q=new URLSearchParams(location.search).get('name');
    if(q){ const n=q.trim().slice(0,30); try{ localStorage.setItem('sit_name', n); }catch(e){} return n; }
    return (localStorage.getItem('sit_name')||'').trim().slice(0,30);
  }catch(e){ return ''; }
}
function liveGreetingText(){ const n=liveUserName(); return n ? 'Hi '+n+', what do you want to know?' : 'Hi, what do you want to know?'; }
function prefetchLiveGreeting(){
  // fetched while the scan runs, so the greeting is ready the moment the system is
  const text=liveGreetingText();
  liveGreetingPromise = fetch('/api/speak',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text})})
    .then(r=>r.ok? r.arrayBuffer():null).catch(()=>null);
  return text;
}
function readyOverlayEl(){ return document.getElementById('readyOverlay'); }
function showReadyOverlay(){
  const el=readyOverlayEl(); if(!el) return;
  if(readyOverlayTimer){ clearTimeout(readyOverlayTimer); readyOverlayTimer=null; }
  el.classList.remove('is-ready','is-done'); el.classList.add('is-loading'); el.hidden=false;
  const t=document.getElementById('readyTitle'), sub=document.getElementById('readySub');
  if(t) t.textContent='Getting ready'; if(sub) sub.textContent='Looking around so I can answer fast';
}
function hideReadyOverlay(){
  const el=readyOverlayEl(); if(!el) return;
  if(readyOverlayTimer){ clearTimeout(readyOverlayTimer); readyOverlayTimer=null; }
  el.classList.add('is-done');
  setTimeout(()=>{ if(el.classList.contains('is-done')) el.hidden=true; }, 480);
}
function markReadyOverlay(greeting){
  const el=readyOverlayEl(); if(!el || el.hidden) return;
  el.classList.remove('is-loading'); el.classList.add('is-ready');
  const t=document.getElementById('readyTitle'), sub=document.getElementById('readySub');
  if(t) t.textContent='Ready'; if(sub) sub.textContent=greeting||'Ask me anything';
  readyOverlayTimer=setTimeout(hideReadyOverlay, 3800);
}
function playReadyChime(){
  // two rising tones through the live output so the phone user hears "ready" without looking
  try{
    if(!liveCtx) return;
    const dest = liveMaster || liveCtx.destination;
    const t0 = liveCtx.currentTime + 0.02;
    [[880,0],[1320,0.14]].forEach(([hz,off])=>{
      const o=liveCtx.createOscillator(), g=liveCtx.createGain();
      o.type='sine'; o.frequency.value=hz;
      g.gain.setValueAtTime(0.0001,t0+off);
      g.gain.exponentialRampToValueAtTime(0.25,t0+off+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001,t0+off+0.2);
      o.connect(g); g.connect(dest);
      o.start(t0+off); o.stop(t0+off+0.22);
    });
  }catch(e){}
}
async function announceLiveReady(reason){
  if(!liveEnabled || liveReadyAnnounced) return;
  liveReadyAnnounced=true;
  if(liveReadyTimer){ clearTimeout(liveReadyTimer); liveReadyTimer=null; }
  const greeting=liveGreetingText();
  markReadyOverlay(greeting);
  setStatus('Ready, ask me');
  sendClientEvent('live_ready', reason||'scan_ok');
  // keep the mic from hearing the chime and the greeting as speech
  livePausedForPlayback=true;
  playReadyChime();
  let pcm=null;
  try{ pcm = liveGreetingPromise ? await liveGreetingPromise : null; }catch(e){ pcm=null; }
  if(!liveEnabled) return;
  if(pcm && pcm.byteLength>0 && liveCtx && liveMaster){
    liveNextTime = liveCtx.currentTime + 0.42;   // after the chime
    livePlayPCM(pcm);
    sendClientEvent('live_greeting','played');
  } else {
    sendClientEvent('live_greeting','unavailable');
  }
  const t1=Date.now();
  const wait=setInterval(()=>{
    if(!liveEnabled){ clearInterval(wait); return; }
    const quiet = liveSources.size===0 && (Date.now()-t1)>600;
    if(quiet || (Date.now()-t1)>9000){
      clearInterval(wait);
      setTimeout(()=>{ if(liveEnabled && (appState==='listening')) livePausedForPlayback=false; }, 400);
    }
  },150);
}
async function doScan(){
  if(scanInFlight) return;
  if(document.hidden) return;
  if(!liveEnabled) return;
  const now=Date.now();
  if(now - scanLastTime < SCAN_INTERVAL_MS) return;
  let frame=null;
  try{ frame=await captureLiveFrame(); }catch(e){ return; }
  if(!frame||!frame.dataUrl) return;
  const scanId = (()=>{ try{ return crypto.randomUUID(); }catch(e){ return 's'+Math.random().toString(16).slice(2); } })();
  scanInFlight=true; scanLastTime=now;
  try{
    const resp=await fetch('/api/scan',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({scanId, image: frame.dataUrl})});
    if(resp.ok){
      const data=await resp.json();
      scanLatestId = data.scanId || scanId;
      scanLatestTs = Date.now();
      updateReadyDot();
      sendClientEvent('scan_ok', scanLatestId+' '+ (data.objects?.length||0));
      announceLiveReady('scan_ok');
    } else {
      sendClientEvent('scan_fail', String(resp.status));
      announceLiveReady('scan_fail');
    }
  }catch(e){ sendClientEvent('scan_fail','network'); announceLiveReady('scan_fail'); } finally{ scanInFlight=false; }
}
function startScanLoop(){
  stopScanLoop();
  scanPrevGray=null; scanHasMoved=false; scanLastMotion=0;
  // immediate scan on Live start (a)
  setTimeout(()=>{ if(liveEnabled && !document.hidden) doScan(); }, 600);
  scanTick=setInterval(()=>{
    if(!liveEnabled || document.hidden || scanInFlight) return;
    const cur=captureGrayscale32();
    if(!cur) return;
    if(!scanPrevGray){ scanPrevGray=cur; return; }
    const diff=frameDifference(scanPrevGray, cur);
    scanPrevGray=cur;
    const now=Date.now();
    if(diff > SCAN_THRESHOLD){
      scanHasMoved=true; scanLastMotion=now;
    } else {
      if(scanHasMoved && (now - scanLastMotion) >= SCAN_STABLE_MS){
        // picture stable after movement (b)
        if((now - scanLastTime) >= SCAN_INTERVAL_MS){
          doScan();
          scanHasMoved=false;
        }
      }
    }
  }, SCAN_TICK_MS);
}
function stopScanLoop(){
  if(scanTick){ clearInterval(scanTick); scanTick=null; }
  scanPrevGray=null; scanHasMoved=false;
  // keep scanLatestId for reuse within TTL but hide dot if stopped?
  // dot stays if fresh; spec says stop scanning when Live off or tab hidden
  if(!liveEnabled && scanReadyDot) scanReadyDot.hidden=true;
}

function liveFallbackTTS(text){
  try{
    if(!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(text);
    const voices=window.speechSynthesis.getVoices();
    if(voices && voices.length){
      const isSpanish=/[áéíóúñ¿¡]/i.test(text);
      const v=voices.find(v=> isSpanish? v.lang.toLowerCase().includes('es') : v.lang.toLowerCase().includes('en'));
      if(v) u.voice=v;
    }
    window.speechSynthesis.speak(u);
    sendClientEvent('tts_fallback', text.slice(0,80));
  }catch(e){ sendClientEvent('tts_fallback','error:'+String(e).slice(0,60)); }
}
function makeFrameId(){ try{ return crypto.randomUUID(); }catch(e){ return 'f'+Math.random().toString(16).slice(2); } }
function orientationFrom(w,h){ if(w>h) return 'landscape'; if(h>w) return 'portrait'; return 'square'; }
function getActiveMedia(){
  if(currentDesign==='b'){
    if(previewB && !previewB.hidden) return previewB;
    if(videoB && !videoB.hidden) return videoB;
    // fallback: if B video hidden but main has stream, treat as active for capture purposes
    if(previewB && previewB.src) return previewB;
  }
  return (preview && !preview.hidden) ? preview : video;
}
// Cover transform helper: maps normalized polygon point through object-fit:cover
function coverMap(px, py, boxW, boxH, imgW, imgH){
  const scale = Math.max(boxW / imgW, boxH / imgH);
  const offX = (boxW - imgW * scale) / 2;
  const offY = (boxH - imgH * scale) / 2;
  return { x: offX + px * imgW * scale, y: offY + py * imgH * scale, scale, offX, offY };
}
function syncOverlaySize(){
  // Main canvas sized to CSS box * devicePixelRatio
  try{
    const wrap = document.getElementById('cameraWrap');
    if(wrap && canvas){
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      canvas.width = w; canvas.height = h;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      canvas._cssW = rect.width; canvas._cssH = rect.height; canvas._dpr = dpr;
      // scale context for CSS pixel drawing; reset then scale
      try{ ctx.setTransform(dpr,0,0,dpr,0,0); }catch(e){}
    }
  }catch(e){}
  // B canvas separately
  try{
    const wrapB = document.getElementById('cameraWrapB');
    if(wrapB && canvasB){
      const rect = wrapB.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvasB.width = Math.max(1, Math.round(rect.width * dpr));
      canvasB.height = Math.max(1, Math.round(rect.height * dpr));
      canvasB.style.width = rect.width+'px'; canvasB.style.height = rect.height+'px';
      canvasB._cssW = rect.width; canvasB._cssH = rect.height; canvasB._dpr = dpr;
      try{ ctxB.setTransform(dpr,0,0,dpr,0,0); }catch(e){}
    } else if(canvasB){
      // fallback to media rect if no wrapB
      const bMedia = (previewB && !previewB.hidden) ? previewB : videoB;
      if(bMedia && !bMedia.hidden){
        const rect = bMedia.getBoundingClientRect();
        const dpr = window.devicePixelRatio||1;
        canvasB.width = Math.max(1, Math.round(rect.width*dpr));
        canvasB.height = Math.max(1, Math.round(rect.height*dpr));
        canvasB.style.width = rect.width+'px'; canvasB.style.height = rect.height+'px';
        canvasB._cssW = rect.width; canvasB._cssH = rect.height; canvasB._dpr = dpr;
        try{ ctxB.setTransform(dpr,0,0,dpr,0,0);}catch(e){}
      }
    }
  }catch(e){}
  if(lastRegions.length && lastFrame) drawRegions(lastRegions, lastFrame);
}
// keep overlay correct on resize/orientation
try{ window.addEventListener('resize', ()=> requestAnimationFrame(syncOverlaySize)); window.addEventListener('orientationchange', ()=> setTimeout(syncOverlaySize, 120)); }catch(e){}
try{ if(typeof ResizeObserver!=='undefined'){ const ro=new ResizeObserver(()=> requestAnimationFrame(syncOverlaySize)); const cw=document.getElementById('cameraWrap'); if(cw) ro.observe(cw); } }catch(e){}
// --- cinematic helpers ---
window.__frameTimes=[]; let _frameTimeRAF=null;
function startFrameMeasure(){ window.__frameTimes=[]; let last=performance.now(), count=0;
  function tick(now){ const dt=now-last; last=now; if(count<60) window.__frameTimes.push(dt); count++; if(count<60) _frameTimeRAF=requestAnimationFrame(tick); }
  cancelAnimationFrame(_frameTimeRAF); requestAnimationFrame(tick);
}
function getFrameStats(){ const a=window.__frameTimes||[]; if(!a.length) return {p95:0,avg:0}; const s=[...a].sort((x,y)=>x-y); const p95=s[Math.floor(s.length*0.95)]||0; const avg=a.reduce((x,y)=>x+y,0)/a.length; return {p95:+p95.toFixed(2), avg:+avg.toFixed(2), n:a.length}; }
window.getFrameStats=getFrameStats;
function drawDimMask(regions, frame){
  const dim=document.getElementById('dimCanvas'); if(!dim||!regions||!regions.length) return;
  const wrap=document.getElementById('cameraWrap'); if(!wrap) return;
  const rect=wrap.getBoundingClientRect(); const cssW=rect.width, cssH=rect.height; const dpr=window.devicePixelRatio||1;
  const imgW=frame&&frame.width?frame.width:cssW, imgH=frame&&frame.height?frame.height:cssH;
  dim.width=Math.max(1,Math.round(cssW*dpr)); dim.height=Math.max(1,Math.round(cssH*dpr)); dim.style.width=cssW+'px'; dim.style.height=cssH+'px'; dim._cssW=cssW; dim._cssH=cssH; dim._dpr=dpr;
  const dctx=dim.getContext('2d'); try{ dctx.setTransform(dpr,0,0,dpr,0,0); }catch(e){}
  // draw dim outside polygons with feather via shadowBlur
  // first fill whole with 45% black
  dctx.save(); dctx.fillStyle='rgba(0,0,0,0.45)'; dctx.fillRect(0,0,cssW,cssH);
  // cut out polygons with destination-out + blur
  dctx.globalCompositeOperation='destination-out';
  dctx.shadowColor='rgba(0,0,0,1)'; dctx.shadowBlur=12;
  dctx.fillStyle='rgba(0,0,0,1)';
  regions.forEach(r=>{ if(!r.polygon||r.polygon.length<3) return; const mapped=r.polygon.map(p=> coverMap(p[0],p[1],cssW,cssH,imgW,imgH)); dctx.beginPath(); mapped.forEach((m,i)=>{ if(i===0) dctx.moveTo(m.x,m.y); else dctx.lineTo(m.x,m.y); }); dctx.closePath(); dctx.fill(); });
  dctx.restore();
  dim.hidden=false; dim.style.opacity='0';
  // fade in 300ms
  dim.style.transition='opacity 300ms ease-out'; requestAnimationFrame(()=>{ dim.style.opacity='1'; });
}
function clearDim(){ const dim=document.getElementById('dimCanvas'); if(dim){ try{ const c=dim.getContext('2d'); c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,dim.width,dim.height);}catch(e){} dim.hidden=true; dim.style.opacity=''; dim.style.transition=''; dim.style.transform=''; } }
function positionRipple(regions, frame){
  const wrap=document.getElementById('cameraWrap'); const ripple=document.getElementById('ripple'); if(!wrap||!ripple||!regions.length) return null;
  const rect=wrap.getBoundingClientRect(); const cssW=rect.width, cssH=rect.height; const imgW=frame&&frame.width?frame.width:cssW, imgH=frame&&frame.height?frame.height:cssH;
  const poly=regions[0].polygon; if(!poly) return null;
  const mapped=poly.map(p=> coverMap(p[0],p[1],cssW,cssH,imgW,imgH)); let cx=0,cy=0; mapped.forEach(m=>{cx+=m.x; cy+=m.y;}); cx/=mapped.length; cy/=mapped.length;
  ripple.style.left=cx+'px'; ripple.style.top=cy+'px';
  return {cx,cy};
}
function playCinematic(regions, frame){
  const wrap=document.getElementById('cameraWrap'); if(!wrap) return;
  const sweep=document.getElementById('sweep'); const ripple=document.getElementById('ripple'); const shimmer=document.getElementById('shimmer'); const svg=document.getElementById('highlightSVG'); const hc=document.getElementById('highlightChip');
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduced){
    wrap.classList.remove('is-drawing','comet','bloom','breathing'); if(sweep) sweep.hidden=true; if(ripple) ripple.hidden=true; if(shimmer) shimmer.hidden=true; if(svg) svg.style.transition='opacity 150ms'; if(hc) hc.classList.remove('pop'); // final state fade only
    return;
  }
  startFrameMeasure();
  wrap.classList.add('is-drawing');
  // delay fill bloom: hide svg fill until 800ms (canvas fill kept but will be overlaid with sweep)
  const svgPath=document.querySelector('#highlightSVG path');
  if(svgPath){ svgPath.style.fillOpacity='0'; svgPath.style.transition='fill-opacity 400ms ease-out'; }

  // dim already drawn outside before call; ensure sweep visible
  if(sweep){ sweep.hidden=false; sweep.classList.remove('active'); void sweep.offsetWidth; sweep.classList.add('active'); setTimeout(()=>{ sweep.hidden=true; sweep.classList.remove('active'); }, 600); }
  // enhance dim visibility: ensure dim is behind but visible, add feather via filter blur
  try{ const dim=document.getElementById('dimCanvas'); if(dim){ dim.style.filter='blur(0.5px)'; } }catch(e){}
  // comet trace 300-1000ms
  setTimeout(()=>{ wrap.classList.add('comet'); if(svg){ svg.hidden=false; } }, 300);
  // fill bloom 800-1300: fade in fill + shimmer
  setTimeout(()=>{
    wrap.classList.add('bloom');
    const sp=document.querySelector('#highlightSVG path'); if(sp){ sp.style.fillOpacity='1'; sp.style.fill='rgba(8,102,255,0.28)'; }
    if(shimmer){ shimmer.hidden=false; shimmer.classList.add('go'); setTimeout(()=>{ shimmer.hidden=true; shimmer.classList.remove('go'); }, 800); }
  }, 800);
  // ripple 900
  if(ripple){
    setTimeout(()=>{
      const pos=positionRipple(regions, frame); if(pos){ ripple.hidden=false; ripple.classList.remove('go'); void ripple.offsetWidth; ripple.classList.add('go'); setTimeout(()=>{ ripple.hidden=true; ripple.classList.remove('go'); }, 1000); }
    }, 900);
  }
  // label pop 1000
  if(hc){
    setTimeout(()=>{ hc.classList.remove('pop'); void hc.offsetWidth; hc.classList.add('pop'); }, 1000);
  }
  // breathing after 1400 while speaking (we keep alive)
  setTimeout(()=>{ wrap.classList.add('breathing'); // check low-end: if avg>24 drop blur+ripple
    const st=getFrameStats(); if(st.avg>24){ // drop blur/ripple
      try{ if(svg){ const p=svg.querySelector('path'); if(p) p.style.filter='none'; } const dim=document.getElementById('dimCanvas'); if(dim) dim.style.filter='none'; if(ripple) ripple.style.display='none'; }catch(e){}
    }
  }, 1400);
}
function stopCameraTracks(){
  try{ if(currentStream){ currentStream.getTracks().forEach(t=>{ try{ t.stop(); }catch(e){} }); } }catch(e){}
  // keep currentStream ref but tracks ended (spec requires readyState ended while Thinking/Speaking)
  try{ if(window.__liveStopHook) window.__liveStopHook(); }catch(e){}
  // also stop live audio input if present
  try{ if(window.__liveAudioStop) window.__liveAudioStop(); }catch(e){}
  // camera and microphone are both off from the moment the question ends until the answer is done
  try{ releaseLiveMic(); }catch(e){}
}
function releaseLiveMic(){
  try{ if(liveSrcNode){ liveSrcNode.disconnect(); liveSrcNode=null; } }catch(e){}
  try{ if(liveStream){ liveStream.getTracks().forEach(t=>{ try{ t.stop(); }catch(e){} }); liveStream=null; } }catch(e){}
}
async function reattachLiveMic(){
  if(!liveEnabled || !liveCtx || !liveMicNode) return;
  audioSession('auto');
  liveStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1}});
  audioSession('play-and-record');
  if(liveCtx.state==='suspended'){ try{ await liveCtx.resume(); }catch(e){} }
  liveSrcNode = liveCtx.createMediaStreamSource(liveStream);
  liveSrcNode.connect(liveMicNode);
  liveBlocks=[]; liveSpeaking=false; liveVADState={ speechMs:0, silenceMs:0, totalMs:0 }; livePausedForPlayback=false;
  try{ if(livePreRollBuffer) livePreRollBuffer.clear(); }catch(e){}
}
// Ask another: photo and drawing fade out, camera and microphone come back, listening resumes
async function askAnother(){
  try{ resetToLive(); }catch(e){}
  try{ await startCamera(currentFacing); }catch(e){}
  if(liveEnabled){
    try{ await reattachLiveMic(); setLiveState('Listening'); }
    catch(e){ setStatus('Microphone permission denied, allow it in browser settings and tap Live'); sendClientEvent('mic_denied', String(e&&e.message||'').slice(0,100)); }
  } else { setAppState('idle'); }
  sendClientEvent('ask_another','');
}
async function restoreAfterError(msg){ if(msg) setStatus(msg); try{ await askAnother(); }catch(e){} }
function updateHeroForAnswer(isAnswer){
  const hero=document.getElementById('heroLiveBtn'); if(!hero) return;
  const label=hero.querySelector('.live-label'); if(!label) return;
  if(isAnswer){ hero.classList.add('is-ask-another'); label.textContent='Ask another'; hero.style.background='linear-gradient(135deg,#0866FF,#2e7dfe)'; hero.setAttribute('aria-label','Ask another'); }
  else { hero.classList.remove('is-ask-another'); label.textContent='Live'; hero.style.background=''; hero.setAttribute('aria-label','Start live mode'); }
}

function updateCameraButtons(activeFacing){
  if(camBackBtn) camBackBtn.classList.toggle('active', activeFacing==='environment');
  if(camFrontBtn) camFrontBtn.classList.toggle('active', activeFacing==='user');
  // flip camera icon only when more than one camera exists
  try{
    const flip=document.getElementById('cameraFlipBtn');
    if(flip){ flip.setAttribute('data-facing', activeFacing); }
    // enumerateDevices check async
    if(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices){
      navigator.mediaDevices.enumerateDevices().then(devs=>{
        const cams=devs.filter(d=>d.kind==='videoinput');
        const flip2=document.getElementById('cameraFlipBtn');
        if(flip2) flip2.hidden = cams.length<=1;
        const placeholder=document.querySelector('.flip-placeholder');
        if(placeholder) placeholder.hidden = cams.length>1;
      }).catch(()=>{});
    }
  }catch(e){}
  try{ if(typeof bFlipBtn!=='undefined' && bFlipBtn){ bFlipBtn.setAttribute('data-facing', activeFacing); if(typeof currentDesign!=='undefined' && currentDesign==='b') bFlipBtn.hidden=false; } }catch(e){}
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
function showLoading(text){ if(loadingEl){ loadingEl.hidden=false; if(loadingTextEl) loadingTextEl.textContent=text; } try{ if(typeof loadingB!=='undefined' && loadingB){ loadingB.hidden=false; const lt=loadingB.querySelector('.loading-text'); if(lt) lt.textContent=text; } }catch(e){} }
function hideLoading(){ if(loadingEl) loadingEl.hidden=true; try{ if(typeof loadingB!=='undefined' && loadingB) loadingB.hidden=true; }catch(e){} }
function clearOverlay(){ try{ ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,canvas.width,canvas.height); ctx.restore(); }catch(e){} try{ if(typeof ctxB!=='undefined' && ctxB){ ctxB.save(); ctxB.setTransform(1,0,0,1,0,0); ctxB.clearRect(0,0,canvasB.width,canvasB.height); ctxB.restore(); } }catch(e){} try{ if(typeof bHighlightChipLayer!=='undefined' && bHighlightChipLayer){ bHighlightChipLayer.innerHTML=''; bHighlightChipLayer.hidden=true; } }catch(e){} try{ const hc=document.getElementById('highlightChip'); if(hc) hc.hidden=true; }catch(e){} }
function clearAnswer(){ if(answerEl){ answerEl.innerHTML=''; answerEl.hidden=true; } try{ if(typeof bAnswerSheet!=='undefined' && bAnswerSheet){ bAnswerSheet.hidden=true; bAnswerSheet.classList.remove('is-expanded','is-collapsed'); } if(typeof bAnswerText!=='undefined' && bAnswerText) bAnswerText.textContent=''; if(typeof bAnswerMeta!=='undefined' && bAnswerMeta) bAnswerMeta.textContent=''; if(typeof bAnswerSources!=='undefined' && bAnswerSources) bAnswerSources.innerHTML=''; if(typeof bAnswerChips!=='undefined' && bAnswerChips) bAnswerChips.innerHTML=''; if(typeof bSubtitles!=='undefined' && bSubtitles) bSubtitles.hidden=true; if(typeof bTranscriptBubble!=='undefined' && bTranscriptBubble) bTranscriptBubble.hidden=true; }catch(e){}
  // clear A thread answer bubbles but keep transcript
  try{ const thread=document.getElementById('designAThread'); if(thread){ thread.querySelectorAll('.bub.ai').forEach(el=>el.remove()); } const hc=document.getElementById('highlightChip'); if(hc) hc.hidden=true; }catch(e){} }

// camera handling with Back/Front only, facingMode environment/user, localStorage inside try/catch
async function startCamera(facing){
  const facingMode = (facing==='user') ? 'user' : 'environment';
  // store preference inside try/catch
  try{ localStorage.setItem('cameraFacing', facingMode); }catch(e){}
  currentFacing = facingMode;
  updateCameraButtons(facingMode);
  // stop old stream
  if(currentStream){ try{ currentStream.getTracks().forEach(t=>t.stop()); }catch(e){} currentStream=null; }
  if(cameraFallback) cameraFallback.hidden=true;
  if(cameraFallbackB) cameraFallbackB.hidden=true;
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
      video.srcObject = stream; video.hidden = false;
      try{ video.setAttribute('playsinline',''); video.playsInline=true; video.muted=true; video.autoplay=true; }catch(e){}
      try{ await video.play(); if(tapStart) tapStart.hidden=true; requestWakeLock(); audioSession('play-and-record'); }catch(playErr){ if(tapStart){ tapStart.hidden=false; const btn=tapStart.querySelector('button'); if(btn) btn.onclick=async()=>{ try{ await video.play(); tapStart.hidden=true; requestWakeLock(); }catch(e){} updateAskEnabled(); }; } setStatus('Tap to start camera'); }
    }
    if(videoB){
      videoB.srcObject = stream; videoB.hidden=false;
      try{ videoB.setAttribute('playsinline',''); videoB.playsInline=true; videoB.muted=true; videoB.autoplay=true; }catch(e){}
      try{ await videoB.play(); if(tapStartB) tapStartB.hidden=true; }catch(e){ if(tapStartB){ tapStartB.hidden=false; const btn=tapStartB.querySelector('button'); if(btn) btn.onclick=async()=>{ try{ await videoB.play(); tapStartB.hidden=true; }catch(ex){} updateAskEnabled(); }; } }
    }
    // if we were frozen, go live now? Only on explicit switch, keep frozen? Spec says switching stops old and starts new one; we show live.
    if(isFrozen){
      isFrozen=false;
      if(preview) preview.hidden=true;
      if(previewB) previewB.hidden=true;
      if(video) video.hidden=false;
      if(videoB) videoB.hidden=false;
      clearOverlay(); clearAnswer();
      if(retryBtn) retryBtn.hidden=true;
      if(questionHint) questionHint.hidden=true;
    }
    if(video) video.hidden=false;
    if(videoB) videoB.hidden=false;
    setStatus('Camera ready');
    sendClientEvent('camera_selected', facingMode==='environment' ? 'back' : 'front');
    if(cameraFallback) cameraFallback.hidden=true;
    try{ if(typeof cameraFallbackB!=='undefined' && cameraFallbackB) cameraFallbackB.hidden=true; }catch(e){}
    // hide skeleton
    try{ const sk=document.getElementById('cameraSkeleton'); if(sk) sk.hidden=true; }catch(e){}
    updateAskEnabled();
    if(videoB){
      const onReadyB=()=> updateAskEnabled();
      videoB.addEventListener('loadedmetadata', onReadyB, {once:true});
      videoB.addEventListener('canplay', onReadyB, {once:true});
    }
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
    // permission messages: instruct to allow in browser settings
    if(name==='NotAllowedError' || name==='PermissionDeniedError') msg='I do not have permission to use the camera. Allow it for this site in the browser settings and try again, or choose a photo.';
    else if(name==='NotFoundError' || name==='DevicesNotFoundError') msg='No camera found, choose a photo instead';
    else if(name==='NotReadableError' || name==='AbortError') msg='Camera busy, close other apps or choose a photo';
    else if(name==='OverconstrainedError') msg='Selected camera not available, try the other';
    else if(name==='SecurityError') msg='Camera blocked, use the upload link';
    else msg='Camera unavailable, you can still choose a photo';
    sendClientEvent('camera_error', name||String(e));
    setStatus(msg);
    if(cameraFallback){ cameraFallback.hidden=false; if(cameraFallbackMsg) cameraFallbackMsg.textContent=msg; }
    if(cameraFallbackB){ cameraFallbackB.hidden=false; if(cameraFallbackMsgB) cameraFallbackMsgB.textContent=msg; }
    if(!isFrozen && preview && preview.hidden){ if(video) video.hidden=true; }
    if(!isFrozen && previewB && previewB.hidden){ if(videoB) videoB.hidden=true; }
    updateAskEnabled();
  }
}

// capture from live preview (video) or from fallback preview image
function getBPreviewForCapture(){ try{ if(previewB && !previewB.hidden && previewB.src && (!currentStream || (videoB && videoB.hidden))) return previewB; }catch(e){} return null; }
function captureLiveFrame(){
  return new Promise((resolve, reject)=>{
    // if frozen preview is visible and no video stream, use preview src (fallback upload)
    const usePreview = (preview && !preview.hidden && preview.src) && (!currentStream || (video && video.hidden));
    const usePreviewB = (()=>{ try{ const p=getBPreviewForCapture(); return p && p.src; }catch(e){ return false; } })();
    if(usePreviewB){
      const bPrev = getBPreviewForCapture();
      (async()=>{
        try{
          if(typeof createImageBitmap==='function'){
            try{
              const resp=await fetch(bPrev.src); const blob=await resp.blob();
              const bmp=await createImageBitmap(blob,{imageOrientation:'from-image'});
              const maxSide=1280; const scale=Math.min(1, maxSide/Math.max(bmp.width,bmp.height));
              const cw=Math.round(bmp.width*scale), ch=Math.round(bmp.height*scale);
              const c=document.createElement('canvas'); c.width=cw; c.height=ch; const cx=c.getContext('2d'); cx.drawImage(bmp,0,0,cw,ch); try{ bmp.close(); }catch(e){}
              const dataUrl=c.toDataURL('image/jpeg',0.85); const b64=dataUrl.split(',')[1]||''; const bytes=Math.round(b64.length*3/4);
              resolve({dataUrl, width:cw, height:ch, bytes}); return;
            }catch(e){}
          }
          const img=new Image(); img.onload=()=>{ try{ const maxSide=1280; const w=img.naturalWidth||img.width, h=img.naturalHeight||img.height; const scale=Math.min(1, maxSide/Math.max(w,h)); const cw=Math.round(w*scale), ch=Math.round(h*scale); const c=document.createElement('canvas'); c.width=cw; c.height=ch; const cx=c.getContext('2d'); cx.drawImage(img,0,0,cw,ch); const dataUrl=c.toDataURL('image/jpeg',0.85); const b64=dataUrl.split(',')[1]||''; const bytes=Math.round(b64.length*3/4); resolve({dataUrl, width:cw, height:ch, bytes}); }catch(err){ reject(err); } }; img.onerror=()=>reject(new Error('image load failed')); try{ if(img.decode){ img.src=bPrev.src; await img.decode(); } else img.src=bPrev.src; }catch(e){ img.src=bPrev.src; }
        }catch(err){ reject(err); }
      })(); return;
    }

    if(usePreview){
      // iOS gallery: handle EXIF orientation via createImageBitmap with imageOrientation from-image , fallback to <img> decode
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
    // live video path: prefer Design B video when active
    let activeVideo = video;
    try{ if(currentDesign==='b' && videoB && videoB.videoWidth) activeVideo = videoB; else if(currentDesign==='b' && videoB) activeVideo = videoB; }catch(e){}
    if(!activeVideo || !currentStream){
      reject(new Error('no video'));
      return;
    }
    const vw = activeVideo.videoWidth;
    const vh = activeVideo.videoHeight;
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
      cx.drawImage(activeVideo,0,0,cw,ch);
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
  const wrap=document.getElementById('cameraWrap');
  // transition 350ms cross-fade video->photo with scale 1.00->1.03 and flash
  if(preview){ preview.src = dataUrl; preview.hidden = false; preview.style.opacity='0'; preview.style.transform='scale(1.00)'; preview.style.transition='opacity 350ms ease, transform 350ms ease'; requestAnimationFrame(()=>{ preview.style.opacity='1'; preview.style.transform='scale(1.02)'; setTimeout(()=>{ try{ preview.style.transform='scale(1)'; }catch(e){} }, 350); }); }
  try{ if(typeof previewB!=='undefined' && previewB){ previewB.src = dataUrl; previewB.hidden = false; } }catch(e){}
  if(video){ // keep hidden after fade but allow CSS cross-fade; we hide after 350ms
    video.style.transition='opacity 350ms ease'; video.style.opacity='0'; setTimeout(()=>{ video.hidden=true; video.style.opacity=''; video.style.transition=''; }, 360);
  }
  try{ if(typeof videoB!=='undefined' && videoB){ videoB.style.transition='opacity 350ms ease'; videoB.style.opacity='0'; setTimeout(()=>{ videoB.hidden=true; videoB.style.opacity=''; }, 360); } }catch(e){}
  isFrozen = true;
  // stop camera tracks/mic per spec, light off while thinking/speaking
  try{ stopCameraTracks(); }catch(e){}
  try{ if(wrap){ wrap.classList.add('is-frozen'); wrap.classList.remove('breathing','comet','bloom'); } }catch(e){}
  requestAnimationFrame(syncOverlaySize);
  try{ if(typeof bHighlightChipLayer!=='undefined' && bHighlightChipLayer) bHighlightChipLayer.hidden=true; }catch(e){}
  try{ const hc=document.getElementById('highlightChip'); if(hc) hc.hidden=true; }catch(e){}
  // dim prepared in drawRegions; also clear previous cinematic
  try{ clearDim(); }catch(e){}
  setAppState('thinking');
}

function resetToLive(){
  updateAskEnabled();
  const needsReset = isFrozen || (lastRegions.length>0) || (answerEl && !answerEl.hidden) || (bAnswerSheet && !bAnswerSheet.hidden);
  if(!isFrozen && !needsReset) { if(questionHint) questionHint.hidden=true; return; }
  if(needsReset){
    const wasFrozen=isFrozen;
    isFrozen=false;
    // exit animation 200ms drawing fade out while photo cross-fades to live
    const wrap=document.getElementById('cameraWrap'); const dim=document.getElementById('dimCanvas'); const svg=document.getElementById('highlightSVG');
    try{ if(dim && !dim.hidden){ dim.style.transition='opacity 200ms ease'; dim.style.opacity='0'; setTimeout(()=>{ clearDim(); }, 220); } }catch(e){}
    try{ if(svg && !svg.hidden){ svg.style.transition='opacity 200ms ease'; svg.style.opacity='0'; setTimeout(()=>{ svg.hidden=true; svg.style.opacity=''; svg.style.transition=''; }, 210); } }catch(e){}
    try{ if(wrap){ wrap.classList.remove('is-drawing','comet','bloom','breathing','is-frozen','has-highlight'); } }catch(e){}
    try{ const hc=document.getElementById('highlightChip'); if(hc){ hc.style.transition='opacity 200ms ease'; hc.style.opacity='0'; setTimeout(()=>{ hc.hidden=true; hc.style.opacity=''; hc.style.transition=''; hc.classList.remove('pop'); }, 210); } }catch(e){}
    // photo -> live cross-fade 200ms
    if(wasFrozen && preview && !preview.hidden){
      preview.style.transition='opacity 200ms ease, transform 200ms ease'; preview.style.opacity='1'; requestAnimationFrame(()=>{ preview.style.opacity='0'; preview.style.transform='scale(1.03)'; setTimeout(()=>{ preview.hidden=true; preview.style.opacity=''; preview.style.transform=''; preview.style.transition=''; }, 220); });
    } else { if(preview) { preview.hidden=true; preview.style.opacity=''; } if(previewB) previewB.hidden=true; }
    if(video){ video.hidden=false; video.style.opacity='0'; video.style.transition='opacity 200ms ease'; requestAnimationFrame(()=>{ video.style.opacity='1'; setTimeout(()=>{ video.style.opacity=''; video.style.transition=''; }, 220); }); }
    if(videoB) videoB.hidden=false;
    clearOverlay();
    clearAnswer();
    try{ if(bAnswerSheet) bAnswerSheet.hidden=true; if(bHighlightChipLayer){ bHighlightChipLayer.innerHTML=''; bHighlightChipLayer.hidden=true; } if(bTranscriptBubble) bTranscriptBubble.hidden=true; if(bSubtitles) bSubtitles.hidden=true; }catch(e){}
    if(retryBtn) retryBtn.hidden=true;
    if(questionHint) questionHint.hidden=true;
    lastRegions=[]; lastFrame=null; currentFrame=null; pendingFrameId=null; pendingRequestId=null;
    // restart camera/mic fresh getUserMedia (permission already granted)
    try{ if(!currentStream || currentStream.getTracks().every(t=>t.readyState==='ended')){ startCamera(currentFacing); } }catch(e){}
    try{ updateHeroForAnswer(false); }catch(e){}
    syncOverlaySize(); updateAskEnabled(); setAppState('listening');
  } else { if(questionHint) questionHint.hidden=true; }
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
    if(preview){ preview.src=url; preview.hidden=false; }
    if(previewB){ previewB.src=url; previewB.hidden=false; }
    if(video) video.hidden=true;
    if(videoB) videoB.hidden=true;
    if(cameraFallback) cameraFallback.hidden=true;
    if(cameraFallbackB) cameraFallbackB.hidden=true;
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
    setStatus('Image ready, type a question and tap Ask');
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

function clearBOverlay(){ try{ if(ctxB) ctxB.clearRect(0,0,canvasB.width,canvasB.height); }catch(e){} }
function drawToCanvas(targetCtx, targetCanvas, regions, frame){
  // targetCanvas already sized to CSS box * dpr with transform dpr scaled; draw in CSS pixels
  const cssW = targetCanvas._cssW || targetCanvas.clientWidth || targetCanvas.width;
  const cssH = targetCanvas._cssH || targetCanvas.clientHeight || targetCanvas.height;
  const imgW = (frame && frame.width) ? frame.width : cssW;
  const imgH = (frame && frame.height) ? frame.height : cssH;
  if(!cssW||!cssH||!imgW||!imgH) return;
  // clear with reset transform handling: clear in device pixels
  try{ const dpr=targetCanvas._dpr||1; targetCtx.save(); targetCtx.setTransform(1,0,0,1,0,0); targetCtx.clearRect(0,0,targetCanvas.width,targetCanvas.height); targetCtx.restore(); }catch(e){ try{ targetCtx.clearRect(0,0,cssW,cssH);}catch(_e){} }
  const toDraw=[]; regions.forEach(r=>{ if(r.status==='observed' && r.source==='sam3') toDraw.push(r); else if(r.status==='fallback_box') toDraw.push(r); });
  toDraw.forEach(r=>{
    const poly=r.polygon; if(!Array.isArray(poly)||poly.length<3) return;
    // map each normalized point through cover transform
    const mapped = poly.map(pt=> coverMap(pt[0], pt[1], cssW, cssH, imgW, imgH));
    targetCtx.beginPath();
    mapped.forEach((m,i)=>{ if(i===0) targetCtx.moveTo(m.x,m.y); else targetCtx.lineTo(m.x,m.y); });
    targetCtx.closePath();
    const isFallback = r.status==='fallback_box';
    if(!isFallback){
      targetCtx.save();
      targetCtx.shadowColor='rgba(8,102,255,0.9)'; targetCtx.shadowBlur=6;
      targetCtx.fillStyle='rgba(8,102,255,0.28)';
      targetCtx.fill();
      targetCtx.shadowBlur=0;
      targetCtx.restore();
    } else {
      targetCtx.fillStyle='rgba(255,98,0,0.22)'; targetCtx.fill();
    }
    // outline: 3px white + blue glow
    targetCtx.save();
    if(isFallback) targetCtx.setLineDash([10,8]);
    // halo
    targetCtx.lineWidth=5; targetCtx.strokeStyle='rgba(255,255,255,0.95)'; targetCtx.stroke();
    targetCtx.lineWidth=3; targetCtx.strokeStyle = isFallback ? '#ff6200' : '#fff';
    if(!isFallback){ targetCtx.shadowColor='rgba(8,102,255,0.9)'; targetCtx.shadowBlur=6; }
    // animated dash for draw-in: set dash offset via lineDashOffset if available
    try{ if(!isFallback && targetCtx.lineDashOffset!==undefined){ targetCtx.setLineDash([1000]); targetCtx.lineDashOffset=1000; } }catch(e){}
    targetCtx.stroke(); targetCtx.shadowBlur=0; targetCtx.restore();
  });
  if(demoMode && demoMode.checked){ targetCtx.fillStyle='rgba(255,255,255,0.9)'; targetCtx.font='bold 16px sans-serif'; targetCtx.fillText('DEMO', 12, 24); }
  targetCanvas.dataset.drawn=Date.now();
}
function drawRegions(regions, frame){
  clearOverlay(); try{ if(typeof clearBOverlay==='function') clearBOverlay(); }catch(e){}
  // draw to main canvas using cover-mapped coordinates
  if(canvas && canvas.width && canvas.height) drawToCanvas(ctx, canvas, regions, frame);
  // draw to B canvas with glow if present
  try{ if(typeof canvasB!=='undefined' && canvasB && typeof ctxB!=='undefined' && ctxB && canvasB.width && canvasB.height) drawToCanvas(ctxB, canvasB, regions, frame); }catch(e){}
  // A highlight: SVG outline + pill tag on frozen frame (cover-mapped)
  try{
    const hc=document.getElementById('highlightChip');
    const svg=document.getElementById('highlightSVG');
    const wrap=document.getElementById('cameraWrap');
    if(hc && svg){
      const toShow=(regions||[]).filter(r=> (r.status==='observed' && r.source==='sam3')||r.status==='fallback_box');
      if(toShow.length && frame && wrap){
        const r=toShow[0];
        const poly=r.polygon; if(poly && poly.length>=3){
          const rect=wrap.getBoundingClientRect(); const cssW=rect.width, cssH=rect.height;
          const imgW=frame.width||cssW, imgH=frame.height||cssH;
          const mapped=poly.map(p=> coverMap(p[0], p[1], cssW, cssH, imgW, imgH));
          // set SVG viewBox to css pixels and build path
          svg.setAttribute('viewBox', '0 0 '+cssW+' '+cssH);
          svg.setAttribute('preserveAspectRatio','none');
          svg.style.width=cssW+'px'; svg.style.height=cssH+'px';
          const d='M'+mapped.map(m=> m.x.toFixed(2)+' '+m.y.toFixed(2)).join(' L')+' Z';
          let pEl=svg.querySelector('path'); if(!pEl){ pEl=document.createElementNS('http://www.w3.org/2000/svg','path'); svg.appendChild(pEl); }
          pEl.setAttribute('d', d);
          // retrigger draw animation
          const clone=svg.cloneNode(true); svg.replaceWith(clone); clone.hidden=false; clone.classList.add('hl');
          // gentle pulse once via CSS animation (reuse .hl)
        }
        // label chip at polygon top-centre clamped inside card
        const rect=wrap.getBoundingClientRect(); const cssW2=rect.width, cssH2=rect.height;
        const imgW2=frame.width||cssW2, imgH2=frame.height||cssH2;
        const mapped2=r.polygon.map(p=> coverMap(p[0], p[1], cssW2, cssH2, imgW2, imgH2));
        let minY=Infinity, minX=Infinity, maxX=-Infinity, sumX=0;
        mapped2.forEach(m=>{ if(m.y<minY) minY=m.y; if(m.x<minX) minX=m.x; if(m.x>maxX) maxX=m.x; sumX+=m.x; });
        const cx = sumX/mapped2.length;
        const topY = minY;
        hc.textContent=r.label||r.part||'Highlighted';
        // measure chip width for clamping: estimate 8px padding + text width
        hc.hidden=false; // show to measure if needed, then clamp
        // clamp inside card: x in [chipHalfW, cssW-chipHalfW], y in [8, cssH-8]
        // we set style left/top in px now, not %
        // use getBoundingClientRect after visible to adjust
        hc.style.left = cx + 'px'; hc.style.top = topY + 'px';
        // clamp after layout: run in next frame
        requestAnimationFrame(()=>{
          try{
            const cw=hc.offsetWidth||80, ch=hc.offsetHeight||22;
            let x=cx, y=topY;
            x=Math.max(cw/2+4, Math.min(cssW2 - cw/2 -4, x));
            y=Math.max(ch+6, Math.min(cssH2-4, y));
            hc.style.left=x+'px'; hc.style.top=y+'px';
          }catch(e){}
        });
        hc.hidden=false;
        if(wrap){ wrap.classList.add('has-highlight'); wrap.classList.add('is-frozen'); }
        // cinematic: focus dim + sweep + comet + bloom + ripple + label pop
        try{ const toDrawCine=(regions||[]).filter(r=> (r.status==='observed' && r.source==='sam3')||r.status==='fallback_box'); if(toDrawCine.length){ drawDimMask(toDrawCine, frame); // draw dim outside polygons
          // if multiple regions, stagger ripple 150ms each; for now trigger main cinematic for first, then stagger others
          playCinematic([toDrawCine[0]], frame);
          // stagger additional regions 150ms apart for ripple
          for(let i=1;i<toDrawCine.length;i++){
            ((idx)=>{
              setTimeout(()=>{
                try{ const rip=document.getElementById('ripple'); if(rip){ const pos=positionRipple([toDrawCine[idx]], frame); if(pos){ rip.hidden=false; rip.classList.remove('go'); void rip.offsetWidth; rip.classList.add('go'); setTimeout(()=>{ rip.hidden=true; rip.classList.remove('go'); }, 1000); } } }catch(e){}
              }, i*150);
            })(i);
          }
        } }catch(e){}
      } else { hc.hidden=true; const s=document.getElementById('highlightSVG'); if(s) s.hidden=true; if(wrap){ wrap.classList.remove('has-highlight'); if(!isFrozen) wrap.classList.remove('is-frozen'); } try{ clearDim(); }catch(e){} }
    }
  }catch(e){}
  // B label chips overlay (legacy)
  try{
    if(typeof bHighlightChipLayer!=='undefined' && bHighlightChipLayer){
      bHighlightChipLayer.innerHTML='';
      if(regions && regions.length && frame){
        const toShow = regions.filter(r=> (r.status==='observed' && r.source==='sam3')||r.status==='fallback_box');
        toShow.forEach(r=>{
          const poly=r.polygon; if(!Array.isArray(poly)||!poly.length) return;
          let cx=0,cy=0; poly.forEach(pt=>{ cx+=pt[0]; cy+=pt[1]; }); cx/=poly.length; cy/=poly.length;
          const chip=document.createElement('div'); chip.className='b-label-chip';
          chip.textContent=r.label||r.part||'Highlighted';
          chip.style.left=(cx*100)+'%'; chip.style.top=(cy*100)+'%';
          chip.addEventListener('click', ()=>{ try{ if(previewB && !previewB.hidden) openZoom(previewB.src); else if(preview && !preview.hidden) openZoom(preview.src); }catch(e){} });
          bHighlightChipLayer.appendChild(chip);
        });
        if(toShow.length) bHighlightChipLayer.hidden=false; else bHighlightChipLayer.hidden=true;
      } else bHighlightChipLayer.hidden=true;
    }
  }catch(e){}
}

function renderAnswerB(data){
  if(!bAnswerSheet || !bAnswerText) return;
  let explanation=(data.explanation||'').replace(/\([a-z_]+\)/gi,'').replace(/\b[a-z]+_[a-z_]+\b/gi,'').replace(/\s+/g,' ').trim();
  if(!explanation) explanation='Here is the highlighted part.';
  bAnswerText.textContent = explanation;
  if(bAnswerChips){
    bAnswerChips.innerHTML='';
    const regs=(data.regions||[]).filter(r=> r.status==='observed' && r.source==='sam3');
    regs.forEach(r=>{ const chip=document.createElement('span'); chip.className='b-chip'; chip.textContent=r.label||r.part||'Highlighted'; bAnswerChips.appendChild(chip); });
  }
  if(bAnswerMeta){
    bAnswerMeta.innerHTML='';
    if(data.needs_view){
      const msg=data.needs_view==='flip_board' ? 'Turn the board over so the underside faces the camera, then Ask again.' : data.needs_view==='closer' ? 'Move closer to the board so details are visible, then Ask again.' : '';
      if(msg){ const d=document.createElement('div'); d.textContent=msg; d.style.color='#856404'; d.style.background='rgba(255,243,205,0.9)'; d.style.borderRadius='8px'; d.style.padding='6px 10px'; d.style.marginBottom='6px'; bAnswerMeta.appendChild(d); }
    }
    const prov=data.provenance||{}; const samModel=prov.sam_model; let samText='';
    if(samModel==='sam_unavailable' || samModel==='sam_error') samText='SAM unavailable'; else samText='SAM3 mask';
    const s=document.createElement('div'); s.textContent=samText+' • '; s.style.display='inline'; bAnswerMeta.appendChild(s);
    const notFound=(data.regions||[]).filter(r=> r.source==='sam3' && r.status==='not_found');
    if(notFound.length){ notFound.forEach(r=>{ const p=document.createElement('span'); p.textContent='Missing: '+(r.label||r.part||r.id)+' '; p.style.color='#D93025'; bAnswerMeta.appendChild(p); }); }
  }
  if(bAnswerSources){
    bAnswerSources.innerHTML='';
    if(Array.isArray(data.sources) && data.sources.length){ data.sources.forEach(url=>{ const a=document.createElement('a'); a.href=url; a.target='_blank'; a.rel='noopener'; a.textContent=url; bAnswerSources.appendChild(a); bAnswerSources.appendChild(document.createElement('br')); }); }
  }
  bAnswerSheet.hidden=false; bAnswerSheet.classList.remove('is-expanded'); bAnswerSheet.classList.add('is-collapsed');
  setAppState('answer', explanation.slice(0,40));
  // show frozen frame with glow (drawRegions already did)
  // for B, transcript stays as subtitles, answer sheet slides up
  try{ if(bSubtitles){ bSubtitles.textContent = explanation; bSubtitles.hidden=false; setTimeout(()=>{ if(bSubtitles && !bAnswerSheet.hidden) bSubtitles.hidden=true; }, 1200); } }catch(e){}
}
function renderAnswer(data){
  // populate off-screen #answer for Playwright/operator compat (off-screen not behind bar) – on-screen text lives in thread only
  if(answerEl){ answerEl.textContent=''; answerEl.hidden=false; // CSS moves off-screen
  }
  try{ if(typeof renderAnswerB!=='function'){ } else { renderAnswerB(data); } }catch(e){}
  // Render into A thread: left-aligned white bubble with blue chips
  try{
    const thread=document.getElementById('designAThread');
    if(thread){
      const empty=document.getElementById('emptyState'); if(empty) empty.hidden=true;
      const chipsEl=document.getElementById('suggestedChips'); if(chipsEl) chipsEl.hidden=true;
      // remove any prior ai bubbles and thinking bubble
      const prevThinking=thread.querySelector('.bub.thinking'); if(prevThinking) prevThinking.remove();
      let ai=thread.querySelector('.bub.ai:last-of-type');
      // create new ai bubble
      ai=document.createElement('div'); ai.className='bub ai';
      let explanation=(data.explanation||'').replace(/\([a-z_]+\)/gi,'').replace(/\b[a-z]+_[a-z_]+\b/gi,'').replace(/\s+/g,' ').trim();
      if(!explanation) explanation='Here is the highlighted part.';
      explanation=collapseDuplicateWords(explanation);
      ai.textContent=explanation;
      // add blue chips for regions
      const regions=(data.regions||[]).filter(r=> r.status==='observed' && r.source==='sam3');
      if(regions.length){ const chipRow=document.createElement('div'); chipRow.className='labels';
        regions.forEach(r=>{ const c=document.createElement('span'); c.textContent=r.label||r.part||'Highlighted'; chipRow.appendChild(c); });
        ai.appendChild(chipRow);
      }
      if(data.needs_view){
        const banner=document.createElement('div'); banner.style.color='#856404'; banner.style.background='#fff3cd'; banner.style.borderRadius='8px'; banner.style.padding='6px 8px'; banner.style.marginBottom='6px'; banner.style.fontSize='13px';
        banner.textContent=data.needs_view==='flip_board'?'Turn the board over so the underside faces the camera, then Ask again.':data.needs_view==='closer'?'Move closer to the board so details are visible, then Ask again.':'';
        ai.prepend(banner);
      }
      thread.appendChild(ai);
      // scroll newest bubble fully above bar
      try{
        const bar=document.getElementById('bottomPill');
        const barH= bar ? bar.offsetHeight : 68;
        thread.style.paddingBottom = (barH + 16) + 'px';
        ai.scrollIntoView({block:'end', behavior:'smooth'});
        setTimeout(()=>{ try{ ai.scrollIntoView({block:'end'}); }catch(e){ thread.scrollTop=thread.scrollHeight; } }, 120);
      }catch(e){ thread.scrollTop=thread.scrollHeight; setTimeout(()=>{ thread.scrollTop=thread.scrollHeight; }, 100); }
    }
  }catch(e){}
  if(!answerEl) { setAppState('answer'); return; }
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
  let q='';
  try{
    // Design A single: check #question (bottom pill) then legacy #questionInput
    const qEl=document.getElementById('question');
    if(qEl && qEl.value && qEl.value.trim()) q=qEl.value.trim();
    else if(questionInput && questionInput.value && questionInput.value.trim()) q=questionInput.value.trim();
    else if(typeof bQuestionInput!=='undefined' && bQuestionInput && bQuestionInput.value) q=bQuestionInput.value.trim();
  }catch(e){ try{ q=(questionInput.value||'').trim(); }catch(ex){} }
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
      setStatus('Captured image was blank, try again with camera ready');
    } else if(msg==='video_not_ready'){
      setStatus('Camera not ready, wait a moment and try again');
    } else {
      setStatus('No image to send, allow camera or choose a photo');
    }
    if(retryBtn) retryBtn.hidden=false;
    sendClientEvent('ask_failed', 'no_image_'+msg);
    return;
  }
  if(!captured || !captured.dataUrl){
    setStatus('Could not capture photo, try again');
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
    const payload={frameId, requestId, question:q, image:captured.dataUrl};
    if(liveEnabled && scanLatestId && (Date.now()-scanLatestTs)<60000) payload.scanId=scanLatestId;
    else if(!liveEnabled && scanLatestId && (Date.now()-scanLatestTs)<60000 && scanSpeechId) payload.scanId=scanLatestId;
    const resp=await fetch('/api/analyze',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload),
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
      // error: restore live camera after message per spec
      setAppState('error', msg);
      hideLoading(); clearInterval(stageInterval);
      // brief keep frozen then restore so user can Try again
      setTimeout(()=>{ try{ if(isFrozen){ preview.hidden=true; if(video && currentStream){ video.hidden=false; } isFrozen=false; clearDim(); try{ const s=document.getElementById('highlightSVG'); if(s){ s.hidden=true; } }catch(e){} const wrap=document.getElementById('cameraWrap'); if(wrap) wrap.classList.remove('is-frozen'); startCamera(currentFacing).catch(()=>{}); } setAppState('idle'); }catch(e){} }, 600);
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
    // answer moment: keep frozen photo+drawing, show Ask another, breathing pulse while speaking
    setAppState('answer', (data.explanation||'').slice(0,40));
    updateHeroForAnswer(true);
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
function showTranscript(text){ const clean=collapseDuplicateWords(text); // legacy bubbles hidden permanently – only thread is visible
  if(transcriptBubble){ transcriptBubble.textContent=clean; transcriptBubble.hidden=true; }
  try{ if(typeof bTranscriptBubble!=='undefined' && bTranscriptBubble){ bTranscriptBubble.textContent=clean; bTranscriptBubble.hidden=true; } }catch(e){}
  // also render into thread as right-aligned light-blue bubble
  try{ const thread=document.getElementById('designAThread'); if(thread){ const empty=document.getElementById('emptyState'); if(empty) empty.hidden=true; let me=thread.querySelector('.bub.me'); if(!me){ me=document.createElement('div'); me.className='bub me'; thread.appendChild(me); } me.textContent=clean; me.hidden=false;
    const chips=document.getElementById('suggestedChips'); if(chips) chips.hidden=true;
    try{ me.scrollIntoView({block:'end', behavior:'smooth'}); setTimeout(()=>{ try{ me.scrollIntoView({block:'end'});}catch(e){ thread.scrollTop=thread.scrollHeight; } },120);}catch(e){ thread.scrollTop=thread.scrollHeight; setTimeout(()=>{ thread.scrollTop=thread.scrollHeight; },100); }
  }
  }catch(e){} }
function showSubtitles(text){ const clean=collapseDuplicateWords(text); // legacy subtitles hidden – not shown inside camera card
  if(subtitlesEl){ subtitlesEl.textContent=clean; subtitlesEl.hidden=true; } try{ if(typeof bSubtitles!=='undefined' && bSubtitles){ bSubtitles.textContent=clean; bSubtitles.hidden=true; } }catch(e){}
  try{ if(typeof bTranscriptBubble!=='undefined' && bTranscriptBubble && clean){ bTranscriptBubble.textContent=clean; bTranscriptBubble.hidden=false; } }catch(e){}
}
function clearLiveBubbles(){ if(transcriptBubble) transcriptBubble.hidden=true; if(subtitlesEl) subtitlesEl.hidden=true; try{ if(typeof bTranscriptBubble!=='undefined' && bTranscriptBubble) bTranscriptBubble.hidden=true; if(typeof bSubtitles!=='undefined' && bSubtitles) bSubtitles.hidden=true; }catch(e){} }
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
  liveReadyAnnounced=false; if(liveReadyTimer) clearTimeout(liveReadyTimer);
  liveReadyTimer=setTimeout(()=>announceLiveReady('timeout'), 30000);
  setStatus('Getting ready...'); showReadyOverlay(); prefetchLiveGreeting();
  liveBlocks=[]; liveSpeaking=false; liveVADState={ speechMs:0, silenceMs:0, totalMs:0 };
  // init pre-roll buffer (400ms = 4x100ms blocks, 6400 samples)
  try {
    if (window.LiveAudio && window.LiveAudio.PreRollBuffer) livePreRollBuffer = new window.LiveAudio.PreRollBuffer(6400);
    else livePreRollBuffer = { blocks: [], total:0, maxSamples:6400, push(b){ this.blocks.push(b.slice()); this.total+=b.length; while(this.total>this.maxSamples && this.blocks.length>1){ const r=this.blocks.shift(); this.total-=r.length; } if(this.total>this.maxSamples){ const f=this.blocks[0]; const keep=f.subarray(f.length-this.maxSamples); this.blocks[0]=keep.slice(); this.total=keep.length; } }, get(){ let l=0; for(const a of this.blocks) l+=a.length; const o=new Int16Array(l); let off=0; for(const a of this.blocks){ o.set(a,off); off+=a.length; } return o; }, clear(){ this.blocks=[]; this.total=0; } };
  } catch(e){ livePreRollBuffer=null; }
  // start camera if not already
  if(!currentStream) { try{ await startCamera(currentFacing); }catch(e){} }
  // audioSession
  audioSession('auto');
  try{
    liveStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1}});
  }catch(e){
    setStatus('Microphone permission denied, allow it in browser settings and try Live again');
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
      const src=liveCtx.createMediaStreamSource(liveStream); liveSrcNode=src;
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
    startScanLoop(); return;
  }
  await connectLiveOutput();
  const srcNode=liveCtx.createMediaStreamSource(liveStream); liveSrcNode=srcNode;
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
  // offline banner
  function setOfflineBanner(on){ const b=document.getElementById('offlineBanner'); if(b) b.hidden=!on; }
  window.addEventListener('offline', ()=>{ setOfflineBanner(true); if(liveEnabled) setAppState('error','Offline, check connection'); });
  window.addEventListener('online', ()=>{ setOfflineBanner(false); if(liveEnabled) setAppState('listening'); });
  if(!navigator.onLine) setOfflineBanner(true);
  startScanLoop();
}
function stopLive(){
  liveEnabled=false; stopScanLoop(); if(liveReadyTimer){ clearTimeout(liveReadyTimer); liveReadyTimer=null; } hideReadyOverlay();
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
  liveBlocks=[]; liveSpeaking=false; liveSpeechStartFrame=null; if(livePreRollBuffer) livePreRollBuffer.clear();
}
function handleLiveBlock(int16){
  const level=computeLevelInt16(int16);
  updateLevelMeter(level);
  const isSpeech= level > 0.02;
  // always feed pre-roll buffer (keep last 400ms) when not speaking, so first word not clipped
  if(!liveSpeaking && livePreRollBuffer) livePreRollBuffer.push(int16);
  if(!liveSpeaking){
    if(isSpeech) liveVADState.speechMs+=100; else liveVADState.speechMs=0;
    if(liveVADState.speechMs >= 150){
      // speech start
      liveSpeaking=true;
      liveVADState.silenceMs=0; liveVADState.totalMs=liveVADState.speechMs;
      // prepend last 400ms pre-roll to utterance so first word not cut
      let pre = null;
      try{ pre = livePreRollBuffer ? livePreRollBuffer.get() : null; }catch(e){ pre=null; }
      if(pre && pre.length) liveBlocks=[pre]; else liveBlocks=[];
      // clear pre-roll after consumption to avoid duplication
      if(livePreRollBuffer) livePreRollBuffer.clear();
      liveLatency.speech_start=Date.now(); sendClientEvent('speech_start','');
      setLiveState('Hearing you');
      // T11: capture scanId at speech START
      scanSpeechId = scanLatestId && (Date.now()-scanLatestTs)<60000 ? scanLatestId : null;
      // capture frame at speech START
      captureLiveFrame().then(c=>{
        liveSpeechStartFrame=c;
      }).catch(()=>{ liveSpeechStartFrame=null; });
    }
  } else {
    liveVADState.totalMs+=100;
    liveBlocks.push(int16);
    // do not add to pre-roll while speaking

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
      else if(resp.status===400) setStatus('Could not understand audio, try speaking clearly or type');
      else if(resp.status===504) setStatus('Voice timed out, try again or type');
      else setStatus('Transcribe failed, you can type instead');
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
    if(e.name==='AbortError'){} else { setStatus('Network error, try typing'); setLiveState('Listening'); sendClientEvent('transcribe_fail','network'); }
    if(!navigator.onLine) setStatus('Offline, check connection');
  }
}
async function runLiveAnalyze(captured, question){
  const frameId=makeFrameId(); const requestId=(()=>{ try{ return crypto.randomUUID(); }catch(e){ return 'r'+Math.random().toString(16).slice(2); } })();
  // freeze preview to show captured frame
  try{ freezeFrame(captured.dataUrl, captured.width, captured.height); }catch(e){}
  pendingFrameId=frameId; pendingRequestId=requestId;
  logLatency('analyze_sent'); sendClientEvent('analyze_sent', question.slice(0,60));
  setLiveState('Thinking');
  // (c) One moment handled with cancellable timer and flag; never speak if answer arrives within 3s (we clear timer)
  if(liveOneMomentTimer) clearTimeout(liveOneMomentTimer);
  liveOneMomentActive=false;
  liveOneMomentTimer=setTimeout(()=>{
    liveOneMomentActive=true;
    speakTextLive('One moment', true);
  },3000);
  try{
    const payload={frameId, requestId, question, image:captured.dataUrl};
    if(scanSpeechId) payload.scanId=scanSpeechId;
    const resp=await fetch('/api/analyze',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
    if(liveOneMomentTimer){ clearTimeout(liveOneMomentTimer); liveOneMomentTimer=null; }
    // (c) if One moment was already speaking, cancel it now that answer arrived
    if(liveOneMomentActive){
      try{ liveFlush(); if(window.speechSynthesis) window.speechSynthesis.cancel(); }catch(e){}
      liveOneMomentActive=false;
      sendClientEvent('one_moment_cancel','answer_arrived');
    }
    if(!resp.ok){ await restoreAfterError('Could not analyze, try again'); setAppState('error'); return; }
    const data=await resp.json();
    if(!data || data.frameId!==frameId) return;
    lastRegions=data.regions||[]; lastFrame=currentFrame; drawRegions(lastRegions, currentFrame); renderAnswer(data);
    logLatency('answer'); sendClientEvent('answer', String(data.explanation||'').slice(0,80));
    setStatus('Answer ready');
    // speak answer
    const answerText=data.explanation||'';
    if(answerText) await speakAnswerLive(answerText); else setAppState('answer');
  }catch(e){ if(liveOneMomentTimer){ clearTimeout(liveOneMomentTimer); liveOneMomentTimer=null; } await restoreAfterError('Network error, try again'); setAppState('error'); }
}
async function speakAnswerLive(answerText){
  setAppState('speaking', answerText.slice(0,40));
  setLiveState('Speaking'); showSubtitles(answerText);
  livePausedForPlayback=true; audioSession('playback');
  if(liveResumeAfterSpeakTimeout){ clearTimeout(liveResumeAfterSpeakTimeout); liveResumeAfterSpeakTimeout=null; }
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
      // wait until this buffer finished? We schedule nextTime in order; to keep order we don't wait strictly but allow overlap
      // small delay to ensure ordering
    }catch(e){
      liveFallbackTTS(sent);
      sendClientEvent('tts_fallback', String(e).slice(0,80));
    }
  }
  // wait for all sources to finish then resume listening with 400ms extra pause for echo (d)
  const checkDone=setInterval(()=>{
    if(liveSources.size===0){
      clearInterval(checkDone);
      // (d) keep mic paused 400ms after last sample to avoid speaker feedback
      liveResumeAfterSpeakTimeout = setTimeout(()=>{
        livePausedForPlayback=false;
        audioSession('playback');
        // the photo and the drawing stay on screen; the camera and microphone stay off until Ask another is tapped
        setAppState('answer', answerText.slice(0,60));
      }, 400);
    }
  },200);
  // fallback timeout: if no audio, finish the turn after 12 s (photo stays, Ask another appears)
  setTimeout(()=>{ clearInterval(checkDone); if(livePausedForPlayback){ liveResumeAfterSpeakTimeout=setTimeout(()=>{ livePausedForPlayback=false; audioSession('playback'); setAppState('answer'); },400); } }, 12000);
}
function speakTextLive(text, isMoment){
  if(isMoment) liveOneMomentActive=true;
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
const flipBtn=document.getElementById('cameraFlipBtn'); if(flipBtn) flipBtn.onclick=async ()=>{ const next=currentFacing==='environment'?'user':'environment'; await startCamera(next); };

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
// ResizeObserver guard (fallback to resize)
try{ if(typeof ResizeObserver!=='undefined'){ const ro=new ResizeObserver(()=> syncOverlaySize()); const wrap=document.getElementById('cameraWrap'); if(wrap) ro.observe(wrap); }}catch(e){}
// AbortSignal.timeout guard: wrap in try/catch and fallback to AbortController+setTimeout (already used)
function timeoutSignal(ms){ try{ if(typeof AbortSignal!=='undefined' && typeof AbortSignal.timeout==='function') return AbortSignal.timeout(ms); }catch(e){} const c=new AbortController(); setTimeout(()=>c.abort(), ms); return c.signal; }
window.onresize=()=>{ syncOverlaySize(); updateAskEnabled(); };
// iOS orientation change
window.addEventListener('orientationchange', ()=>{ setTimeout(()=>{ syncOverlaySize(); updateAskEnabled(); }, 300); });
// visibilitychange: stop tracks when hidden, restart when visible
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState==='visible'){ if(!currentStream && !isFrozen){ startCamera(currentFacing); } try{ if(video && video.paused && currentStream) video.play(); }catch(e){} requestWakeLock(); if(liveEnabled && !scanTick) startScanLoop(); }
  else { try{ if(wakeLock){ wakeLock.release(); wakeLock=null; } }catch(e){} audioSession('auto'); if(scanTick) stopScanLoop(); }
});
window.addEventListener('pagehide', ()=>{ try{ if(currentStream) currentStream.getTracks().forEach(t=>t.stop()); }catch(e){} releaseWakeLock(); });
// visualViewport keyboard handling: keep question input above keyboard
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
  // offline banner duplicate handler kept for telemetry; main one above shows banner
  window.addEventListener('offline', ()=>{ sendClientEvent('offline_online','offline'); const b=document.getElementById('offlineBanner'); if(b) b.hidden=false; });
  window.addEventListener('online', ()=>{ sendClientEvent('offline_online','online'); const b=document.getElementById('offlineBanner'); if(b) b.hidden=true; });
  // start camera as soon as page opens
  await startCamera(currentFacing);
})();

// ===== V2 DESIGN SYSTEM =====
// Design persistence: URL ?design= and localStorage, default a
function getDesignFromURL(){ try{ const u=new URLSearchParams(window.location.search); const d=u.get('design'); if(['a','b','c','d'].includes(d)) return d; }catch(e){} return null; }
function getDesignStored(){ try{ const s=localStorage.getItem('sit_design'); if(['a','b','c','d'].includes(s)) return s; }catch(e){} return null; }
let currentDesign = getDesignFromURL() || getDesignStored() || 'a';
function applyDesign(d){
  currentDesign=d;
  try{ localStorage.setItem('sit_design', d); }catch(e){}
  try{
    const url=new URL(window.location.href);
    url.searchParams.set('design', d);
    window.history.replaceState({},'',url.toString());
  }catch(e){}
  document.documentElement.setAttribute('data-design', d);
  document.body.setAttribute('data-design', d);
  // show/hide design sections
  document.querySelectorAll('[data-design-section]').forEach(el=>{ el.hidden = el.getAttribute('data-design-section') !== d; });
  // update pill label
  const pill=document.getElementById('designPill'); if(pill) pill.textContent = 'Design '+d.toUpperCase();
  sendClientEvent('design_switch', d);
  // for classic D, restore legacy topbar visibility
  updateDesignSpecificUI();
}
function updateDesignSpecificUI(){
  const isClassic = currentDesign==='d';
  const camSelectWrap=document.getElementById('cameraSelectWrap');
  if(camSelectWrap) camSelectWrap.style.display = isClassic ? '' : 'none';
  const questionCard=document.querySelector('.question-card');
  if(questionCard) questionCard.style.display = isClassic ? '' : 'none';
  const hero=document.getElementById('heroLiveBtn');
  if(hero) hero.hidden=false;
  try{ if(currentDesign==='b' && bFlipBtn) bFlipBtn.hidden=false; }catch(e){}
  try{ if(bAnswerSheet && currentDesign!=='b') bAnswerSheet.hidden=true; }catch(e){}
}
// Design switcher pill interactions
function initDesignSwitcher(){
  const pill=document.getElementById('designPill');
  const menu=document.getElementById('designMenu');
  if(!pill || !menu) return;
  pill.addEventListener('click', ()=>{ menu.hidden = !menu.hidden; });
  menu.addEventListener('click', e=>{
    const btn=e.target.closest('button[data-design]');
    if(btn){ const d=btn.getAttribute('data-design'); applyDesign(d); menu.hidden=true; }
    const sim=e.target.closest('#simulateBtn');
    if(sim){ menu.hidden=true; startSimulate(); }
  });
  document.addEventListener('click', e=>{ if(!pill.contains(e.target) && !menu.contains(e.target)) menu.hidden=true; });
  // apply initial
  applyDesign(currentDesign);
}
// Simulate states: cycle every state with canned transcript/answer/highlight
let simulateTimer=null;
let simulateIdx=0;
const SIM_STATES=[
  {state:'idle', transcript:'', answer:'', status:'Tap Live and ask about anything', regions:[]},
  {state:'permission_needed', transcript:'', answer:'', status:'Camera and microphone needed to see and answer', regions:[]},
  {state:'starting', transcript:'', answer:'', status:'Starting camera and mic…', regions:[]},
  {state:'listening', transcript:'', answer:'', status:'Listening, speak naturally', regions:[]},
  {state:'hearing', transcript:'Where is the power supply?', answer:'', status:'Hearing you…', regions:[]},
  {state:'thinking', transcript:'Where is the power supply?', answer:'', status:'Thinking…', regions:[]},
  {state:'speaking', transcript:'Where is the power supply?', answer:'The USB-C power port is on the left side, next to the micro-HDMI ports.', status:'Speaking…', regions:[{polygon:[[0.12,0.45],[0.18,0.45],[0.18,0.6],[0.12,0.6]]}]},
  {state:'answer', transcript:'Where is the power supply?', answer:'The USB-C power port is on the left side, next to the micro-HDMI ports.', status:'Answer ready', regions:[{polygon:[[0.12,0.45],[0.18,0.45],[0.18,0.6],[0.12,0.6]]}]},
  {state:'error', transcript:'', answer:'', status:'Microphone permission denied, allow it and try again', regions:[]},
];
function startSimulate(){
  if(simulateTimer) clearInterval(simulateTimer);
  simulateIdx=0;
  sendClientEvent('simulate_start','');
  function tick(){
    const s=SIM_STATES[simulateIdx % SIM_STATES.length];
    setAppState(s.state, s.status);
    // update canned UI via custom event for Design A renderer
    try{ window.dispatchEvent(new CustomEvent('simulate-state',{detail:s})); }catch(e){}
    // also render canned transcript/answer/highlight in classic overlay for demo
    const tb=document.getElementById('transcriptBubble');
    const ans=document.getElementById('answer');
    const sub=document.getElementById('subtitles');
    if(s.transcript && tb){ tb.textContent=s.transcript; tb.hidden=false; }
    else if(tb){ tb.hidden=true; }
    if(s.answer && ans){ ans.textContent=s.answer; ans.hidden=false; }
    else if(ans && s.state!=='answer' && s.state!=='speaking'){ ans.hidden=true; }
    if(s.regions && s.regions.length){ lastRegions=s.regions.map((r,i)=>({id:'sim'+i, polygon:r.polygon, bbox:[0.12,0.45,0.18,0.6], score:0.9, status:'observed', source:'sim'})); lastFrame={width:640,height:480}; try{ drawRegions(lastRegions, lastFrame); }catch(e){} }
    else { try{ clearOverlay(); }catch(e){} }
    simulateIdx++;
  }
  tick();
  simulateTimer=setInterval(tick, 1800);
  // auto stop after 2 cycles
  setTimeout(()=>{ clearInterval(simulateTimer); simulateTimer=null; setAppState('idle'); }, SIM_STATES.length*1800*2 + 500);
}
// Permission screen: first-run one-sentence explanation before browser prompt
function initPermissionScreen(){
  const screen=document.getElementById('permissionScreen');
  const btn=document.getElementById('permissionBtn');
  if(!screen || !btn) return;
  let seen=false;
  try{ seen=localStorage.getItem('sit_perm_seen')==='1'; }catch(e){}
  if(!seen){
    setAppState('permission_needed');
    screen.hidden=false;
  }
  btn.addEventListener('click', async ()=>{
    screen.hidden=true;
    try{ localStorage.setItem('sit_perm_seen','1'); }catch(e){}
    setAppState('starting');
    // trigger camera+mic permission prompts
    try{
      await startCamera(currentFacing);
      // audio permission test: try getUserMedia audio
      try{
        const s=await navigator.mediaDevices.getUserMedia({audio:true}); s.getTracks().forEach(t=>t.stop());
      }catch(e){}
      setAppState('idle');
    }catch(e){
      setAppState('error', String(e.message||'permission'));
      screen.hidden=false;
      const msgEl=document.getElementById('permissionMsg'); if(msgEl) msgEl.textContent='Camera or microphone blocked, please allow in browser settings and try again.';
    }
  });
}
function initMenuSheet(){
  const btn=document.getElementById('menuBtn');
  const sheet=document.getElementById('menuSheet');
  const close=document.getElementById('menuClose');
  const backdrop=document.getElementById('menuBackdrop');
  if(!btn || !sheet) return;
  const open=()=>{ sheet.hidden=false; btn.setAttribute('aria-expanded','true'); sheet.setAttribute('aria-hidden','false'); };
  const hide=()=>{ sheet.hidden=true; btn.setAttribute('aria-expanded','false'); };
  btn.addEventListener('click', open);
  if(close) close.addEventListener('click', hide);
  if(backdrop) backdrop.addEventListener('click', hide);
  sheet.addEventListener('keydown', e=>{ if(e.key==='Escape') hide(); });
}
// Camera flip: only show when >1 camera exists
async function updateCameraFlipVisibility(){
  const flipBtn=document.getElementById('cameraFlipBtn');
  if(!flipBtn) return;
  try{
    if(!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices){ flipBtn.hidden=true; return; }
    const devices=await navigator.mediaDevices.enumerateDevices();
    const cams=devices.filter(d=>d.kind==='videoinput');
    flipBtn.hidden = cams.length <=1;
    // also update legacy buttons hidden for non-classic
    updateDesignSpecificUI();
  }catch(e){ flipBtn.hidden=true; }
}
// Keyboard icon toggle for typing
function initKeyboardToggle(){
  const toggle=document.getElementById('keyboardToggle');
  const wrap=document.getElementById('keyboardInputWrap');
  const input=document.getElementById('question');
  const sendBtn=document.getElementById('keyboardSendBtn');
  if(!toggle || !wrap) return;
  toggle.addEventListener('click', ()=>{
    const isHidden = wrap.hidden;
    wrap.hidden = !isHidden;
    if(!wrap.hidden && input) input.focus();
    toggle.setAttribute('aria-expanded', String(!isHidden));
  });
  if(sendBtn) sendBtn.addEventListener('click', ()=>{ ask(); wrap.hidden=true; });
  if(input) input.addEventListener('keydown', e=>{ if(e.key==='Enter'){ ask(); wrap.hidden=true; }});
}
// Hero Live button wire
function initHeroLive(){
  const hero=document.getElementById('heroLiveBtn');
  const hero2=document.getElementById('liveToggle'); // legacy
  if(!hero) return;
  hero.addEventListener('click', async ()=>{
    if(appState==='answer'){
      await askAnother();
      return;
    }
    if(!liveEnabled) await startLive(); else stopLive();
  });
  // sync hero label with live state via AppState listener (answer handled in setAppState)
  onAppState(({state})=>{
    if(!hero) return;
    if(state==='answer'){ hero.innerHTML='<span class="live-label">Ask another</span>'; hero.classList.remove('is-active'); hero.classList.add('is-ask-another'); hero.style.background='linear-gradient(135deg,#0866FF,#2e7dfe)'; hero.setAttribute('aria-label','Ask another'); return; }
    hero.classList.remove('is-ask-another'); hero.style.background='';
    if(liveEnabled && (state==='listening'||state==='hearing'||state==='thinking'||state==='speaking')){
      hero.textContent='Stop';
      hero.classList.add('is-active');
      hero.setAttribute('aria-label','Stop live mode');
    } else {
      hero.innerHTML='<span class="wave-glyph" aria-hidden="true">〰</span> Live';
      hero.classList.remove('is-active');
      hero.setAttribute('aria-label','Start live mode');
    }
  });
  // also allow legacy toggle to drive hero
  if(hero2) hero2.addEventListener('click', ()=>{ // keep sync
    setTimeout(()=>{ const ev=new Event('click'); },0);
  });
}
// State indicator animation helpers (pulse, waveform, dots, bars)
function initStateIndicators(){
  const indicator=document.getElementById('stateIndicator');
  if(indicator) onAppState(({state})=>{ indicator.setAttribute('data-state', state); indicator.className='state-indicator is-'+state; });
  // B indicator already mirrors via setAppState, but also init reduced-motion handling via CSS
}
function initDesignB(){
  initBRefs();
  // ensure flip visible when B active (override hidden attr from HTML)
  try{ if(bFlipBtn) { bFlipBtn.hidden=false; bFlipBtn.style.display='flex'; } if(bMenuBtn) bMenuBtn.hidden=false; }catch(e){}
  // keep flip visible after design switches
  try{ onAppState(()=>{ if(currentDesign==='b' && bFlipBtn) { bFlipBtn.hidden=false; } }); }catch(e){}
  try{
    if(bKeyboardBtn && bKeyboardSheet){
      bKeyboardBtn.addEventListener('click', ()=>{ bKeyboardSheet.hidden=!bKeyboardSheet.hidden; if(!bKeyboardSheet.hidden && bQuestionInput) setTimeout(()=>bQuestionInput.focus(), 80); });
      // close when clicking outside? keep simple: second tap closes
    }
    if(bQuestionSend){
      const doSend=()=>{
        const q=(bQuestionInput.value||'').trim();
        if(!q){ if(bQuestionInput){ bQuestionInput.focus(); }
          return;
        }
        // sync to legacy input so ask() picks it up, then call ask
        try{ if(questionInput) questionInput.value=q; }catch(e){}
        bKeyboardSheet.hidden=true;
        ask();
      };
      bQuestionSend.addEventListener('click', doSend);
      if(bQuestionInput) bQuestionInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); doSend(); } });
    }
    if(bGalleryBtn){ const file=document.getElementById('file'); if(file) bGalleryBtn.addEventListener('click', ()=> file.click()); }
    if(bFlipBtn){ bFlipBtn.addEventListener('click', async ()=>{ const next=currentFacing==='environment'?'user':'environment'; await startCamera(next); }); }
    // suggested chips above Live bar - tap fills, disappear after first question
    try{
      const bChips=document.getElementById('bSuggestedChips');
      if(bChips){
        bChips.addEventListener('click', e=>{
          const btn=e.target.closest('button[data-q]'); if(!btn) return;
          const q=btn.getAttribute('data-q')||'';
          if(bQuestionInput){ bQuestionInput.value=q; bKeyboardSheet.hidden=false; bQuestionInput.focus(); }
          else if(questionInput) questionInput.value=q;
          try{ sendClientEvent('suggested_tap', q.slice(0,80)); }catch(ex){}
        });
        // hide after first ask / transcript
        onAppState(({state})=>{ if(state!=='idle' && bChips) bChips.hidden=true; if(state==='idle' && bChips && !bChips.hidden) { /* keep if never asked */ } });
        const hideChipsOnce=()=>{ if(bChips) bChips.hidden=true; };
        if(bQuestionSend) bQuestionSend.addEventListener('click', hideChipsOnce);
        if(bQuestionInput) bQuestionInput.addEventListener('keydown', e=>{ if(e.key==='Enter') hideChipsOnce(); });
      }
    }catch(e){}
    if(bMenuBtn){ bMenuBtn.addEventListener('click', ()=>{ const m=document.getElementById('designMenu'); if(m) m.hidden=!m.hidden; const p=document.getElementById('designPill'); if(p&&m) m.hidden=!m.hidden; // toggle via pill
        // fallback: toggle menu
        try{ const menu=document.getElementById('designMenu'); if(menu) menu.hidden=!menu.hidden; }catch(e){}
      }); }
    // answer sheet interactions
    if(bAnswerSheet){
      const handle=bAnswerSheet.querySelector('.b-sheet-handle');
      bAnswerSheet.addEventListener('click', e=>{
        // tap to expand: if collapsed and click not on close, expand
        if(!bAnswerSheet.classList.contains('is-expanded') && !e.target.closest('.b-sheet-close')){ bAnswerSheet.classList.add('is-expanded'); bAnswerSheet.classList.remove('is-collapsed'); if(bSheetContent) bSheetContent.hidden=false; }
      });
      if(handle) handle.addEventListener('click', e=>{ e.stopPropagation(); if(bAnswerSheet.classList.contains('is-expanded')){ bAnswerSheet.classList.remove('is-expanded'); bAnswerSheet.classList.add('is-collapsed'); } else { bAnswerSheet.classList.add('is-expanded'); bAnswerSheet.classList.remove('is-collapsed'); } });
      const closeBtn=bAnswerSheet.querySelector('.b-sheet-close'); if(closeBtn) closeBtn.addEventListener('click', e=>{ e.stopPropagation(); bAnswerSheet.hidden=true; bAnswerSheet.classList.remove('is-expanded'); // return to live
        resetToLive(); });
      // swipe down to dismiss
      let startY=0; let dragging=false;
      bAnswerSheet.addEventListener('touchstart', e=>{ if(!e.touches||!e.touches[0]) return; startY=e.touches[0].clientY; dragging=true; }, {passive:true});
      bAnswerSheet.addEventListener('touchmove', e=>{ if(!dragging) return; const dy=e.touches[0].clientY - startY; if(dy>30) bAnswerSheet.style.transform='translateY('+dy+'px)'; }, {passive:true});
      bAnswerSheet.addEventListener('touchend', e=>{ dragging=false; bAnswerSheet.style.transform=''; const dy=(e.changedTouches&&e.changedTouches[0]) ? e.changedTouches[0].clientY - startY : 0; if(dy>70){ bAnswerSheet.hidden=true; bAnswerSheet.classList.remove('is-expanded'); resetToLive(); } }, {passive:true});
      // also enable sheet-content toggling tap expand
      if(bSheetContent) bSheetContent.addEventListener('click', ()=>{
        if(!bAnswerSheet.classList.contains('is-expanded')){ bAnswerSheet.classList.add('is-expanded'); bAnswerSheet.classList.remove('is-collapsed'); }
      });
    }
    if(bLiveBtn){
      bLiveBtn.addEventListener('click', async ()=>{
        // toggle Live: reuse global liveEnabled flow from HeroLive but also handle B button
        const topLive=document.getElementById('liveBtn'); // Design A liveBtn may not exist, but hook exists via hero
        if(liveEnabled){ // turn off
          try{ if(window.__stopLive) await window.__stopLive(); else { liveEnabled=false; setAppState('idle'); if(window.__liveStopHook) window.__liveStopHook(); } }catch(e){}
          // also update B via setAppState already
        } else {
          // start via permission-screen or existing hero init
          try{ const heroLive=document.getElementById('heroLiveBtn'); if(heroLive) heroLive.click(); else if(window.__startLive) await window.__startLive(); else { // fallback: start camera+mic minimal
            await startCamera(currentFacing); liveEnabled=true; setAppState('listening'); } }catch(e){ setAppState('error', String(e.message||e)); }
        }
      });
    }
    // B video events
    if(videoB){ videoB.addEventListener('loadedmetadata', syncOverlaySize); videoB.addEventListener('canplay', syncOverlaySize); videoB.addEventListener('click', ()=>{ if(isFrozen && bAnswerSheet && !bAnswerSheet.hidden){ // frozen: tap to zoom or go live
        if(previewB && previewB.src) openZoom(previewB.src); } }); }
    if(previewB){ previewB.addEventListener('click', ()=>{ if(previewB.src && !previewB.hidden) openZoom(previewB.src); if(isFrozen && bAnswerSheet && !bAnswerSheet.hidden){ bAnswerSheet.hidden=true; resetToLive(); } }); }
    if(canvasB){ canvasB.addEventListener('click', ()=>{ if(isFrozen && previewB && previewB.src) openZoom(previewB.src); }); }
  }catch(e){}
}
// Gallery plus button removed for Design A, no visible button
function initGalleryPlus(){}
// Init all V2 once DOM ready
function initV2(){
  try{ initDesignSwitcher(); }catch(e){}
  initPermissionScreen();
  initMenuSheet();
  initKeyboardToggle();
  initHeroLive();
  initStateIndicators();
  initGalleryPlus();
  initDesignB();
  updateCameraFlipVisibility();
  if(navigator.mediaDevices && navigator.mediaDevices.addEventListener){
    navigator.mediaDevices.addEventListener('devicechange', updateCameraFlipVisibility);
  }
  // initial state
  setAppState('idle');
  // Design A specific: bind simulate-state to thread rendering
  window.addEventListener('simulate-state', e=>{
    const s=e.detail;
    const thread=document.getElementById('designAThread');
    if(thread){
      if(s.state==='hearing' || s.state==='thinking' || s.state==='speaking' || s.state==='answer'){
        thread.hidden=false;
        const userBubble=thread.querySelector('.user-bubble');
        const answerBubble=thread.querySelector('.assistant-bubble');
        if(userBubble) userBubble.textContent = s.transcript||'';
        if(answerBubble) answerBubble.textContent = s.answer||'';
      } else if(s.state==='idle'){ thread.hidden=false; }
    }
    // Also mirror to Design B subtitles/sheet
    try{
      if(s.transcript && bTranscriptBubble){ bTranscriptBubble.textContent=s.transcript; bTranscriptBubble.hidden=false; }
      else if(bTranscriptBubble && (s.state==='idle'||s.state==='listening')) bTranscriptBubble.hidden=true;
      if(s.state==='speaking' && bSubtitles && s.answer){ bSubtitles.textContent=s.answer; bSubtitles.hidden=false; }
      if(s.state==='answer' && s.answer){ if(bAnswerText) bAnswerText.textContent=s.answer; if(bAnswerSheet) { bAnswerSheet.hidden=false; bAnswerSheet.classList.remove('is-expanded'); bAnswerSheet.classList.add('is-collapsed'); } }
      if(s.state==='idle'){ if(bAnswerSheet) bAnswerSheet.hidden=true; }
      if(s.regions && s.regions.length){ lastRegions=s.regions.map((r,i)=>({id:'sim'+i, polygon:r.polygon, bbox:[0.12,0.45,0.18,0.6], score:0.9, status:'observed', source:'sim'})); lastFrame={width:640,height:480}; try{ drawRegions(lastRegions, lastFrame); }catch(e){} }
    }catch(e2){}
  });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', initV2); else initV2();

// Helpers for fade export verification (used by node test)
window.__audioFade = { applyFade, fadeMs:10 };

// expose for tests
window.__app={ startCamera, captureLiveFrame, ask, resetToLive, frameDifference, captureGrayscale32, applyDesign, getDesign:()=>currentDesign, startSimulate, get state(){ return {isFrozen, asking, currentStream, currentFacing, currentFrame, scanLatestId, scanInFlight, appState, design:currentDesign}; } };

