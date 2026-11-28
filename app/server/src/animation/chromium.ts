import { chromium } from 'playwright-core';
import type { Browser, BrowserContext } from 'playwright-core';
import { EngineError } from '../engine.ts';

const HARD_FRAME_TIMEOUT = 15_000;
const LAUNCH_TIMEOUT = 9_000;

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-wander-render'; base-uri 'none'; form-action 'none'; frame-src 'none'">
<style nonce="wander-render">html,body,img{display:block;width:100%;height:100%;margin:0;overflow:hidden;background:#000}img{object-fit:contain}</style>
</head><body><img id="scene" alt=""></body></html>`;

function stopped(): EngineError { return new EngineError('CANCELLED', 'Animated SVG render cancelled or timed out.'); }

async function bounded<T>(work: () => Promise<T>, signal: AbortSignal, timeout: number, why: string): Promise<T> {
  const local = AbortSignal.timeout(timeout);
  const combined = AbortSignal.any([signal, local]);
  if (signal.aborted) throw stopped();
  let stop: () => void = () => {};
  const interruption = new Promise<never>((_, reject) => {
    stop = () => reject(signal.aborted ? stopped() : new EngineError('ANIMATION_RENDER_FAILED', why));
    combined.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([work(), interruption]); }
  finally { combined.removeEventListener('abort', stop); }
}

function browserEnvironment(): Record<string, string> {
  const allowed = /^(?:PATH|TMP|TEMP|TMPDIR|SYSTEMROOT|WINDIR|USERPROFILE|LOCALAPPDATA|HOME|LANG|LC_ALL|LD_LIBRARY_PATH)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.test(key) && typeof value === 'string')) as Record<string, string>;
}

export interface ChromiumRasterizer {
  capture: (validatedSvg: string) => Promise<Buffer>;
  close: () => Promise<void>;
}

/**
 * A single browser, fresh incognito context and single fixed page per job.
 * Only decoded images are shown. No SVG code, provider content, or script is inserted into the document.
 */
export async function createChromiumRasterizer(options: {
  width: number; height: number; executablePath?: string; signal: AbortSignal;
}): Promise<ChromiumRasterizer> {
  const { width, height, signal } = options;
  if (signal.aborted) throw stopped();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      signal.removeEventListener('abort', onAbort);
      closePromise = (async () => {
        try {
          if (context) await context.close();
        } catch { /* May already be closed or disconnected. */ }
        finally { await browser?.close().catch(() => undefined); }
      })();
    }
    return closePromise;
  };
  const onAbort = () => { void close(); };
  try {
    // Launch completion is bounded, even if cancelled before a browser handle exists.
    browser = await chromium.launch({
      executablePath: options.executablePath, headless: true, chromiumSandbox: true, timeout: LAUNCH_TIMEOUT,
      env: browserEnvironment(),
      args: ['--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) throw stopped();
    context = await bounded(() => browser!.newContext({
      viewport: { width, height }, deviceScaleFactor: 1, offline: true, serviceWorkers: 'block',
      acceptDownloads: false, reducedMotion: 'reduce', javaScriptEnabled: false,
    }), signal, HARD_FRAME_TIMEOUT, 'Chromium could not start the isolated capture context.');
    await context.route('**/*', (route) => route.abort('blockedbyclient'));
    await context.routeWebSocket('**/*', (ws) => ws.close());
    const page = await context.newPage();
    await page.setContent(HTML, { waitUntil: 'load', timeout: HARD_FRAME_TIMEOUT });
    return {
      capture: async (validatedSvg) => {
        const src = `data:image/svg+xml;base64,${Buffer.from(validatedSvg, 'utf8').toString('base64')}`;
        return bounded(async () => {
          // Playwright's trusted debugging evaluation is allowed even though page JavaScript is disabled.
          await page.evaluate(async (input) => {
            const img = document.querySelector<HTMLImageElement>('#scene');
            if (!img) throw new Error('Capture element missing');
            img.src = input;
            await img.decode();
          }, src);
          return page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', timeout: HARD_FRAME_TIMEOUT });
        }, signal, HARD_FRAME_TIMEOUT, 'Chromium exceeded the per-frame capture time limit.');
      },
      close,
    };
  } catch (err) {
    await close();
    if (signal.aborted) throw stopped();
    throw new EngineError('ANIMATION_CHROMIUM_UNAVAILABLE',
      'Playwright Chromium could not start with its sandbox. Install the bundled Chromium using Playwright, or configure an available sandboxed Chromium; the librsvg backend is an alternative.',
      String(err).split('\n').slice(0, 4).join('\n'));
  }
}
