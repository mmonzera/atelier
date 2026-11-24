import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  QaFailedRequest,
  QaRun,
  QaScreenshot,
  QaStepInput,
  QaStepResult,
} from '@atelier/contracts';
import { chromium } from 'playwright-core';

export interface DetectedBrowser {
  executablePath: string;
  browserName: string;
}

export function detectLocalBrowser(): DetectedBrowser | null {
  const custom = process.env.ATELIER_BROWSER_PATH?.trim();
  if (custom && fs.existsSync(custom)) {
    return { executablePath: path.resolve(custom), browserName: path.basename(custom) };
  }

  const candidates: Array<{ path: string; name: string }> = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', name: 'Google Chrome' },
      {
        path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        name: 'Google Chrome',
      },
      {
        path: path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        name: 'Google Chrome',
      },
      {
        path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        name: 'Microsoft Edge',
      },
      {
        path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        name: 'Microsoft Edge',
      },
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      {
        path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        name: 'Google Chrome',
      },
      {
        path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        name: 'Microsoft Edge',
      },
      {
        path: '/Applications/Chromium.app/Contents/MacOS/Chromium',
        name: 'Chromium',
      },
    );
  } else {
    candidates.push(
      { path: '/usr/bin/google-chrome', name: 'Google Chrome' },
      { path: '/usr/bin/microsoft-edge', name: 'Microsoft Edge' },
      { path: '/usr/bin/chromium', name: 'Chromium' },
      { path: '/usr/bin/chromium-browser', name: 'Chromium' },
    );
  }

  for (const cand of candidates) {
    if (fs.existsSync(cand.path)) {
      return { executablePath: cand.path, browserName: cand.name };
    }
  }
  return null;
}

export function validateQaUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid QA target URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol "${parsed.protocol}". Only http/https URLs are allowed.`);
  }
  return parsed.toString();
}

export function resolveQaArtifactPath(
  dataDir: string,
  runId: string,
  filename: string,
): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId) || !/^[a-zA-Z0-9_.-]+\.png$/.test(filename)) {
    return null;
  }
  const root = path.resolve(dataDir, 'qa-artifacts');
  const resolved = path.resolve(root, runId, filename);
  if (!resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

export async function runBrowserQa(opts: {
  dataDir: string;
  projectId: string;
  url: string;
  watchLive?: boolean;
  taskId?: string | null;
  agentId?: string | null;
  steps?: QaStepInput[];
}): Promise<QaRun> {
  const targetUrl = validateQaUrl(opts.url);
  const watchLive = Boolean(opts.watchLive);
  const browserInfo = detectLocalBrowser();
  if (!browserInfo) {
    throw new Error(
      'No Chrome/Edge browser found on this machine. Install Chrome or Edge, or set ATELIER_BROWSER_PATH.',
    );
  }

  const runId = `qa_${crypto.randomUUID().slice(0, 10)}`;
  const artifactDir = path.resolve(opts.dataDir, 'qa-artifacts', runId);
  fs.mkdirSync(artifactDir, { recursive: true });

  const startedAt = Date.now();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: QaFailedRequest[] = [];
  const steps: QaStepResult[] = [];
  const screenshots: QaScreenshot[] = [];

  const saveScreenshot = async (
    page: import('playwright-core').Page,
    filename: string,
    label: string,
  ): Promise<string> => {
    const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const outFile = path.join(artifactDir, safeName);
    await page.screenshot({ path: outFile, fullPage: false });
    const url = `/api/qa/artifacts/${runId}/${safeName}`;
    screenshots.push({ label, url });
    return url;
  };

  const browser = await chromium.launch({
    executablePath: browserInfo.executablePath,
    headless: !watchLive,
    slowMo: watchLive ? 180 : 0,
    args: ['--no-sandbox'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error' && consoleErrors.length < 30) {
        consoleErrors.push(msg.text().slice(0, 400));
      }
    });
    page.on('pageerror', (err) => {
      if (pageErrors.length < 20) {
        pageErrors.push((err instanceof Error ? err.message : String(err)).slice(0, 400));
      }
    });
    page.on('response', (res) => {
      if (res.status() >= 400 && failedRequests.length < 30) {
        failedRequests.push({
          url: res.url().slice(0, 240),
          method: res.request().method(),
          status: res.status(),
        });
      }
    });

    // Step 0: always navigate and verify render
    const navStart = Date.now();
    try {
      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      await page.waitForLoadState('networkidle', { timeout: 3500 }).catch(() => undefined);

      const status = response?.status() ?? 200;
      const bodyState = await page.evaluate(() => {
        const textLen = document.body?.innerText?.trim().length ?? 0;
        const htmlLen = document.body?.innerHTML?.trim().length ?? 0;
        return { textLen, htmlLen };
      });
      if (status >= 400) {
        throw new Error(`HTTP ${status} returned when loading ${targetUrl}`);
      }
      if (bodyState.htmlLen === 0) {
        throw new Error('Page rendered an empty <body>');
      }

      steps.push({
        index: 0,
        action: 'goto',
        label: `Load ${targetUrl}`,
        ok: true,
        durationMs: Math.max(1, Date.now() - navStart),
      });
    } catch (err) {
      steps.push({
        index: 0,
        action: 'goto',
        label: `Load ${targetUrl}`,
        ok: false,
        durationMs: Math.max(1, Date.now() - navStart),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Custom E2E steps
    const customSteps = opts.steps ?? [];
    for (let i = 0; i < customSteps.length; i += 1) {
      const s = customSteps[i];
      const stepIndex = i + 1;
      const stepStart = Date.now();
      const timeout = Math.min(30_000, Math.max(500, s.timeoutMs ?? 8000));
      const label =
        s.label?.trim() ||
        `${s.action}${s.selector ? ` ${s.selector}` : ''}${s.value ? ` "${s.value}"` : ''}`;

      try {
        switch (s.action) {
          case 'goto': {
            const dest = validateQaUrl(s.value || targetUrl);
            await page.goto(dest, { waitUntil: 'domcontentloaded', timeout });
            break;
          }
          case 'wait': {
            const ms = Math.min(15_000, Math.max(50, Number(s.value) || 500));
            await page.waitForTimeout(ms);
            break;
          }
          case 'click': {
            if (!s.selector) throw new Error('click step requires selector');
            await page.locator(s.selector).first().click({ timeout });
            break;
          }
          case 'fill': {
            if (!s.selector) throw new Error('fill step requires selector');
            await page.locator(s.selector).first().fill(s.value ?? '', { timeout });
            break;
          }
          case 'press': {
            if (!s.selector) throw new Error('press step requires selector');
            await page.locator(s.selector).first().press(s.value || 'Enter', { timeout });
            break;
          }
          case 'assertVisible': {
            if (!s.selector) throw new Error('assertVisible step requires selector');
            await page.locator(s.selector).first().waitFor({ state: 'visible', timeout });
            break;
          }
          case 'assertText': {
            const expected = s.value ?? '';
            if (s.selector) {
              const loc = page.locator(s.selector).first();
              await loc.waitFor({ state: 'visible', timeout });
              const actual = (await loc.innerText({ timeout })).trim();
              if (!actual.includes(expected)) {
                throw new Error(
                  `Expected "${expected}" inside ${s.selector}, got "${actual.slice(0, 120)}"`,
                );
              }
            } else {
              const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
              if (!bodyText.includes(expected)) {
                throw new Error(`Expected text "${expected}" on page`);
              }
            }
            break;
          }
          case 'screenshot': {
            const shotUrl = await saveScreenshot(
              page,
              `step-${stepIndex}.png`,
              s.label || `Step ${stepIndex}`,
            );
            steps.push({
              index: stepIndex,
              action: s.action,
              label,
              ok: true,
              durationMs: Math.max(1, Date.now() - stepStart),
              screenshotUrl: shotUrl,
            });
            continue;
          }
        }

        steps.push({
          index: stepIndex,
          action: s.action,
          label,
          ok: true,
          durationMs: Math.max(1, Date.now() - stepStart),
        });
      } catch (err) {
        steps.push({
          index: stepIndex,
          action: s.action,
          label,
          ok: false,
          durationMs: Math.max(1, Date.now() - stepStart),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Always capture desktop & mobile viewport verification screenshots unless custom screenshots already exist
    await saveScreenshot(page, 'desktop.png', 'Desktop (1280x800)');
    if (customSteps.every((s) => s.action !== 'screenshot')) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(150);
      await saveScreenshot(page, 'mobile.png', 'Mobile (390x844)');
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const failedSteps = steps.filter((s) => !s.ok).length;
  const passed =
    failedSteps === 0 &&
    pageErrors.length === 0 &&
    consoleErrors.length === 0 &&
    failedRequests.length === 0;

  const passedSteps = steps.length - failedSteps;
  const summary = passed
    ? `Passed · ${passedSteps}/${steps.length} steps, 0 console errors, 0 failed requests`
    : `Failed · ${passedSteps}/${steps.length} steps, ${consoleErrors.length + pageErrors.length} console/page errors, ${failedRequests.length} failed requests`;

  return {
    id: runId,
    projectId: opts.projectId,
    taskId: opts.taskId ?? null,
    agentId: opts.agentId ?? null,
    url: targetUrl,
    watchLive,
    passed,
    summary,
    durationMs: Math.max(1, Date.now() - startedAt),
    browserName: browserInfo.browserName,
    steps,
    consoleErrors,
    pageErrors,
    failedRequests,
    screenshots,
    createdAt: new Date().toISOString(),
  };
}
