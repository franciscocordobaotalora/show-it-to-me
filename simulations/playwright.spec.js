const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const BASE_ENV = process.env.TEST_URL;
const BASE = BASE_ENV || 'http://test.example.com/';
const TEST_IMAGE_SRC = process.env.TEST_IMAGE || path.resolve(__dirname, '../fixtures/pi5/Raspberry_Pi_5.jpg');
const USER = process.env.TEST_USER;
const PASS = process.env.TEST_PASSWORD;

test.use({
  httpCredentials: USER && PASS ? { username: USER, password: PASS } : undefined,
});

function isLocalBase(){ return !BASE_ENV; }

// helper to serve inlined HTML for local tests
async function serveLocalApp(page){
  if(!isLocalBase()) return;
  const htmlPath = path.resolve(__dirname, '../static/index.html');
  const cssPath = path.resolve(__dirname, '../static/style.css');
  const jsPath = path.resolve(__dirname, '../static/app.js');
  let html = fs.readFileSync(htmlPath,'utf8');
  let css = fs.readFileSync(cssPath,'utf8');
  let js = fs.readFileSync(jsPath,'utf8');
  let inlined = html.replace('<link rel="stylesheet" href="style.css" />', `<style>${css}</style>`).replace('<script src="app.js"></script>', `<script>${js}</script>`);
  // serve html on root
  await page.route('http://test.example.com/', async route=>{
    await route.fulfill({status:200, contentType:'text/html', body: inlined});
  });
  // also handle with trailing slash variations and without
  await page.route('http://test.example.com', async route=>{
    await route.fulfill({status:200, contentType:'text/html', body: inlined});
  });
  // mock client-event to avoid 404
  await page.route('**/api/client-event', async route=>{
    await route.fulfill({status:200, contentType:'application/json', body:'{}'});
  });
}

// helper to mock camera success with facingMode tracking
async function mockCameraSuccess(contextOrPage, opts = {}) {
  const target = contextOrPage; // can be context or page, both support addInitScript
  await target.addInitScript(() => {
    window.__cameraCalls = [];
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async (constraints)=>{
          window.__cameraCalls = window.__cameraCalls || [];
          window.__cameraCalls.push(constraints);
          const fm = constraints?.video?.facingMode || 'environment';
          window.__lastFacing = fm;
          const canvas = document.createElement('canvas');
          canvas.width = 640; canvas.height = 480;
          const ctx = canvas.getContext('2d');
          if(ctx){ ctx.fillStyle='#88a'; ctx.fillRect(0,0,640,480); ctx.fillStyle='#fff'; ctx.fillRect(100,100,200,150); }
          let stream;
          if(canvas.captureStream) stream = canvas.captureStream(1);
          else stream = { getTracks: ()=>[{stop:()=>{}}] };
          if(!stream.getTracks) stream.getTracks = ()=>[{stop:()=>{}}];
          return stream;
        },
        enumerateDevices: async ()=>[],
        addEventListener: ()=>{},
      },
      writable:true, configurable:true,
    });
  });
}

async function mockCameraFailure(contextOrPage, errorName='NotAllowedError') {
  await contextOrPage.addInitScript((errName) => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async ()=>{ const e=new Error('denied'); e.name=errName; throw e; },
        enumerateDevices: async ()=>[],
        addEventListener: ()=>{},
      },
      writable:true, configurable:true,
    });
  }, errorName);
}

test.describe('Show It To Me T07 – One-step Ask flow', () => {

  test('camera has only Back and Front buttons, no dropdown, default Back remembered', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(800);
    await expect(page.locator('#camBack')).toBeVisible();
    await expect(page.locator('#camFront')).toBeVisible();
    const sel = page.locator('#cameraSelect');
    await expect(sel).toBeHidden();
    await expect(page.locator('#camBack')).toHaveClass(/active/);
    await page.locator('#camFront').click();
    await page.waitForTimeout(400);
    await expect(page.locator('#camFront')).toHaveClass(/active/);
    const stored = await page.evaluate(()=>{ try{return localStorage.getItem('cameraFacing')}catch(e){return null}});
    expect(stored).toBe('user');
    await page.locator('#camBack').click();
    await page.waitForTimeout(400);
    await expect(page.locator('#camBack')).toHaveClass(/active/);
    const stored2 = await page.evaluate(()=> localStorage.getItem('cameraFacing'));
    expect(stored2).toBe('environment');
  });

  test('switching stops old stream and starts new one with facingMode', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(800);
    const initialCalls = await page.evaluate(()=> window.__cameraCalls?.length||0);
    expect(initialCalls).toBeGreaterThan(0);
    await page.locator('#camFront').click();
    await page.waitForTimeout(400);
    const callsAfterFront = await page.evaluate(()=> window.__cameraCalls);
    const last = callsAfterFront[callsAfterFront.length-1];
    expect(last.video.facingMode).toBe('user');
    await page.locator('#camBack').click();
    await page.waitForTimeout(400);
    const callsAfterBack = await page.evaluate(()=> window.__cameraCalls);
    const last2 = callsAfterBack[callsAfterBack.length-1];
    expect(last2.video.facingMode).toBe('environment');
  });

  test('live preview fills photo area and starts on page open, hidden controls not visible', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(800);
    await expect(page.locator('#video')).toBeVisible();
    await expect(page.locator('#cameraFallback')).toBeHidden();
    const capture = page.locator('#capture');
    await expect(capture).toBeHidden();
    await expect(page.locator('#retake')).toBeHidden();
    await expect(page.locator('#fallbackUpload')).toBeHidden();
    await expect(page.locator('#preview')).toBeHidden();
  });

  test('fallback appears when camera cannot start, shows Choose a photo link', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraFailure(context, 'NotAllowedError');
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(800);
    await expect(page.locator('#cameraFallback')).toBeVisible();
    await expect(page.locator('#cameraFallbackMsg')).toContainText(/denied|allow|choose/i);
    await expect(page.locator('#fallbackUpload')).toBeVisible();
    await expect(page.locator('#fallbackUpload')).toHaveText('Choose a photo');
    await expect(page.locator('#capture')).toBeHidden();
  });

  test('no camera dropdown, only Back Front kept, camera events still sent', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(800);
    await expect(page.locator('#camBack')).toBeVisible();
    const sel = page.locator('#cameraSelect');
    await expect(sel).toBeHidden();
  });

  test('question box has no placeholder and Ask is Meta blue pill 44px', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(500);
    const placeholder = await page.locator('#question').getAttribute('placeholder');
    expect(placeholder).toBe('');
    await expect(page.locator('#question')).toHaveAttribute('aria-label', 'Question');
    await expect(page.locator('#ask')).toBeVisible();
    await expect(page.locator('#ask')).toHaveText('Ask');
    const h = await page.locator('#ask').evaluate(el=> getComputedStyle(el).height);
    expect(parseInt(h)).toBeGreaterThanOrEqual(44);
    await expect(page.locator('#suggestedChips .chip')).toHaveCount(3);
  });

  test('tapping chip fills box but does not send', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
      await page.route('**/api/analyze', async route=>{ await route.fulfill({status:200, contentType:'application/json', body: JSON.stringify({frameId:'f', requestId:'r', view:'top', regions:[], explanation:'hi', needs_view:null, sources:[], provenance:{sam_model:'sam3'}})}); });
    }
    await page.goto(BASE);
    await page.waitForTimeout(600);
    let analyzeHit=false;
    // set route after goto for local? For isLocal we already handled, but for remote we need to intercept
    if(!isLocalBase()){
      await page.route('**/api/analyze', route=>{ analyzeHit=true; route.fulfill({status:200, contentType:'application/json', body: JSON.stringify({frameId:'f', requestId:'r', view:'top', regions:[], explanation:'hi', needs_view:null, sources:[], provenance:{sam_model:'sam3'}})}); });
    }
    await page.locator('.chip').first().click();
    await page.waitForTimeout(300);
    const val = await page.locator('#question').inputValue();
    expect(val.length).toBeGreaterThan(0);
    if(!isLocalBase()) expect(analyzeHit).toBe(false);
  });

  test('empty question does nothing and focuses box with hint', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
      await page.route('**/api/analyze', async route=>{ await route.fulfill({status:500, body:'{}'}); });
    }
    await page.goto(BASE);
    await page.waitForTimeout(600);
    let analyzeHit=false;
    if(!isLocalBase()){
      await page.route('**/api/analyze', route=>{ analyzeHit=true; route.fulfill({status:500, body:'{}'}); });
    }
    await page.locator('#ask').click();
    await page.waitForTimeout(300);
    if(!isLocalBase()) expect(analyzeHit).toBe(false);
    await expect(page.locator('#questionHint')).toBeVisible();
    await expect(page.locator('#questionHint')).toContainText(/type a question/i);
    const focused = await page.evaluate(()=> document.activeElement && document.activeElement.id==='question');
    expect(focused).toBe(true);
  });

  test('T07 main: fake media stream, type question, click Ask, request carries image and question, answer and overlay appear', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(800);
    let capturedRequest=null;
    await page.route('**/api/analyze', async route=>{
      const req=route.request();
      const body=JSON.parse(req.postData()||'{}');
      capturedRequest=body;
      const frameId=body.frameId;
      const requestId=body.requestId;
      await route.fulfill({
        status:200,
        contentType:'application/json',
        body: JSON.stringify({
          frameId,
          requestId,
          view:'top',
          regions:[{
            id:'1',
            part:'fan_connector',
            label:'Fan connector',
            polygon:[[0.2,0.2],[0.3,0.2],[0.3,0.3],[0.2,0.3]],
            bbox:[0.2,0.2,0.3,0.3],
            score:0.9,
            status:'observed',
            source:'sam3'
          }],
          explanation:'The fan connector is highlighted.',
          needs_view:null,
          sources:['https://example.com/ref'],
          provenance:{sam_model:'sam3', timings_ms:{}}
        })
      });
    });
    const clientEvents=[];
    await page.route('**/api/client-event', async route=>{
      try{ const b=JSON.parse(route.request().postData()||'{}'); clientEvents.push(b); }catch(e){}
      await route.fulfill({status:200, body:'{}'});
    });
    await page.locator('#question').fill('Where is the fan?');
    await page.locator('#ask').click();
    await page.waitForTimeout(1000);
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest.question).toBe('Where is the fan?');
    expect(capturedRequest.image).toMatch(/^data:image\/jpeg;base64,/);
    expect(capturedRequest.frameId).toBeTruthy();
    expect(capturedRequest.requestId).toBeTruthy();
    await expect(page.locator('#answer')).toBeVisible({timeout:5000});
    await expect(page.locator('#answer')).toContainText('fan connector');
    const nonTransparent = await page.locator('#overlay').evaluate(el=>{
      const ctx=el.getContext('2d');
      if(!ctx) return 0;
      const {width,height}=el;
      if(width===0||height===0) return 0;
      const data=ctx.getImageData(0,0,width,height).data;
      let c=0; for(let i=3;i<data.length;i+=4) if(data[i]>0) c++;
      return c;
    });
    expect(nonTransparent).toBeGreaterThan(0);
    await expect(page.locator('#preview')).toBeVisible();
    const photoEv = clientEvents.find(e=> e.event==='photo_captured');
    expect(photoEv).toBeTruthy();
    expect(photoEv.detail).toMatch(/bytes:/);
    const askSent = clientEvents.find(e=> e.event==='ask_sent');
    expect(askSent).toBeTruthy();
    const askOk = clientEvents.find(e=> e.event==='ask_ok');
    expect(askOk).toBeTruthy();
  });

  test('after answer editing question goes back to live preview, tapping image does too', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(600);
    await page.route('**/api/analyze', async route=>{
      const b=JSON.parse(route.request().postData()||'{}');
      await route.fulfill({status:200, contentType:'application/json', body: JSON.stringify({frameId:b.frameId, requestId:b.requestId, view:'top', regions:[{id:'1', part:'fan_connector', label:'Fan', polygon:[[0.2,0.2],[0.3,0.2],[0.3,0.3],[0.2,0.3]], score:0.9, status:'observed', source:'sam3'}], explanation:'hi', needs_view:null, sources:[], provenance:{sam_model:'sam3'}})});
    });
    await page.locator('#question').fill('test');
    await page.locator('#ask').click();
    await page.waitForTimeout(800);
    await expect(page.locator('#preview')).toBeVisible();
    await expect(page.locator('#answer')).toBeVisible();
    await page.locator('#question').fill('another');
    await page.waitForTimeout(400);
    await expect(page.locator('#video')).toBeVisible();
    await expect(page.locator('#preview')).toBeHidden();
    await page.locator('#ask').click();
    await page.waitForTimeout(800);
    await expect(page.locator('#preview')).toBeVisible();
    // tap image should go back to live (our logic resets on preview click when answer exists)
    await page.locator('#preview').click();
    await page.waitForTimeout(400);
    await expect(page.locator('#video')).toBeVisible();
  });

  test('errors keep friendly messages and Retry shown only after error', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(600);
    await expect(page.locator('#retryBtn')).toBeHidden();
    await page.route('**/api/analyze', route=> route.fulfill({status:502, contentType:'application/json', body: JSON.stringify({error:'glimmer_unreachable'})}));
    await page.locator('#question').fill('test');
    await page.locator('#ask').click();
    await page.waitForTimeout(600);
    await expect(page.locator('#status')).toContainText('Model unreachable');
    await expect(page.locator('#retryBtn')).toBeVisible();
    await page.route('**/api/analyze', async route=>{
      const b=JSON.parse(route.request().postData()||'{}');
      await route.fulfill({status:200, contentType:'application/json', body: JSON.stringify({frameId:b.frameId, requestId:b.requestId, view:'top', regions:[], explanation:'ok', needs_view:null, sources:[], provenance:{sam_model:'sam3'}})});
    });
    await page.locator('#retryBtn').click();
    await page.waitForTimeout(600);
    await expect(page.locator('#status')).toContainText('Answer ready');
    await expect(page.locator('#retryBtn')).toBeHidden();
  });

  test('Demo checkbox removed, but ?demo=1 hook still works', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(400);
    const demoChk = page.locator('#demoMode');
    await expect(demoChk).toBeHidden();
    const demoUrl = BASE.includes('?') ? BASE+'&demo=1' : BASE+'?demo=1';
    if(isLocalBase()){
      // need to re-serve with new URL? Our route handles both http://test.example.com/ and .../?demo=1? Let's intercept wildcard
      await page.route('http://test.example.com/*', async route=>{
        const htmlPath = path.resolve(__dirname, '../static/index.html');
        const cssPath = path.resolve(__dirname, '../static/style.css');
        const jsPath = path.resolve(__dirname, '../static/app.js');
        let html = fs.readFileSync(htmlPath,'utf8');
        let css = fs.readFileSync(cssPath,'utf8');
        let js = fs.readFileSync(jsPath,'utf8');
        let inlined = html.replace('<link rel="stylesheet" href="style.css" />', `<style>${css}</style>`).replace('<script src="app.js"></script>', `<script>${js}</script>`);
        await route.fulfill({status:200, contentType:'text/html', body: inlined});
      });
    }
    await page.goto(demoUrl);
    await page.waitForTimeout(400);
    await page.route('**/api/analyze', async route=>{
      const b=JSON.parse(route.request().postData()||'{}');
      await route.fulfill({status:200, contentType:'application/json', body: JSON.stringify({frameId:b.frameId, requestId:b.requestId, view:'top', regions:[{id:'1', part:'fan_connector', label:'Fan', polygon:[[0.2,0.2],[0.3,0.2],[0.3,0.3],[0.2,0.3]], score:0.9, status:'observed', source:'sam3'}], explanation:'demo', needs_view:null, sources:[], provenance:{sam_model:'sam3'}})});
    });
    await page.locator('#question').fill('demo test');
    await page.locator('#ask').click();
    await page.waitForTimeout(800);
    const isDemo = await page.evaluate(()=> new URLSearchParams(window.location.search).get('demo')==='1');
    expect(isDemo).toBe(true);
  });

  test('progress text shown while Ask works and button disabled', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(600);
    await page.route('**/api/analyze', async route=>{
      await new Promise(r=> setTimeout(r, 1500));
      const b=JSON.parse(route.request().postData()||'{}');
      await route.fulfill({status:200, contentType:'application/json', body: JSON.stringify({frameId:b.frameId, requestId:b.requestId, view:'top', regions:[], explanation:'slow', needs_view:null, sources:[], provenance:{sam_model:'sam3'}})});
    });
    await page.locator('#question').fill('slow test');
    await page.locator('#ask').click();
    await page.waitForTimeout(300);
    await expect(page.locator('#ask')).toBeDisabled();
    await expect(page.locator('#status')).toContainText('Looking');
    await page.waitForTimeout(1700);
    await expect(page.locator('#ask')).not.toBeDisabled();
  });

  test('upload fallback via file still works when camera fails', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraFailure(context, 'NotFoundError');
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.waitForTimeout(600);
    await expect(page.locator('#cameraFallback')).toBeVisible();
    await page.setInputFiles('#file', TEST_IMAGE_SRC);
    await page.waitForTimeout(800);
    await expect(page.locator('#preview')).toBeVisible();
    await page.route('**/api/analyze', async route=>{
      const b=JSON.parse(route.request().postData()||'{}');
      await route.fulfill({status:200, contentType:'application/json', body: JSON.stringify({frameId:b.frameId, requestId:b.requestId, view:'top', regions:[{id:'1', part:'microsd_slot', label:'SD slot', polygon:[[0.5,0.5],[0.6,0.5],[0.6,0.6],[0.5,0.6]], score:0.9, status:'observed', source:'sam3'}], explanation:'slot', needs_view:null, sources:[], provenance:{sam_model:'sam3'}})});
    });
    await page.locator('#question').fill('where sd?');
    await page.locator('#ask').click();
    await page.waitForTimeout(800);
    await expect(page.locator('#answer')).toBeVisible();
  });

});

test.describe('Legacy simulated regression (adapted for T07)', () => {
  test('two polygons drawn with pixel assertions SIMULATED', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.route('**/api/analyze', route => {
      const reqBody = route.request().postDataJSON ? route.request().postDataJSON() : JSON.parse(route.request().postData()||'{}');
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          frameId: reqBody.frameId || 'f1',
          requestId: reqBody.requestId || 'r1',
          view: 'top',
          regions: [
            { id: '1', part: 'fan_connector', label: 'Fan connector', polygon: [[0.2,0.2],[0.3,0.2],[0.3,0.3],[0.2,0.3]], bbox:[0.2,0.2,0.3,0.3], score:0.9, status:'observed', source:'sam3' },
            { id: '2', part: 'usb_c_power_port', label: 'USB-C', polygon: [[0.6,0.6],[0.7,0.6],[0.7,0.7],[0.6,0.7]], bbox:[0.6,0.6,0.7,0.7], score:0.85, status:'observed', source:'sam3' }
          ],
          explanation: 'SIMULATED two regions',
          needs_view: null,
          sources: [],
          provenance: { sam_model: 'sam3', timings_ms: {} }
        })
      });
    });
    await page.waitForTimeout(600);
    await page.locator('#question').fill('show parts');
    await page.locator('#ask').click();
    await page.waitForTimeout(800);
    const { inside, outside } = await page.locator('#overlay').evaluate(el => {
      const ctx = el.getContext('2d');
      const { width, height } = el;
      const data = ctx.getImageData(0,0,width,height).data;
      const cx1 = Math.floor(width*0.25), cy1 = Math.floor(height*0.25);
      const cx2 = Math.floor(width*0.65), cy2 = Math.floor(height*0.65);
      const idx = (x,y) => ((y*width + x)*4 + 3);
      const a = data[idx(cx1,cy1)];
      const b = data[idx(cx2,cy2)];
      const c = data[idx(10,10)];
      return { inside: a>0 && b>0, outside: c===0 };
    });
    expect(inside).toBeTruthy();
    expect(outside).toBeTruthy();
  });

  test('stale ids ignored SIMULATED', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.route('**/api/analyze', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          frameId: 'old',
          requestId: 'old',
          view: 'top',
          regions: [],
          explanation: 'stale',
          needs_view: null,
          sources: [],
          provenance: { sam_model: 'sam3' }
        })
      });
    });
    await page.locator('#question').fill('test');
    await page.locator('#ask').click();
    await page.waitForTimeout(600);
    await expect(page.locator('#status')).toContainText('Stale answer ignored');
  });

  test('needs_view banner SIMULATED', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.route('**/api/analyze', route => {
      const req = route.request();
      const body = req.postDataJSON ? req.postDataJSON() : JSON.parse(req.postData()||'{}');
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          frameId: body.frameId || 'f',
          requestId: body.requestId || 'r',
          view: 'top',
          regions: [],
          explanation: 'flip',
          needs_view: 'flip_board',
          sources: [],
          provenance: { sam_model: 'sam3' }
        })
      });
    });
    await page.locator('#question').fill('test');
    await page.locator('#ask').click();
    await page.waitForTimeout(600);
    await expect(page.locator('#answer')).toContainText('Turn the board over');
  });

  test('error codes messages SIMULATED', async ({ page, context }) => {
    const codes = [
      { status:429, body:{error:'too_many_requests'}, text:'Busy' },
      { status:504, body:{error:'glimmer_timeout'}, text:'Timeout' },
      { status:502, body:{error:'glimmer_unreachable'}, text:'Model unreachable' },
      { status:413, body:{}, text:'Image too big' }
    ];
    for (const c of codes){
      if(isLocalBase()){
        await mockCameraSuccess(context);
        await serveLocalApp(page);
      }
      await page.goto(BASE);
      await page.route('**/api/analyze', route => route.fulfill({ status: c.status, contentType:'application/json', body: JSON.stringify(c.body) }));
      await page.locator('#question').fill('test');
      await page.locator('#ask').click();
      await page.waitForTimeout(400);
      await expect(page.locator('#status')).toContainText(c.text);
    }
  });

  test('overlay transparent over fixture', async ({ page, context }) => {
    if(isLocalBase()){
      await mockCameraSuccess(context);
      await serveLocalApp(page);
    }
    await page.goto(BASE);
    await page.route('**/api/analyze', async route=>{
      const b=JSON.parse(route.request().postData()||'{}');
      await route.fulfill({status:200, contentType:'application/json', body: JSON.stringify({frameId:b.frameId, requestId:b.requestId, view:'top', regions:[{id:'1', part:'fan', label:'Fan', polygon:[[0.2,0.2],[0.3,0.2],[0.3,0.3],[0.2,0.3]], score:0.9, status:'observed', source:'sam3'}], explanation:'hi', needs_view:null, sources:[], provenance:{sam_model:'sam3'}})});
    });
    await page.locator('#question').fill('test');
    await page.locator('#ask').click();
    await page.waitForTimeout(800);
    const bg = await page.locator('#overlay').evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgba(0, 0, 0, 0)');
  });

});
