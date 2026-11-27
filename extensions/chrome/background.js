const STORAGE_KEY = 'atelierBridgeConfig';
const KEEPALIVE_ALARM = 'atelier-bridge-keepalive';

let ws = null;
let reconnectTimer = null;
let reconnectDelayMs = 1500;
let lastError = null;
let intentionalClose = false;

async function loadConfig() {
  const res = await chrome.storage.local.get(STORAGE_KEY);
  const cfg = res[STORAGE_KEY];
  if (!cfg || typeof cfg !== 'object') {
    return { port: 8787, token: null };
  }
  return {
    port: Number.isFinite(Number(cfg.port)) && Number(cfg.port) > 0 ? Number(cfg.port) : 8787,
    token: typeof cfg.token === 'string' && cfg.token ? cfg.token : null,
  };
}

async function saveConfig(cfg) {
  await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
}

function isHttpUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function getConnectionState(cfg) {
  return {
    paired: Boolean(cfg.token),
    connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
    port: cfg.port,
    lastError,
  };
}

function scheduleReconnect() {
  if (reconnectTimer || intentionalClose) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(15000, Math.round(reconnectDelayMs * 1.6));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureConnected();
  }, delay);
}

async function ensureConnected() {
  const cfg = await loadConfig();
  if (!cfg.token || !cfg.port) return false;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return ws.readyState === WebSocket.OPEN;
  }

  intentionalClose = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const url = `ws://127.0.0.1:${cfg.port}/ws/chrome-ext?token=${encodeURIComponent(cfg.token)}`;
    const socket = new WebSocket(url);
    ws = socket;

    const connectTimer = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        lastError = `Connection timeout on 127.0.0.1:${cfg.port}`;
        finish(false);
        try {
          socket.close();
        } catch {
          // ignore
        }
      }
    }, 5000);

    socket.addEventListener('open', () => {
      clearTimeout(connectTimer);
      reconnectDelayMs = 1500;
      lastError = null;
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
      finish(true);
    });

    socket.addEventListener('message', (event) => {
      void handleBridgeMessage(socket, String(event.data));
    });

    socket.addEventListener('close', async (event) => {
      clearTimeout(connectTimer);
      if (ws === socket) ws = null;
      finish(false);

      // 4001 = unpaired, 4002 = repaired, 4401 = vault locked
      if (event.code === 4001) {
        lastError = 'Unpaired by Atelier.';
        await saveConfig({ port: cfg.port, token: null });
        chrome.alarms.clear(KEEPALIVE_ALARM);
        return;
      }
      if (!intentionalClose) {
        if (event.reason) lastError = `Disconnected: ${event.reason}`;
        scheduleReconnect();
      }
    });

    socket.addEventListener('error', () => {
      lastError = `Cannot reach Atelier on 127.0.0.1:${cfg.port}`;
    });
  });
}

async function handleBridgeMessage(socket, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'pong') return;

  const { id, action, params } = msg;
  if (!id || !action) return;

  try {
    const result = await dispatchAction(action, params || {});
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ v: 1, id, ok: true, result }));
    }
  } catch (err) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          v: 1,
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

async function dispatchAction(action, params) {
  switch (action) {
    case 'list_tabs': {
      const all = await chrome.tabs.query({});
      const tabs = all
        .filter((t) => t.id !== undefined && typeof t.url === 'string' && isHttpUrl(t.url))
        .map((t) => ({
          id: t.id,
          title: t.title || '',
          url: t.url,
          active: Boolean(t.active),
          windowId: t.windowId,
        }));
      return { tabs };
    }

    case 'open_url': {
      const url = typeof params.url === 'string' ? params.url.trim() : '';
      if (!isHttpUrl(url)) {
        throw new Error('Only http:// and https:// URLs are supported.');
      }
      const tab = await chrome.tabs.create({ url, active: true });
      if (tab.id === undefined) {
        throw new Error('Failed to create Chrome tab.');
      }
      const loaded = await waitForTabComplete(tab.id, 15000);
      await new Promise((r) => setTimeout(r, 600));
      return {
        tabId: loaded.id,
        url: loaded.url || url,
        title: loaded.title || '',
      };
    }

    case 'capture_screenshot': {
      const tab = await resolveTargetTab(params.tabId);
      if (!tab.id || !tab.url || !isHttpUrl(tab.url)) {
        throw new Error('Target Chrome tab is not an http(s) page.');
      }
      if (typeof params.tabId === 'number' && !tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise((r) => setTimeout(r, 120));
      }
      let mime = 'image/png';
      let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      if (dataUrl.length > 5_000_000) {
        mime = 'image/jpeg';
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
      }
      return {
        dataUrl,
        mime,
        url: tab.url,
        title: tab.title || '',
      };
    }

    case 'scroll': {
      const tab = await resolveTargetTab(params.tabId);
      if (!tab.id || !tab.url || !isHttpUrl(tab.url)) {
        throw new Error('Target Chrome tab is not an http(s) page.');
      }
      const dir = typeof params.direction === 'string' ? params.direction : 'down';
      const amt = Math.max(100, Math.min(5000, Number(params.amount) || 600));
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: ({ direction, amount }) => {
          if (direction === 'top') window.scrollTo(0, 0);
          else if (direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);
          else if (direction === 'up') window.scrollBy(0, -amount);
          else window.scrollBy(0, amount);
          return { scrollY: Math.round(window.scrollY) };
        },
        args: [{ direction: dir, amount: amt }],
      });
      return {
        scrolled: dir,
        url: tab.url,
        scrollY: results?.[0]?.result?.scrollY ?? 0,
      };
    }

    case 'inspect_html': {
      const tab = await resolveTargetTab(params.tabId);
      if (!tab.id || !tab.url || !isHttpUrl(tab.url)) {
        throw new Error('Target Chrome tab is not an http(s) page.');
      }
      const sel = typeof params.selector === 'string' && params.selector.trim() ? params.selector.trim() : null;
      const limit = Math.max(2000, Math.min(60000, Number(params.maxHtmlChars) || 20000));

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: extractCleanedDomAndTokens,
        args: [{ sel, limit }],
      });

      const first = results?.[0];
      if (!first || !first.result) {
        throw new Error('Failed to inspect page DOM.');
      }
      if (first.result.error) {
        throw new Error(first.result.error);
      }
      return first.result;
    }

    case 'snapshot': {
      const tab = await resolveTargetTab(params.tabId);
      if (!tab.id || !tab.url || !isHttpUrl(tab.url)) {
        throw new Error('Target Chrome tab is not an http(s) page.');
      }
      const limit = Math.max(500, Math.min(20000, Number(params.maxChars) || 6000));
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: extractSimpleSnapshot,
        args: [limit],
      });
      return results?.[0]?.result ?? { url: tab.url, title: tab.title || '', text: '' };
    }

    default:
      throw new Error(`Unsupported bridge action: ${action}`);
  }
}

async function resolveTargetTab(tabId) {
  if (typeof tabId === 'number' && Number.isFinite(tabId)) {
    return chrome.tabs.get(tabId);
  }
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active[0]) return active[0];
  const fallback = await chrome.tabs.query({ active: true });
  if (fallback[0]) return fallback[0];
  throw new Error('No active Chrome tab found.');
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      try {
        resolve(await chrome.tabs.get(tabId));
      } catch {
        resolve({ id: tabId, url: '', title: '' });
      }
    };

    const onUpdated = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === 'complete') {
        void finish();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => void finish(), timeoutMs);

    void chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete' && t.url && t.url !== 'about:blank') {
        void finish();
      }
    });
  });
}

// Runs in the page's ISOLATED world via chrome.scripting.executeScript (read-only).
function extractCleanedDomAndTokens({ sel, limit }) {
  try {
    const rootEl = sel ? document.querySelector(sel) : document.body;
    if (!rootEl) {
      return {
        error: sel ? `Selector "${sel}" tidak ditemukan di halaman.` : 'Elemen body halaman tidak tersedia.',
      };
    }

    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const isTransparent = (color) =>
      !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)';

    const addFreq = (map, val) => {
      const trimmed = (val || '').trim();
      if (!trimmed) return;
      map.set(trimmed, (map.get(trimmed) || 0) + 1);
    };

    const topKeys = (map, max) =>
      [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, max)
        .map(([k]) => k);

    const bgFreq = new Map();
    const textFreq = new Map();
    const borderFreq = new Map();
    const fontFreq = new Map();
    const sizeFreq = new Map();
    const radiusFreq = new Map();
    const keyElements = [];

    const keySelector = 'h1, h2, h3, header, nav, main, form, input, textarea, select, button, a[href]';
    const keySet = new Set(Array.from(rootEl.querySelectorAll(keySelector)));
    if (rootEl.matches(keySelector)) keySet.add(rootEl);

    const allElements = [rootEl, ...Array.from(rootEl.querySelectorAll('*'))];
    let walked = 0;

    for (const el of allElements) {
      if (walked >= 200) break;
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
      if (!isVisible(el)) continue;
      walked += 1;

      const cs = window.getComputedStyle(el);
      if (!isTransparent(cs.backgroundColor)) addFreq(bgFreq, cs.backgroundColor);
      if (!isTransparent(cs.color)) addFreq(textFreq, cs.color);
      if (cs.borderTopWidth !== '0px' && !isTransparent(cs.borderTopColor)) {
        addFreq(borderFreq, cs.borderTopColor);
      }
      if (cs.fontFamily) addFreq(fontFreq, cs.fontFamily);
      if (cs.fontSize) addFreq(sizeFreq, cs.fontSize);
      if (cs.borderRadius && cs.borderRadius !== '0px') addFreq(radiusFreq, cs.borderRadius);

      if (keySet.has(el) && keyElements.length < 40) {
        if (tag === 'input' && (el.type || '').toLowerCase() === 'hidden') continue;
        const rawLabel =
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.innerText ||
          el.getAttribute('name') ||
          '';
        const label = rawLabel.replace(/\s+/g, ' ').trim().slice(0, 80);
        const role = el.getAttribute('role') || undefined;
        const type = tag === 'input' ? (el.type || 'text').toLowerCase() : undefined;

        const styles = {};
        if (!isTransparent(cs.backgroundColor)) styles.backgroundColor = cs.backgroundColor;
        if (!isTransparent(cs.color)) styles.color = cs.color;
        if (cs.fontFamily) styles.fontFamily = cs.fontFamily;
        if (cs.fontSize) styles.fontSize = cs.fontSize;
        if (cs.fontWeight && cs.fontWeight !== '400') styles.fontWeight = cs.fontWeight;
        if (cs.borderRadius && cs.borderRadius !== '0px') styles.borderRadius = cs.borderRadius;
        if (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none') {
          styles.border = `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`;
        }
        if (cs.padding && cs.padding !== '0px') styles.padding = cs.padding;
        if (cs.boxShadow && cs.boxShadow !== 'none') styles.boxShadow = cs.boxShadow;
        if (cs.display) styles.display = cs.display;

        keyElements.push({
          tag,
          ...(role ? { role } : {}),
          ...(type ? { type } : {}),
          ...(label ? { label } : {}),
          styles,
        });
      }
    }

    const clone = rootEl.cloneNode(true);
    for (const node of clone.querySelectorAll('script, style, noscript, template, iframe')) {
      node.remove();
    }

    const sanitizeNode = (el) => {
      const tag = el.tagName.toLowerCase();
      if (el.hasAttribute('hidden')) {
        el.remove();
        return;
      }
      const styleAttr = (el.getAttribute('style') || '').toLowerCase();
      if (/display\s*:\s*none/.test(styleAttr) || /visibility\s*:\s*hidden/.test(styleAttr)) {
        el.remove();
        return;
      }
      if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'password') {
        el.removeAttribute('value');
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'nonce' || name === 'data-atelier-ref') {
          el.removeAttribute(attr.name);
          continue;
        }
        if (name.startsWith('data-') && attr.value.length > 80) {
          el.removeAttribute(attr.name);
          continue;
        }
        if ((name === 'src' || name === 'href') && attr.value.startsWith('data:')) {
          el.setAttribute(attr.name, 'data:[omitted]');
        }
      }
      if (tag === 'svg' && el.outerHTML.length > 500) {
        el.innerHTML = '<!-- svg omitted -->';
        return;
      }
      for (const child of Array.from(el.children)) {
        sanitizeNode(child);
      }
    };

    sanitizeNode(clone);

    const rawHtml = clone.outerHTML
      .replace(/<!--(?!\s*svg omitted\s*-->)[\s\S]*?-->/g, '')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    const htmlTruncated = rawHtml.length > limit;
    const html = htmlTruncated ? `${rawHtml.slice(0, limit)}\n<!-- truncated -->` : rawHtml;

    return {
      url: window.location.href,
      title: document.title || '',
      viewport: { width: window.innerWidth, height: window.innerHeight },
      selector: sel,
      html,
      htmlTruncated,
      tokens: {
        backgroundColors: topKeys(bgFreq, 12),
        textColors: topKeys(textFreq, 10),
        borderColors: topKeys(borderFreq, 8),
        fontFamilies: topKeys(fontFreq, 6),
        fontSizes: topKeys(sizeFreq, 12),
        borderRadii: topKeys(radiusFreq, 8),
      },
      keyElements,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function extractSimpleSnapshot(limit) {
  const text = (document.body?.innerText || '').replace(/\s+\n/g, '\n').trim().slice(0, limit);
  return {
    url: window.location.href,
    title: document.title || '',
    text,
  };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ v: 1, type: 'ping' }));
    } catch {
      void ensureConnected();
    }
  } else {
    void ensureConnected();
  }
});

chrome.runtime.onStartup.addListener(() => {
  void ensureConnected();
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureConnected();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'get_state') {
      const cfg = await loadConfig();
      if (cfg.token && (!ws || ws.readyState === WebSocket.CLOSED)) {
        await ensureConnected();
      }
      sendResponse(getConnectionState(cfg));
      return;
    }

    if (msg.type === 'pair') {
      const port = Number(msg.port);
      const code = typeof msg.code === 'string' ? msg.code.trim() : '';
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        sendResponse({ ok: false, error: 'Invalid Atelier port.' });
        return;
      }
      if (!code) {
        sendResponse({ ok: false, error: 'Pairing code is required.' });
        return;
      }

      const res = await fetch(`http://127.0.0.1:${port}/chrome-ext/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) {
        const message = data?.error?.message || `Pairing failed (${res.status})`;
        sendResponse({ ok: false, error: message });
        return;
      }

      if (ws) {
        intentionalClose = true;
        try {
          ws.close(4002, 'repaired');
        } catch {
          // ignore
        }
        ws = null;
      }

      const nextCfg = { port: Number(data.port) || port, token: data.token };
      await saveConfig(nextCfg);
      const connected = await ensureConnected();
      sendResponse({ ok: connected, state: getConnectionState(nextCfg), error: connected ? null : lastError });
      return;
    }

    if (msg.type === 'disconnect') {
      const cfg = await loadConfig();
      intentionalClose = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close(1000, 'user_disconnect');
        } catch {
          // ignore
        }
        ws = null;
      }
      chrome.alarms.clear(KEEPALIVE_ALARM);
      const nextCfg = { port: cfg.port, token: null };
      await saveConfig(nextCfg);
      lastError = null;
      sendResponse({ ok: true, state: getConnectionState(nextCfg) });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});

void ensureConnected();
