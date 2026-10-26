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

let currentFrame = null;
let pendingFrameId = null;
let pendingRequestId = null;
let lastRegions = [];
let lastFrame = null;
let uploadSeq = 0;

function setStatus(s){statusEl.textContent=s; statusEl.setAttribute('aria-live','polite');}

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
  canvas.style.width = rect.width+'px';
  canvas.style.height = rect.height+'px';
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
    setStatus('Camera unavailable – use upload');
    video.hidden = true;
  }
}

function makeFrameId(){return crypto.randomUUID();}
function orientationFrom(w,h){return w>=h?'landscape':'portrait';}

function captureFromVideo(){
  const w = video.videoWidth, h = video.videoHeight;
  if(!w||!h){setStatus('No video');return;}
  uploadSeq++;
  lastRegions = [];
  lastFrame = null;
  const img = new Image();
  const tmp = document.createElement('canvas');
  tmp.width=w; tmp.height=h;
  tmp.getContext('2d').drawImage(video,0,0,w,h);
  preview.src = tmp.toDataURL('image/png');
  preview.hidden=false;
  video.hidden=true;
  currentFrame = {
    frameId: makeFrameId(),
    width:w, height:h,
    orientation: orientationFrom(w,h),
    timestamp: Date.now(),
    src:'camera'
  };
  retakeBtn.hidden=false;
  setStatus('Frame captured');
  clearOverlay();
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
    preview.hidden=false;
    video.hidden=true;
    currentFrame = {
      frameId: makeFrameId(),
      width: img.naturalWidth,
      height: img.naturalHeight,
      orientation: orientationFrom(img.naturalWidth, img.naturalHeight),
      timestamp: Date.now(),
      src:'upload'
    };
    retakeBtn.hidden=false;
    setStatus('Image uploaded');
    // size overlay after image loads and layout
    requestAnimationFrame(syncOverlaySize);
  };
  img.onerror = ()=>{ setStatus('Corrupt image'); URL.revokeObjectURL(url); currentObjectUrl=null; };
  img.src = url;
}

function clearOverlay(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
}

function drawRegions(regions, frame){
  clearOverlay();
  const w = canvas.width, h = canvas.height;
  if(!regions || !Array.isArray(regions)){ return; }
  regions.forEach(r=>{
    const nx = Number(r.nx), ny = Number(r.ny), nw = Number(r.nw), nh = Number(r.nh);
    if(![nx,ny,nw,nh].every(v=>Number.isFinite(v) && v>=0 && v<=1)){ return; }
    const x = nx*w - nw*w/2;
    const y = ny*h - nh*h/2;
    ctx.strokeStyle = '#0ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x,y,nw*w,nh*h);
    ctx.fillStyle = '#0ff';
    ctx.font = '16px sans-serif';
    ctx.fillText(String(r.label||''), x, y>20?y-4:y+16);
  });
}

function mockResponse(frameId, question, requestId){
  // Deterministic fixture, labeled as demo. SAM approval granted but token auth blocked.
  return new Promise(res=>{
    setTimeout(()=>{
      const offset = (question?.length || 0) % 5;
      const nx = 0.25 + offset*0.05;
      res({
        requestId,
        frameId,
        status: 'ok',
        regions: [
          {id:'demo-1', nx, ny:0.4, nw:0.1, nh:0.1, label:'Demo part', confidence:0.7}
        ],
        explanation:'Demo fixture – model unavailable for UI demo. SAM approval granted but token authentication blocked, so SAM unavailable.',
        sources:['BUILD-PLAN.md'],
        model:{name:'muse-glimmer-hackathon', revision:'cec94fcfd6512f2cfe708138c32533b346ea4f69'},
        sam:{available:false, maskId:null}
      });
    },800);
  });
}

async function ask(){
  if(!currentFrame){setStatus('Capture first');return;}
  const q = questionInput.value.trim();
  if(!q){setStatus('Enter a question');return;}
  if(!demoMode.checked){setStatus('Model unavailable – enable demo mode for fixtures');return;}
  const frameId = currentFrame.frameId;
  const requestId = crypto.randomUUID();
  pendingFrameId = frameId;
  pendingRequestId = requestId;
  setStatus('Thinking…');
  const resp = await mockResponse(frameId, q, requestId);
  // validate response shape
  if(!resp || !resp.frameId || !resp.requestId){
    setStatus('Invalid response');
    return;
  }
  // stale response protection: null frame, frame mismatch, or request mismatch
  if(!currentFrame || resp.frameId !== currentFrame.frameId || resp.frameId !== pendingFrameId || resp.requestId !== pendingRequestId){
    setStatus('Response discarded – new frame or request');
    return;
  }
  if(resp.status==='unavailable'){
    setStatus('Model unavailable');
    return;
  }
  if(resp.status==='view_needed'){
    setStatus('Please show another view');
    return;
  }
  const regions = resp.regions||[];
  const filtered = regions.filter(r=>{
    const nx=Number(r.nx), ny=Number(r.ny), nw=Number(r.nw), nh=Number(r.nh);
    return Number.isFinite(nx)&&Number.isFinite(ny)&&Number.isFinite(nw)&&Number.isFinite(nh)&&nx>=0&&nx<=1&&ny>=0&&ny<=1&&nw>0&&nw<=1&&nh>0&&nh<=1;
  });
  lastRegions = filtered;
  lastFrame = currentFrame;
  drawRegions(filtered, currentFrame);
  setStatus('Demo overlay shown');
}

captureBtn.onclick = captureFromVideo;
retakeBtn.onclick = ()=>{
  uploadSeq++;
  currentFrame=null;
  pendingFrameId = null;
  pendingRequestId = null;
  lastRegions = [];
  lastFrame = null;
  if(currentObjectUrl){ URL.revokeObjectURL(currentObjectUrl); currentObjectUrl=null; }
  preview.hidden=true;
  video.hidden=false;
  retakeBtn.hidden=true;
  setStatus('Ready');
  clearOverlay();
  syncOverlaySize();
};
uploadBtn.onclick = ()=>fileInput.click();
fileInput.onchange = e=>{ const f=e.target.files[0]; if(f) captureFromFile(f); };
askBtn.onclick = ask;

video.onloadedmetadata = syncOverlaySize;
preview.onload = syncOverlaySize;
window.onresize = syncOverlaySize;
startCamera();
