// Chrome DevTools Protocol client – ansluter till din redan öppna Chrome
// (startad med --remote-debugging-port, se start-chrome.ps1).
import { setTimeout as sleep } from "node:timers/promises";

export class CdpBrowser {
  /**
   * @param {object} opts
   * @param {string} [opts.host]
   * @param {number} [opts.port]
   */
  constructor(opts = {}) {
    this.host = opts.host || process.env.ODDS_CHROME_HOST || "127.0.0.1";
    this.port = Number(opts.port || process.env.ODDS_CHROME_PORT || 9222);
    /** @type {WebSocket | null} */
    this.ws = null;
    this.targetId = null;
    this.sessionId = null;
    this._rootId = 0;
    this._sessId = 0;
    this._rootPending = new Map();
    this._sessPending = new Map();
  }

  get debugUrl() {
    return `http://${this.host}:${this.port}`;
  }

  async connect() {
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      try {
        const r = await fetch(`${this.debugUrl}/json/version`);
        const j = await r.json();
        wsUrl = j.webSocketDebuggerUrl;
      } catch {
        await sleep(250);
      }
    }
    if (!wsUrl) {
      throw new Error(
        `Ingen Chrome på ${this.debugUrl}. Kör scripts/odds-agent/start-chrome.ps1`
      );
    }

    this.ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this._rootPending.has(m.id)) {
        this._rootPending.get(m.id)(m.result);
        this._rootPending.delete(m.id);
      }
      if (m.id && this._sessPending.has(m.id)) {
        this._sessPending.get(m.id)(m.result);
        this._sessPending.delete(m.id);
      }
    };

    const { targetId } = await this._sendRoot("Target.createTarget", {
      url: "about:blank",
      background: true,
    });
    this.targetId = targetId;
    const { sessionId } = await this._sendRoot("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    this.sessionId = sessionId;
    await this._send("Page.enable");
    await this._send("Runtime.enable");
  }

  async close() {
    if (this.targetId) {
      try {
        await this._sendRoot("Target.closeTarget", { targetId: this.targetId });
      } catch {}
    }
    if (this.ws) this.ws.close();
  }

  _sendRoot(method, params) {
    const id = ++this._rootId;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve) => this._rootPending.set(id, resolve));
  }

  _send(method, params) {
    const id = ++this._sessId + 100000;
    this.ws.send(
      JSON.stringify({ id, sessionId: this.sessionId, method, params: params || {} })
    );
    return new Promise((resolve) => this._sessPending.set(id, resolve));
  }

  async goto(url, waitMs = 5000) {
    await this._send("Page.navigate", { url });
    await sleep(waitMs);
    await this.minimizeIfPossible();
  }

  /** Hindrar att scrape stjäl fokus från det du jobbar med. */
  async minimizeIfPossible() {
    if (!this.targetId) return;
    try {
      const win = await this._sendRoot("Browser.getWindowForTarget", {
        targetId: this.targetId,
      });
      const windowId = win?.windowId;
      if (!windowId) return;
      await this._sendRoot("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
    } catch {
      // Browser.* saknas i vissa Chrome-versioner – harmlost
    }
  }

  /**
   * @param {string} expression
   * @param {number} [timeoutMs]
   */
  async waitFor(expression, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.eval(expression);
      if (res) return res;
      await sleep(500);
    }
    return null;
  }

  async eval(expression) {
    const res = await this._send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      const t = res.exceptionDetails.text || "evaluate failed";
      throw new Error(t);
    }
    return res?.result?.value;
  }
}
