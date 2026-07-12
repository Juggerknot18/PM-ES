/* PM-ES public telemetry demo.
 * Browser-only illustrative simulator. It does not encode, decode or expose
 * any private transport frame, protocol constant, hardware mapping or control path.
 */
"use strict";

const SERIES = [
  "dc_link_v", "speed_filtered", "speed_raw", "commanded_rpm", "target_rpm",
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
    this.dc = 50.0;
    this.publicDissipation = false;
    this.wasProtectionActive = false;
    this.protectionStartedAt = 0;
    this.protectionEvents = 0;
    this.protectionWindowEvents = 0;
    this.controllerAlerts = 0;
    this.encoderAlerts = 0;
    this.referenceRejections = 0;
    this.lastEventDuration = 0;
    this.sampleTotal = 0;
    this.history = { t: [] };
    SERIES.forEach((key) => { this.history[key] = []; });
    this.events = [];
    this.logLines = [];
    this.listeners = new Set();
    this.lastSnapshot = null;
    this.addEvent("dashboard", "info", "Public browser demo started");
    this.addEvent("boundary", "info", "Illustrative data only — no hardware connection");
  }

  get scenario() {
    return SCENARIOS[this.scenarioIndex];
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    window.setTimeout(() => {
      listener({ history: this.history });
      if (this.lastSnapshot) listener(this.lastSnapshot);
    }, 0);
    return () => this.listeners.delete(listener);
  }

  emit(message) {
    this.listeners.forEach((listener) => {
      try {
        listener(message);
      } catch (error) {
        console.error("PM-ES public demo listener error", error);
      }
    });
  }

  cycleScenario() {
    this.scenarioIndex = (this.scenarioIndex + 1) % SCENARIOS.length;
    this.scenarioStarted = nowS();
    this.phase = 0;
    this.publicDissipation = false;
    this.wasProtectionActive = false;
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
    const currentTime = nowS();
    const dt = clamp(currentTime - this.lastStep, 0.01, 0.25);
    this.lastStep = currentTime;
    this.phase += dt;

    const controllerOnline = true;
    let encoderHealthy = true;
    let referenceValid = true;
    let protectionActive = false;
    let protectionLevel = 0;
    let motorState = "RUNNING";
    let thermalStatus = "nominal";
    let dcLinkState = "nominal";

    const ramp = Math.min(1, this.phase / 5);
    const baseTarget = this.scenario === "sensor alert" ? 330 : 420;
    this.target = baseTarget;
    this.commanded += (this.target * ramp - this.commanded) * Math.min(1, dt * 3.2);
    this.measured += (this.commanded - this.measured) * Math.min(1, dt * 4.5);

    if (this.scenario === "nominal") {
      const nominalTarget = 50.0 + Math.sin(this.phase * 0.45) * 0.12;
      this.dc += (nominalTarget - this.dc) * Math.min(1, dt / 0.8);
      this.dc += noise(0.035);
      motorState = this.phase < 2 ? "STARTING" : "RUNNING";
      this.publicDissipation = false;
    }

    if (this.scenario === "regeneration") {
      /* Visual-only dynamics inspired by the original dashboard shape.
       * These demonstration bands deliberately do not encode hardware thresholds.
       */
      if (!this.publicDissipation) {
        this.dc += (1.35 + Math.sin(this.phase * 0.7) * 0.10) * dt;
        if (this.dc >= 57.2) this.publicDissipation = true;
      } else {
        this.dc -= 6.2 * dt;
        if (this.dc <= 54.8) this.publicDissipation = false;
      }
      this.dc += noise(0.035);
      this.dc = clamp(this.dc, 49.5, 57.5);
      protectionActive = this.publicDissipation;
      protectionLevel = protectionActive ? 1 : 0;
      dcLinkState = protectionActive ? "active" : this.dc > 54.8 ? "elevated" : "nominal";
      motorState = protectionActive ? "LIMITED" : "RUNNING";
      thermalStatus = protectionActive ? "elevated (illustrative)" : "nominal";
    }

    if (this.scenario === "sensor alert") {
      const nominalTarget = 50.4 + Math.sin(this.phase * 0.55) * 0.18;
      this.dc += (nominalTarget - this.dc) * Math.min(1, dt / 0.9);
      this.dc += noise(0.04);
      const phaseInCycle = this.phase % 12;
      const alertWindow = phaseInCycle > 7 && phaseInCycle < 10;
      encoderHealthy = !alertWindow;
      referenceValid = !alertWindow;
      motorState = alertWindow ? "LIMITED" : "RUNNING";
      protectionLevel = alertWindow ? 1 : 0;
      if (alertWindow && this.encoderAlerts === 0) {
        this.encoderAlerts += 1;
        this.referenceRejections += 1;
        this.addEvent("encoder", "warn", "Illustrative reference-quality alert");
      }
      if (!alertWindow && this.encoderAlerts > 0 && phaseInCycle < 1) {
        this.addEvent("encoder", "info", "Illustrative reference quality restored");
      }
      this.publicDissipation = false;
    }

    if (protectionActive && !this.wasProtectionActive) {
      this.protectionStartedAt = currentTime;
      this.protectionEvents += 1;
      this.protectionWindowEvents = Math.min(this.protectionWindowEvents + 1, 9);
      this.addEvent("protection", "warn", "Illustrative energy-dissipation event active");
    } else if (!protectionActive && this.wasProtectionActive) {
      this.lastEventDuration = Math.max(1, Math.round((currentTime - this.protectionStartedAt) * 1000));
      this.addEvent("protection", "info", "Illustrative energy-dissipation event completed");
    }
    this.wasProtectionActive = protectionActive;

    const rawSpeed = Math.round(this.measured + noise(9));
    const measuredSpeed = Math.round(this.measured + noise(2));
    const frame = {
      dc_link_v: Math.round(clamp(this.dc, 0, 70) * 100) / 100,
      dc_link_state: dcLinkState,
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
    this.pushHistory(currentTime, frame);
    const stats = {
      link_online: true,
      scenario: this.scenario,
      sample_valid: this.sampleTotal,
      sample_total: this.sampleTotal,
      data_check: "OK",
      demo_event_count: this.events.length,
      update_hz: 10.0,
      render_latency_ms: Math.max(0.1, Math.round((performance.now() - start) * 100) / 100),
      last_valid_ts: currentTime,
    };
    const snapshot = {
      frame,
      stats,
      alarms: this.alarms(frame),
      events: this.events.slice(-30),
    };
    this.lastSnapshot = snapshot;
    this.emit(snapshot);
  }

  alarms(frame) {
    const out = [];
    if (!frame.controller_online) {
      out.push({ level: "fault", msg: "Illustrative controller-link interruption" });
    }
    if (!frame.encoder_healthy) {
      out.push({ level: "warn", msg: "Illustrative encoder-quality alert" });
    }
    if (frame.protection_level >= 2) {
      out.push({ level: "warn", msg: "Illustrative protective limiting active" });
    } else if (frame.protection_active) {
      out.push({ level: "warn", msg: "Illustrative energy-dissipation event" });
    }
    return out;
  }

  pushHistory(timestamp, frame) {
    this.history.t.push(Math.round(timestamp * 100) / 100);
    SERIES.forEach((key) => { this.history[key].push(frame[key]); });
    if (this.history.t.length > HISTORY_LEN) {
      this.history.t.shift();
      SERIES.forEach((key) => { this.history[key].shift(); });
    }
  }

  resetHistory() {
    this.history.t.length = 0;
    SERIES.forEach((key) => { this.history[key].length = 0; });
    this.addEvent("dashboard", "info", "Public demo graphs reset");
  }

  exportCsv() {
    const rows = [["timestamp", ...SERIES].join(",")];
    for (let index = 0; index < this.history.t.length; index += 1) {
      rows.push([
        this.history.t[index],
        ...SERIES.map((key) => this.history[key][index]),
      ].join(","));
    }
    return rows.join("\r\n") + "\r\n";
  }

  exportLog() {
    return this.logLines.join("\n") + "\n";
  }
}

const publicDemo = new PublicDemo();
window.PMESDemo = {
  subscribe: (listener) => publicDemo.subscribe(listener),
  cycleScenario: () => publicDemo.cycleScenario(),
  resetHistory: () => publicDemo.resetHistory(),
  exportCsv: () => publicDemo.exportCsv(),
  exportLog: () => publicDemo.exportLog(),
};

publicDemo.step();
window.setInterval(() => publicDemo.step(), 100);
