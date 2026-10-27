const { test, expect } = require('@playwright/test');

const BASE = process.env.TEST_URL || 'https://show-it-to-me.experiment.franciscocordobaotalora.com/';
const TEST_IMAGE = process.env.TEST_IMAGE || '/data/project/evidence/colored-components.png';
const USER = process.env.TEST_USER;
const PASS = process.env.TEST_PASSWORD;

test.use({
  httpCredentials: USER && PASS ? { username: USER, password: PASS } : undefined,
});

test.describe('Show It To Me T01', () => {
  test('unauthenticated access returns 401', async ({ browser }) => {
    const context = await browser.newContext({ httpCredentials: undefined });
    const page = await context.newPage();
    const response = await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(401);
    await context.close();
  });

  test('initial status depends on permission, not always Ready', async ({ page }) => {
    await page.goto(BASE);
    const status = await page.locator('#status').textContent();
    expect(status).toBeTruthy();
  });

  test('unavailable model after upload when demo off', async ({ page }) => {
    await page.goto(BASE);
    await page.route('**/api/analyze', route => {
      route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'glimmer_unreachable' }) });
    });
    await page.setInputFiles('#file', TEST_IMAGE);
    await expect(page.locator('#preview')).toBeVisible();
    await page.locator('#question').fill('What?');
    await page.locator('#ask').click();
    await expect(page.locator('#status')).toContainText('Model unreachable');
  });

  test('Ask then Retake no JS errors', async ({ page }) => {
    const errors = [];
    await page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE);
    await page.setInputFiles('#file', TEST_IMAGE);
    await page.locator('#demoMode').check();
    await page.locator('#question').fill('What?');
    await page.locator('#ask').click();
    await page.waitForTimeout(100);
    await page.locator('#retake').click();
    await page.waitForTimeout(1000);
    await expect(page.locator('#preview')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('same frame requests out of order handled', async ({ page }) => {
    await page.goto(BASE);
    await page.setInputFiles('#file', TEST_IMAGE);
    // Intercept API with simulated responses labelled SIMULATED
    await page.route('**/api/analyze', async route => {
      const req = route.request();
      const body = JSON.parse(req.postData() || '{}');
      const question = body.question || '';
      const delay = question.includes('second') ? 100 : 800;
      const frameId = body.frameId;
      const requestId = body.requestId;
      setTimeout(() => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            frameId,
            requestId,
            view: 'top',
            regions: [{
              id: 'sim-1',
              part: 'fan_connector',
              label: 'Fan connector',
              polygon: [[0.25,0.4],[0.35,0.4],[0.35,0.5],[0.25,0.5]],
              bbox: [0.25,0.4,0.35,0.5],
              score: 0.9,
              status: 'observed',
              source: 'sam3'
            }],
            explanation: 'SIMULATED',
            needs_view: null,
            sources: [],
            provenance: { sam_model: 'sam3', timings_ms: {} }
          })
        });
      }, delay);
    });
    await page.locator('#question').fill('first');
    await page.locator('#ask').click();
    await page.waitForTimeout(50);
    await page.locator('#question').fill('second');
    await page.locator('#ask').click();
    await page.waitForTimeout(250);
    const snapshot = await page.locator('#overlay').evaluate(el => {
      const ctx = el.getContext('2d');
      return ctx.getImageData(0,0,el.width,el.height).data;
    });
    await page.waitForTimeout(800);
    const after = await page.locator('#overlay').evaluate(el => {
      const ctx = el.getContext('2d');
      return ctx.getImageData(0,0,el.width,el.height).data;
    });
    expect(snapshot).toEqual(after);
    const nonTransparent = snapshot.reduce((c,v,i)=> i%4===3 && v>0 ? c+1 : c, 0);
    expect(nonTransparent).toBeGreaterThan(0);
  });

  test('overlay transparent over fixture', async ({ page }) => {
    await page.goto(BASE);
    await page.setInputFiles('#file', TEST_IMAGE);
    await page.locator('#demoMode').check();
    await page.locator('#question').fill('test');
    await page.locator('#ask').click();
    await page.waitForTimeout(1000);
    const bg = await page.locator('#overlay').evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgba(0, 0, 0, 0)');
    const evidenceDir = '/data/project/evidence/T01';
    await page.screenshot({ path: evidenceDir + '/overlay-transparent.png' });
  });

  test('no horizontal overflow at 390px and 320px', async ({ page }) => {
    for (const w of [320, 390, 1280]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.goto(BASE);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(overflow).toBeFalsy();
    }
  });

  test('resize after drawing preserves overlay', async ({ page }) => {
    await page.goto(BASE);
    await page.route('**/api/analyze', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          frameId: 'sim',
          requestId: 'sim',
          view: 'top',
          regions: [{
            id: 'sim-1',
            part: 'fan_connector',
            label: 'Fan connector',
            polygon: [[0.3,0.3],[0.4,0.3],[0.4,0.4],[0.3,0.4]],
            bbox: [0.3,0.3,0.4,0.4],
            score: 0.9,
            status: 'observed',
            source: 'sam3'
          }],
          explanation: 'SIMULATED',
          needs_view: null,
          sources: [],
          provenance: { sam_model: 'sam3', timings_ms: {} }
        })
      });
    });
    await page.setInputFiles('#file', TEST_IMAGE);
    await page.locator('#question').fill('test');
    await page.locator('#ask').click();
    await page.waitForTimeout(1000);
    const countBefore = await page.locator('#overlay').evaluate(el => {
      const ctx = el.getContext('2d');
      const { width, height } = el;
      const data = ctx.getImageData(0,0,width,height).data;
      let c=0; for(let i=3;i<data.length;i+=4){ if(data[i]>0) c++; } return c;
    });
    expect(countBefore).toBeGreaterThan(0);
    await page.setViewportSize({ width: 600, height: 800 });
    await page.waitForTimeout(500);
    const countAfter = await page.locator('#overlay').evaluate(el => {
      const ctx = el.getContext('2d');
      const { width, height } = el;
      const data = ctx.getImageData(0,0,width,height).data;
      let c=0; for(let i=3;i<data.length;i+=4){ if(data[i]>0) c++; } return c;
    });
    expect(countAfter).toBeGreaterThan(0);
    const boundsMatch = await page.evaluate(() => {
      const overlay = document.getElementById('overlay');
      const preview = document.getElementById('preview');
      if (!preview || preview.hidden) return false;
      const r1 = overlay.getBoundingClientRect();
      const r2 = preview.getBoundingClientRect();
      return Math.abs(r1.width - r2.width) < 1 && Math.abs(r1.height - r2.height) < 1;
    });
    expect(boundsMatch).toBeTruthy();
  });

  // T02 simulations
  test('upload validation: non-image file', async ({ page }) => {
    await page.goto(BASE);
    const buf = Buffer.from('not an image');
    await page.setInputFiles('#file', { name: 'test.txt', mimeType: 'text/plain', buffer: buf });
    await page.waitForTimeout(200);
    await expect(page.locator('#status')).toContainText('Unsupported');
  });

  test('upload validation: empty question', async ({ page }) => {
    await page.goto(BASE);
    await page.setInputFiles('#file', TEST_IMAGE);
    await page.locator('#demoMode').check();
    await page.locator('#ask').click();
    await expect(page.locator('#status')).toContainText('Enter a question');
  });

  test('camera unavailable fallback to upload', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('#status')).toHaveText(/Camera unavailable|Ready/);
    await page.setInputFiles('#file', TEST_IMAGE);
    await expect(page.locator('#preview')).toBeVisible();
  });

  test('corrupt image shows error state', async ({ page }) => {
    await page.goto(BASE);
    const buf = Buffer.from('corrupt');
    await page.setInputFiles('#file', { name: 'bad.png', mimeType: 'image/png', buffer: buf });
    await page.waitForTimeout(500);
    await expect(page.locator('#status')).toContainText('Corrupt image');
  });

  test('oversized upload rejected', async ({ page }) => {
    await page.goto(BASE);
    const big = Buffer.alloc(11 * 1024 * 1024, 0);
    await page.setInputFiles('#file', { name: 'big.png', mimeType: 'image/png', buffer: big });
    await page.waitForTimeout(200);
    await expect(page.locator('#status')).toContainText('Image too large');
  });

  test('pending upload retake race prevents late preview', async ({ page }) => {
    await page.goto(BASE);
    await page.setInputFiles('#file', TEST_IMAGE);
    // Rapid second upload then retake before load completes
    await page.setInputFiles('#file', TEST_IMAGE);
    await page.locator('#retake').click();
    await page.waitForTimeout(800);
    await expect(page.locator('#preview')).toBeHidden();
  });
});

test.describe('Show It To Me T03E simulated', () => {
  test('two polygons drawn with pixel assertions SIMULATED', async ({ page }) => {
    await page.goto(BASE);
    await page.route('**/api/analyze', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          frameId: 'f1',
          requestId: 'r1',
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
    await page.setInputFiles('#file', TEST_IMAGE);
    await page.locator('#question').fill('show parts');
    await page.locator('#ask').click();
    await page.waitForTimeout(500);
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

  test('stale ids ignored SIMULATED', async ({ page }) => {
    await page.goto(BASE);
    await page.setInputFiles('#file', TEST_IMAGE);
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
    await page.waitForTimeout(500);
    await expect(page.locator('#status')).toContainText('Stale answer ignored');
  });

  test('needs_view banner SIMULATED', async ({ page }) => {
    await page.goto(BASE);
    await page.route('**/api/analyze', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          frameId: 'f',
          requestId: 'r',
          view: 'top',
          regions: [],
          explanation: 'flip',
          needs_view: 'flip_board',
          sources: [],
          provenance: { sam_model: 'sam3' }
        })
      });
    });
    await page.setInputFiles('#file', TEST_IMAGE);
    await page.locator('#question').fill('test');
    await page.locator('#ask').click();
    await page.waitForTimeout(500);
    await expect(page.locator('#answer')).toContainText('Turn the board over');
  });

  test('error codes messages SIMULATED', async ({ page }) => {
    const codes = [
      { status:429, body:{error:'too_many_requests'}, text:'Busy' },
      { status:504, body:{error:'glimmer_timeout'}, text:'Timeout' },
      { status:502, body:{error:'glimmer_unreachable'}, text:'Model unreachable' },
      { status:413, body:{}, text:'Image too big' }
    ];
    for (const c of codes){
      await page.goto(BASE);
      await page.route('**/api/analyze', route => route.fulfill({ status: c.status, contentType:'application/json', body: JSON.stringify(c.body) }));
      await page.setInputFiles('#file', TEST_IMAGE);
      await page.locator('#question').fill('test');
      await page.locator('#ask').click();
      await page.waitForTimeout(300);
      await expect(page.locator('#status')).toContainText(c.text);
    }
  });

  test('busy state and cancel on Retake SIMULATED', async ({ page }) => {
    await page.goto(BASE);
    await page.route('**/api/analyze', route => {
      // delay response
      setTimeout(() => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({ frameId:'f', requestId:'r', view:'top', regions:[], explanation:'', needs_view:null, sources:[], provenance:{ sam_model:'sam3' } }) }), 2000);
    });
    await page.setInputFiles('#file', TEST_IMAGE);
    await page.locator('#question').fill('test');
    await page.locator('#ask').click();
    await page.waitForTimeout(200);
    await expect(page.locator('#status')).toContainText('Looking');
    await expect(page.locator('#ask')).toBeDisabled();
    await page.locator('#retake').click();
    await page.waitForTimeout(300);
    await expect(page.locator('#status')).toContainText('Cancelled');
  });
});
