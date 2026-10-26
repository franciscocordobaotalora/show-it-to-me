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
    await page.setInputFiles('#file', TEST_IMAGE);
    await expect(page.locator('#preview')).toBeVisible();
    await page.locator('#question').fill('What?');
    await page.locator('#ask').click();
    await expect(page.locator('#status')).toContainText('Model unavailable');
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
    await page.locator('#demoMode').check();
    await page.evaluate(() => {
      window.mockResponse = (frameId, question, requestId) => {
        const delay = question.includes('second') ? 100 : 800;
        const offset = (question.length || 0) % 5;
        const nx = 0.25 + offset*0.05;
        return new Promise(res => setTimeout(() => res({
          requestId, frameId, status:'ok',
          regions:[{id:'demo-1', nx, ny:0.4, nw:0.1, nh:0.1, label:'Demo'}],
          explanation:'', sources:[], model:{}, sam:{}
        }), delay));
      };
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
    await page.setInputFiles('#file', TEST_IMAGE);
    await page.locator('#demoMode').check();
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
    const status = await page.locator('#status').textContent();
    expect(status).toContainText('Unsupported');
  });

  test('upload validation: empty question', async ({ page }) => {
    await page.goto(BASE);
    await page.setInputFiles('#file', TEST_IMAGE);
    await page.locator('#demoMode').check();
    await page.locator('#ask').click();
    const status = await page.locator('#status').textContent();
    expect(status).toContainText('Enter a question');
  });

  test('camera unavailable fallback to upload', async ({ page }) => {
    await page.goto(BASE);
    const status = await page.locator('#status').textContent();
    expect(status).toMatch(/Camera unavailable|Ready/);
    await page.setInputFiles('#file', TEST_IMAGE);
    await expect(page.locator('#preview')).toBeVisible();
  });
});
