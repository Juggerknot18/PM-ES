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
  /* Simulation fidèle au banc Raspberry (port de backend/simulator.py) :
   *   boot : OFF -> WAIT_BUS_READY -> ENCODER_INIT -> REFERENCE SEARCH
   *          (index Z ~0,5 tour) -> ARMED -> STARTING (rampe 200 rpm/s)
   *          -> RUNNING 300 rpm.
   *   regeneration : evenements discrets toutes les 18-35 s, VBUS +6 V/s
   *          pendant 0,8-2 s, trip 58,0 V, dump -12 V/s, release 54,0 V,
   *          cooldown 0,4 s, retour 50 V (tau 0,8 s).
   *   fenetre 15 evenements -> DERATING (consigne 50 %), decroissance
   *          aleatoire 0,2 %/tick. Glitchs Z 1 %/tour, erreurs CAN rares.
   * Seule la dynamique change : schema de trame, stats, scenarios, shims
   * WebSocket/fetch et exports sont inchanges. */
  constructor() {
    this.scenarioIndex = 0;
    this.lastStep = nowS();
    this.mono = 0;
    this.resetMachine();
    this.protectionEvents = 0;
    this.controllerAlerts = 0;
    this.encoderAlerts = 0;
    this.referenceRejections = 0;
    this.maxEventDuration = 0;
    this.totalEventMs = 0;
    this.sampleTotal = 0;
    this._pollTimes = [];
    this.updateHz = 0;
    this.history = { t: [] };
    SERIES.forEach(k => this.history[k] = []);
    this.events = [];
    this.logLines = [];
    this.clients = new Set();
    this.prevFrame = null;
    this.addEvent("dashboard", "info", "Dashboard demarre (demo navigateur)");
    this.addEvent("dashboard", "info", "Mode : SIMULATION (aucun materiel connecte)");
  }

  get scenario() { return SCENARIOS[this.scenarioIndex]; }

  resetMachine() {
    this.vbus = 50.0;
    this.actualRpm = 0.0;
    this.cmdRpm = 0.0;
    this.posTicks = 0.0;
    this.motorState = 0;
    this.stateSince = this.mono;
    this.indexValid = false;
    this.zCount = 0;
    this.brakeState = 0;
    this.ovp = false;
    this.ovpSince = 0;
    this.protectionWindowEvents = 0;
    this.lastEventDuration = 0;
    this.wasProtectionActive = false;
    this.target = 300;
    this.nextRegen = this.mono + 15 + Math.random() * 10;
    this.regenUntil = 0;
    this.alertWindowPrev = false;
  }

  cycleScenario() {
    this.scenarioIndex = (this.scenarioIndex + 1) % SCENARIOS.length;
    this.resetMachine();
    this.addEvent("scenario", "info", `Scenario : ${this.scenario} (reboot du banc)`);
  }

  addEvent(source, level, msg) {
    const ts = nowS();
    this.events.push({ ts, source, level, msg });
    if (this.events.length > EVENT_LIMIT) this.events.shift();
    const stamp = new Date(ts * 1000).toISOString();
    this.logLines.push(`${stamp} [${level.toUpperCase()}] ${source}: ${msg}`);
    if (this.logLines.length > 1000) this.logLines.splice(0, 200);
  }

  _stepMotor(dt) {
    const st = this.motorState;
    const elapsed = this.mono - this.stateSince;
    const enter = (s) => { this.motorState = s; this.stateSince = this.mono; };

    if (st === 0 && elapsed > 1.0) {
      enter(2);
    } else if (st === 2 && elapsed > 0.4) {
      enter(3);
      this.cmdRpm = 0.0;
    } else if (st === 3) {
      this.cmdRpm = Math.min(60.0, this.cmdRpm + 200.0 * dt);
      if (!this.indexValid && this.posTicks > 700) {
        this.indexValid = true;
        this.zCount += 1;
        this.posTicks = 0.0;
        enter(4);
        this.cmdRpm = 0.0;
      }
    } else if (st === 4 && elapsed > 0.3) {
      enter(5);
    } else if (st === 5) {
      this.cmdRpm = Math.min(this.target, this.cmdRpm + 200.0 * dt);
      if (this.cmdRpm >= this.target
          && Math.abs(this.actualRpm - this.target) < 15) {
        enter(6);
      }
    } else if (st === 6) {
      this.cmdRpm = this.target;
      if (this.protectionLevelNow() === 2) enter(7);
    } else if (st === 7) {
      this.cmdRpm = this.target * 0.5;
      if (this.protectionLevelNow() < 2) enter(6);
    }
  }

  protectionLevelNow() {
    return this.protectionWindowEvents >= 15 ? 2
         : this.protectionWindowEvents > 0 ? 1 : 0;
  }

  _stepPhysics(dt) {
    this.actualRpm += (this.cmdRpm - this.actualRpm) * dt / 0.2;
    this.posTicks += this.actualRpm * 1440 / 60.0 * dt;
    if (this.indexValid && this.posTicks >= 1440 * this.zCount) {
      this.zCount += 1;
      if (Math.random() < 0.01) {
        this.encoderAlerts += 1;
        this.addEvent("encodeur", "warn", "Glitch Z rejete");
      }
    }

    const regenEnabled = this.scenario !== "sensor alert";
    if (regenEnabled && !this.ovp && this.mono >= this.nextRegen
        && this.motorState === 6) {
      this.regenUntil = this.mono + 0.8 + Math.random() * 1.2;
      this.nextRegen = this.mono + 18 + Math.random() * 17;
    }

    const regen = regenEnabled && this.mono < this.regenUntil;
    if (regen) this.vbus += 6.0 * dt;
    else this.vbus += (50.0 - this.vbus) * dt / 0.8;
    this.vbus += noise(0.10);

    if (!this.ovp && this.vbus >= 58.0) {
      this.ovp = true;
      this.ovpSince = this.mono;
      this.brakeState = 1;
    }
    if (this.ovp) {
      this.vbus -= 12.0 * dt;
      if (this.vbus <= 54.0) {
        this.ovp = false;
        this.brakeState = 3;
        const dur = Math.trunc((this.mono - this.ovpSince) * 1000);
        this.lastEventDuration = dur;
        this.maxEventDuration = Math.max(this.maxEventDuration, dur);
        this.totalEventMs += dur;
        this.protectionEvents += 1;
        this.protectionWindowEvents = Math.min(this.protectionWindowEvents + 1, 15);
      }
    } else if (this.brakeState === 3 && (this.mono - this.ovpSince) > 0.4) {
      this.brakeState = 0;
    }
    if (!this.ovp && Math.random() < 0.002)
      this.protectionWindowEvents = Math.max(0, this.protectionWindowEvents - 1);

    if (Math.random() < 0.001) {
      this.controllerAlerts += 1;
      this.addEvent("can", "warn", "Erreur CAN (+1)");
    }
  }

  step() {
    const start = performance.now();
    const now = nowS();
    const dt = clamp(now - this.lastStep, 0.01, 0.5);
    this.lastStep = now;
    this.mono += dt;

    let alertWindow = false;
    if (this.scenario === "sensor alert" && this.motorState >= 6) {
      alertWindow = (this.mono % 12) > 7 && (this.mono % 12) < 10;
      if (alertWindow && !this.alertWindowPrev) {
        this.encoderAlerts += 1;
        this.referenceRejections += 1;
        this.addEvent("encodeur", "warn", "Qualite du signal encodeur degradee");
      }
      if (!alertWindow && this.alertWindowPrev)
        this.addEvent("encodeur", "info", "Signal encodeur retabli");
      this.alertWindowPrev = alertWindow;
    }

    this._stepMotor(dt);
    this._stepPhysics(dt);

    const stateTxt = ["OFF", "WAIT_BUS_READY", "ENCODER_INIT",
                      "REFERENCE SEARCH", "ARMED", "STARTING",
                      "RUNNING", "LIMITED"][this.motorState];
    const encoderHealthy = !alertWindow;
    const referenceValid = this.indexValid && !alertWindow;
    const protectionActive = this.ovp;
    const protectionLevel = alertWindow
      ? Math.max(1, this.protectionLevelNow()) : this.protectionLevelNow();

    if (protectionActive && !this.wasProtectionActive)
      this.addEvent("protection", "warn", "OVP active (chopper materiel ON)");
    if (!protectionActive && this.wasProtectionActive) {
      this.addEvent("protection", "info",
                    `OVP terminee (${this.lastEventDuration} ms)`);
      this.addEvent("protection", "info",
                    `Evenement chopper #${this.protectionEvents}`);
    }
    this.wasProtectionActive = protectionActive;

    const meas = Math.trunc(this.actualRpm + noise(6.0));
    const raw = meas + Math.trunc(noise(16.0));

    const frame = {
      dc_link_v: Math.round(clamp(this.vbus, 0, 70) * 100) / 100,
      dc_link_state: (this.ovp || this.vbus >= 58.0) ? "active"
                   : this.vbus >= 54.0 ? "elevated" : "nominal",
      measured_rpm: meas,
      commanded_rpm: Math.trunc(this.cmdRpm),
      target_rpm: this.target,
      speed_filtered: meas,
      speed_raw: raw,
      controller_online: this.motorState >= 2,
      encoder_healthy: encoderHealthy,
      reference_valid: referenceValid,
      protection_active: protectionActive,
      protection_level: protectionLevel,
      protection_level_txt: ["NORMAL", "WARNING", "DERATING",
                             "FAULT", "CRITICAL"][protectionLevel],
      protection_state_txt: ["IDLE", "HW_ACTIVE", "SW_FORCED",
                             "COOLDOWN", "FAULT"][this.brakeState],
      protection_events: this.protectionEvents,
      protection_window_events: this.protectionWindowEvents,
      last_event_duration_ms: this.lastEventDuration,
      thermal_status: "N/A (pas de capteur)",
      controller_alerts: this.controllerAlerts,
      encoder_alerts: this.encoderAlerts,
      reference_rejections: this.referenceRejections,
      motor_state_txt: stateTxt,
      motor_fault_txt: "NONE",
    };

    if (this.prevFrame && frame.motor_state_txt !== this.prevFrame.motor_state_txt)
      this.addEvent("moteur", "info",
                    `${this.prevFrame.motor_state_txt} -> ${frame.motor_state_txt}`);
    if (this.prevFrame && frame.reference_valid && !this.prevFrame.reference_valid
        && this.indexValid && this.zCount === 1)
      this.addEvent("encodeur", "info", "Index Z trouve, position referencee");
    if (this.prevFrame
        && frame.protection_window_events !== this.prevFrame.protection_window_events
        && this.protectionLevelNow() !== (this.prevFrame.protection_level || 0)) {
      const lvl = this.protectionLevelNow();
      this.addEvent("protection", lvl >= 2 ? "warn" : "info",
                    `Niveau ${["NORMAL","WARNING","DERATING"][this.prevFrame.protection_level] || "NORMAL"}`
                    + ` -> ${["NORMAL","WARNING","DERATING"][lvl]}`);
    }
    this.prevFrame = frame;

    this.sampleTotal += 1;
    this.pushHistory(now, frame);

    this._pollTimes.push(now);
    if (this._pollTimes.length > 20) this._pollTimes.shift();
    if (this._pollTimes.length >= 2) {
      const span = this._pollTimes[this._pollTimes.length - 1] - this._pollTimes[0];
      if (span > 0)
        this.updateHz = Math.round((this._pollTimes.length - 1) / span * 10) / 10;
    }

    const stats = {
      link_online: true,
      scenario: this.scenario,
      sample_valid: this.sampleTotal,
      sample_total: this.sampleTotal,
      data_check: "OK",
      demo_event_count: this.events.length,
      update_hz: this.updateHz,
      render_latency_ms: Math.max(0.1, Math.round((performance.now() - start) * 100) / 100),
      last_valid_ts: now,
    };
    const snap = { frame, stats, alarms: this.alarms(frame), events: this.events.slice(-30) };
    const text = JSON.stringify(snap);
    this.clients.forEach(ws => ws.deliver(text));
  }

  alarms(f) {
    const out = [];
    if (!f.controller_online) out.push({ level: "warn", msg: "Controleur hors ligne" });
    if (!f.encoder_healthy) out.push({ level: "fault", msg: "Encodeur non sain" });
    if (f.protection_level >= 2)
      out.push({ level: "warn", msg: "Protection DERATING" });
    if (f.protection_active)
      out.push({ level: "warn", msg: "OVP active — dump en cours" });
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
    this.addEvent("dashboard", "info", "Graphiques reinitialises");
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
