/* Compatibility bridge between the browser-only public simulator and the dashboard UI.
 * No network request is made: the WebSocket/fetch-shaped calls are handled locally.
 */
"use strict";

(() => {
  const demo = window.PMESDemo;
  if (!demo) {
    console.error("PM-ES public simulator is unavailable");
    return;
  }

  const NativeWebSocket = window.WebSocket;

  class LocalDemoSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this._unsubscribe = null;

      window.setTimeout(() => {
        this.readyState = 1;
        if (typeof this.onopen === "function") this.onopen({});
        this._unsubscribe = demo.subscribe((message) => {
          if (this.readyState === 1 && typeof this.onmessage === "function") {
            this.onmessage({ data: JSON.stringify(message) });
          }
        });
      }, 0);
    }

    send() {}

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this._unsubscribe) this._unsubscribe();
      if (typeof this.onclose === "function") this.onclose({});
    }
  }

  window.WebSocket = function WebSocket(url, protocols) {
    const path = new URL(url, window.location.href).pathname;
    if (path.endsWith("/public-demo-stream")) return new LocalDemoSocket(url);
    return protocols !== undefined
      ? new NativeWebSocket(url, protocols)
      : new NativeWebSocket(url);
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((key, index) => {
    window.WebSocket[key] = index;
  });

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function localDemoFetch(input, init) {
    const url = typeof input === "string" ? input : input.url;
    const path = new URL(url, window.location.href).pathname;

    if (path.endsWith("/demo-api/scenario")) {
      demo.cycleScenario();
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }

    if (path.endsWith("/demo-api/reset-graphs")) {
      demo.resetHistory();
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }

    return nativeFetch(input, init);
  };

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(anchor.href), 3000);
  }

  window.addEventListener("pm-es-export-csv", () => {
    downloadText("pm-es-public-demo.csv", demo.exportCsv(), "text/csv");
  });
  window.addEventListener("pm-es-export-log", () => {
    downloadText("pm-es-public-demo.log", demo.exportLog(), "text/plain");
  });
})();
