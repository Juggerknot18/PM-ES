/* PM-ES public telemetry demo.
 * Browser-only illustrative simulator. It does not encode, decode or expose
 * any private transport frame, protocol constant, hardware mapping or control path.
 */
"use strict";

const SERIES = [
  "dc_link_pct", "speed_filtered", "speed_raw", "commanded_rpm", "target_rpm",
  "controller_alerts", "encoder_alerts", "reference_rejections", "protection_events",
];
const HISTORY_LEN = 600;
const EVENT_LIMIT = 120;
const SCENARIOS = ["nominal", "regeneration", "sensor alert"];
const nowS = () => Date.now() / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const noise = (span) => (Math.random() - 0.5) * span;

class PublicDemo {
  constructor() {
    this.scenarioIndex = 0;
    this.scenarioStarted = nowS();
    this.lastStep = nowS();
    this.phase = 0;
    this.commanded = 0;
    this.measured = 0;
    this.target = 420;
    this.dc = 55;
    this.protectionEvents = 0;
    this.protectionWindowEvents = 0;
    this.controllerAlerts = 0;
    this.encoderAlerts = 0;
    this.referenceRejections = 0;
    this.lastEventDuration = 0;
    this.sampleTotal = 0;
    this.history = { t: [] };
    SERIES.forEach(k => this.history[k] = []);
    this.events = [];
    this.logLines = [];
    this.clients = new Set();
    this.addEvent("dashboard", "info", "Public browser demo started");
    this.addEvent("boundary", "info", "Illustrative data only — no hardware connection");
  }

  get scenario() { return SCENARIOS[this.scenarioIndex]; }

  cycleScenario() {
    this.scenarioIndex = (this.scenarioIndex + 1) % SCENARIOS.length;
    this.scenarioStarted = nowS();
    this.phase = 0;
    this.protectionWindowEvents = 0;
    this.addEvent("scenario", "info", `Public scenario changed to ${this.scenario}`);
  }

  addEvent(source, level, msg) {
    const ts = nowS();
    this.events.push({ ts, source, level, msg });
    if (this.events.length > EVENT_LIMIT) this.events.shift();
    const stamp = new Date(ts * 1000).toISOString();
    this.logLines.push(`${stamp} [${level.toUpperCase()}] ${source}: ${msg}`);
    if (this.logLines.length > 1000) this.logLines.splice(0, 200);
  }

  step() {
    const start = performance.now();
    const now = nowS();
    const dt = clamp(now - this.lastStep, 0.01, 0.25);
    this.lastStep = now;
    this.phase += dt;

    const controllerOnline = true;
    let encoderHealthy = true;
    let referenceValid = true;
    let protectionActive = false;
    let protectionLevel = 0;
    let motorState = "RUNNING";
    let thermalStatus = "nominal";

    const ramp = Math.min(1, this.phase / 5);
    const baseTarget = this.scenario === "sensor alert" ? 330 : 420;
    this.target = baseTarget;
    this.commanded += (this.target * ramp - this.commanded) * Math.min(1, dt * 3.2);
    this.measured += (this.commanded - this.measured) * Math.min(1, dt * 4.5);

    if (this.scenario === "nominal") {
      this.dc = 55 + Math.sin(this.phase * 0.45) * 1.8 + noise(0.7);
      motorState = this.phase < 2 ? "STARTING" : "RUNNING";
    }

    if (this.scenario === "regeneration") {
      const wave = (Math.sin(this.phase * 0.62) + 1) / 2;
      this.dc = 57 + wave * 27 + noise(1.0);
      protectionActive = this.dc > 76;
      protectionLevel = this.dc > 88 ? 2 : protectionActive ? 1 : 0;
      motorState = protectionLevel >= 2 ? "LIMITED" : "RUNNING";
      thermalStatus = protectionActive ? "elevated (illustrative)" : "nominal";
      if (protectionActive && this.protectionWindowEvents === 0) {
        this.protectionEvents += 1;
        this.protectionWindowEvents = 1;
        this.lastEventDuration = 640;
        this.addEvent("protection", "warn", "Illustrative energy-dissipation event active");
      }
      if (!protectionActive && this.protectionWindowEvents === 1) {
        this.protectionWindowEvents = 2;
        this.addEvent("protection", "info", "Illustrative energy-dissipation event completed");
      }
      if (this.phase > 8 && this.protectionWindowEvents === 2) this.protectionWindowEvents = 0;
    }

    if (this.scenario === "sensor alert") {
      this.dc = 56 + Math.sin(this.phase * 0.55) * 2 + noise(0.8);
      const alertWindow = (this.phase % 12) > 7 && (this.phase % 12) < 10;
      encoderHealthy = !alertWindow;
      referenceValid = !alertWindow;
      motorState = alertWindow ? "LIMITED" : "RUNNING";
      protectionLevel = alertWindow ? 1 : 0;
      if (alertWindow && this.encoderAlerts === 0) {
        this.encoderAlerts += 1;
        this.referenceRejections += 1;
        this.addEvent("encoder", "warn", "Illustrative reference-quality alert");
      }
      if (!alertWindow && this.encoderAlerts > 0 && (this.phase % 12) < 1) {
        this.addEvent("encoder", "info", "Illustrative reference quality restored");
      }
    }

    const rawSpeed = Math.round(this.measured + noise(9));
    const measuredSpeed = Math.round(this.measured + noise(2));
    const frame = {
      dc_link_pct: clamp(this.dc, 0, 100),
      measured_rpm: measuredSpeed,
      commanded_rpm: Math.round(this.commanded),
      target_rpm: Math.round(this.target),
      speed_filtered: measuredSpeed,
      speed_raw: rawSpeed,
      controller_online: controllerOnline,
      encoder_healthy: encoderHealthy,
      reference_valid: referenceValid,
      protection_active: protectionActive,
      protection_level: protectionLevel,
      protection_level_txt: ["NORMAL", "WATCH", "LIMITING", "FAULT", "CRITICAL"][protectionLevel],
      protection_state_txt: protectionActive ? "ACTIVE" : "STANDBY",
      protection_events: this.protectionEvents,
      protection_window_events: this.protectionWindowEvents,
      last_event_duration_ms: this.lastEventDuration,
      thermal_status: thermalStatus,
      controller_alerts: this.controllerAlerts,
      encoder_alerts: this.encoderAlerts,
      reference_rejections: this.referenceRejections,
      motor_state_txt: motorState,
      motor_fault_txt: "NONE",
    };

    this.sampleTotal += 1;
    this.pushHistory(now, frame);
    const stats = {
      link_online: true,
      scenario: this.scenario,
      sample_valid: this.sampleTotal,
      sample_total: this.sampleTotal,
      data_check: "OK",
      demo_event_count: this.events.length,
      update_hz: 10.0,
      render_latency_ms: Math.max(0.1, Math.round((performance.now() - start) * 100) / 100),
      last_valid_ts: now,
    };
    const snap = { frame, stats, alarms: this.alarms(frame), events: this.events.slice(-30) };
    const text = JSON.stringify(snap);
    this.clients.forEach(ws => ws.deliver(text));
  }

  alarms(f) {
    const out = [];
    if (!f.controller_online) out.push({ level: "fault", msg: "Illustrative controller-link interruption" });
    if (!f.encoder_healthy) out.push({ level: "warn", msg: "Illustrative encoder-quality alert" });
    if (f.protection_level >= 2) out.push({ level: "warn", msg: "Illustrative protective limiting active" });
    else if (f.protection_active) out.push({ level: "warn", msg: "Illustrative energy-dissipation event" });
    return out;
  }

  pushHistory(t, f) {
    this.history.t.push(Math.round(t * 100) / 100);
    SERIES.forEach(k => this.history[k].push(f[k]));
    if (this.history.t.length > HISTORY_LEN) {
      this.history.t.shift();
      SERIES.forEach(k => this.history[k].shift());
    }
  }

  resetHistory() {
    this.history.t.length = 0;
    SERIES.forEach(k => this.history[k].length = 0);
    this.addEvent("dashboard", "info", "Public demo graphs reset");
  }

  exportCsv() {
    const rows = [["timestamp", ...SERIES].join(",")];
    for (let i = 0; i < this.history.t.length; i++) {
      rows.push([this.history.t[i], ...SERIES.map(k => this.history[k][i])].join(","));
    }
    return rows.join("\r\n") + "\r\n";
  }

  exportLog() { return this.logLines.join("\n") + "\n"; }
}

const demo = new PublicDemo();
setInterval(() => demo.step(), 100);

const RealWebSocket = window.WebSocket;
class DemoWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
      this.deliver(JSON.stringify({ history: demo.history }));
      demo.clients.add(this);
    }, 0);
  }
  deliver(text) { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: text }); }
  send() {}
  close() {
    this.readyState = 3;
    demo.clients.delete(this);
    if (this.onclose) this.onclose({});
  }
}
window.WebSocket = function(url, protocols) {
  const path = new URL(url, location.href).pathname;
  if (path.endsWith("/public-demo-stream")) return new DemoWebSocket(url);
  return protocols !== undefined ? new RealWebSocket(url, protocols) : new RealWebSocket(url);
};
window.WebSocket.prototype = RealWebSocket.prototype;
["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((k, i) => { window.WebSocket[k] = i; });

const realFetch = window.fetch.bind(window);
window.fetch = function(input, init) {
  const url = typeof input === "string" ? input : input.url;
  const path = new URL(url, location.href).pathname;
  if (path.endsWith("/demo-api/scenario")) {
    demo.cycleScenario();
    return Promise.resolve(new Response(JSON.stringify({ ok: true, scenario: demo.scenario }),
      { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  if (path.endsWith("/demo-api/reset-graphs")) {
    demo.resetHistory();
    return Promise.resolve(new Response(JSON.stringify({ ok: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  return realFetch(input, init);
};

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
window.addEventListener("pm-es-export-csv", () =>
  downloadText("pm-es-public-demo.csv", demo.exportCsv(), "text/csv"));
window.addEventListener("pm-es-export-log", () =>
  downloadText("pm-es-public-demo.log", demo.exportLog(), "text/plain"));
