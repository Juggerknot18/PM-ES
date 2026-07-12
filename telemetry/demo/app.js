/* PM-ES Dashboard — frontend vanilla JS (aucune dépendance externe).
 * WebSocket temps réel, jauges SVG, graphiques canvas maison, timeline.
 * Léger par construction : rendu piloté par les messages (10 Hz). */

"use strict";

const C = {
  ok: "#3ED598", warn: "#E8A33D", fault: "#F0564A", info: "#5FA8D3",
  copper: "#C97E45", copperHi: "#E8A164", muted: "#7C8BA1", dim: "#4A576B",
  grid: "#16202f",
};
const LEVEL_COLOR = [C.ok, C.warn, C.warn, C.fault, C.fault];
const $ = (id) => document.getElementById(id);

/* ======================= Jauge SVG (arc 270°) ======================= */
class Gauge {
  constructor(el, opts) {
    this.o = Object.assign({ min: 0, max: 100, unit: "", label: "",
                             decimals: 0, zones: null, sub: "" }, opts);
    el.innerHTML = `
      <svg viewBox="0 0 120 108">
        <path class="track" pathLength="100" d="${this._arc()}"/>
        <path class="arc"   pathLength="100" d="${this._arc()}"
              stroke-dasharray="0 100"/>
        <text class="g-val"  x="60" y="60" text-anchor="middle">—</text>
        <text class="g-unit" x="60" y="74" text-anchor="middle">${this.o.unit}</text>
        <text class="g-sub"  x="60" y="100" text-anchor="middle">${this.o.sub}</text>
      </svg>
      <span class="label">${this.o.label}</span>`;
    this.arc = el.querySelector(".arc");
    this.val = el.querySelector(".g-val");
    this.sub = el.querySelector(".g-sub");
  }
  _arc() { // arc 270° : -225° -> +45°, centre (60,58), rayon 46
    const a = (deg) => {
      const r = (deg - 90) * Math.PI / 180;
      return `${60 + 46 * Math.cos(r)} ${58 + 46 * Math.sin(r)}`;
    };
    return `M ${a(-135)} A 46 46 0 1 1 ${a(135)}`;
  }
  set(value, colorOverride, subText) {
    const { min, max, zones, decimals } = this.o;
    const pct = Math.max(0, Math.min(1, (value - min) / (max - min))) * 100;
    let color = colorOverride;
    if (!color && zones) {
      color = C.ok;
      for (const [thr, col] of zones) if (value >= thr) color = col;
    }
    this.arc.setAttribute("stroke-dasharray", `${pct} ${100 - pct}`);
    this.arc.style.stroke = color || C.info;
    this.val.textContent = Number(value).toFixed(decimals);
    if (subText !== undefined) this.sub.textContent = subText;
  }
  setText(text, color, subText) {
    this.arc.setAttribute("stroke-dasharray", "100 0");
    this.arc.style.stroke = color;
    this.val.textContent = text;
    if (subText !== undefined) this.sub.textContent = subText;
  }
}

/* ======================= Graphique canvas ======================= */
class Chart {
  constructor(canvas, series, opts) {
    this.cv = canvas; this.ctx = canvas.getContext("2d");
    this.series = series;                 // [{key,label,color,width?}]
    this.o = Object.assign({ window: 60, minSpan: 1 }, opts);
    this.data = { t: [] };
    series.forEach(s => this.data[s.key] = []);
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  seed(history) {
    this.data.t = [...(history.t || [])];
    this.series.forEach(s => this.data[s.key] = [...(history[s.key] || [])]);
    this.draw();
  }
  push(t, frame) {
    this.data.t.push(t);
    this.series.forEach(s => this.data[s.key].push(frame[s.key]));
    const cutoff = t - this.o.window - 5;
    while (this.data.t.length && this.data.t[0] < cutoff) {
      this.data.t.shift();
      this.series.forEach(s => this.data[s.key].shift());
    }
    this.draw();
  }
  clear() {
    this.data.t = [];
    this.series.forEach(s => this.data[s.key] = []);
    this.draw();
  }
  draw() {
    const cv = this.cv, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const T = this.data.t;
    const now = T.length ? T[T.length - 1] : 0;
    const t0 = now - this.o.window;
    const padL = 44, padR = 8, padT = 6, padB = 16;
    const pw = w - padL - padR, ph = h - padT - padB;

    // Échelle Y auto sur les points visibles
    let lo = Infinity, hi = -Infinity;
    this.series.forEach(s => this.data[s.key].forEach((v, i) => {
      if (T[i] >= t0) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }));
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    const span = Math.max(hi - lo, this.o.minSpan);
    lo -= span * 0.08; hi = lo + span * 1.16;

    const X = (t) => padL + (t - t0) / this.o.window * pw;
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * ph;

    // Grille + graduations
    ctx.font = "9.5px ui-monospace,Consolas,monospace";
    ctx.fillStyle = C.dim; ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = lo + (hi - lo) * i / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(this._fmt(v), 4, y + 3);
    }
    for (let s = 0; s <= this.o.window; s += 15) {
      const x = X(t0 + s);
      ctx.fillText(`-${this.o.window - s}s`, x - 8, h - 4);
    }

    // Séries
    this.series.forEach(s => {
      const D = this.data[s.key];
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < D.length; i++) {
        if (T[i] < t0) continue;
        const x = X(T[i]), y = Y(D[i]);
        started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.7;
      ctx.stroke();
      if (started) {                       // point courant
        const x = X(T[T.length - 1]), y = Y(D[D.length - 1]);
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fillStyle = s.color; ctx.fill();
      }
    });
  }
  _fmt(v) {
    const a = Math.abs(v);
    return a >= 1000 ? (v / 1000).toFixed(1) + "k"
         : a >= 10 ? v.toFixed(0) : v.toFixed(1);
  }
}

/* ======================= Instanciation ======================= */
const gauges = {
  vbus:  new Gauge($("g-vbus"),  { min: 0, max: 70, unit: "V", label: "Bus DC",
           decimals: 1, sub: "trip 58 · rel 54",
           zones: [[0, C.ok], [54, C.warn], [58, C.fault]] }),
  rpm:   new Gauge($("g-rpm"),   { min: 0, max: 1000, unit: "rpm",
           label: "RPM mesuré", sub: "encodeur",
           zones: [[0, C.info], [1001, C.fault]] }),
  cmd:   new Gauge($("g-cmd"),   { min: 0, max: 1000, unit: "rpm",
           label: "RPM commandé", sub: "rampe superviseur",
           zones: [[0, C.copper]] }),
  brake: new Gauge($("g-brake"), { min: 0, max: 4, unit: "", label: "Brake",
           decimals: 0, sub: "" }),
  can:   new Gauge($("g-can"),   { min: 0, max: 1, unit: "", label: "CAN FSESC" }),
  spi:   new Gauge($("g-spi"),   { min: 0, max: 12, unit: "Hz", label: "Poll SPI",
           decimals: 1, sub: "" }),
};

const chVbus = new Chart($("ch-vbus"),
  [{ key: "vbus_mv", label: "VBUS", color: C.info, width: 2 }],
  { minSpan: 2000 });
const chRpm = new Chart($("ch-rpm"), [
  { key: "enc_rpm_filt",  label: "mesuré (filt)", color: C.info, width: 2 },
  { key: "enc_rpm_raw",   label: "mesuré (brut)", color: C.dim },
  { key: "commanded_rpm", label: "commandé",      color: C.copperHi },
  { key: "target_rpm",    label: "cible",         color: C.ok },
], { minSpan: 50 });
const chErr = new Chart($("ch-err"), [
  { key: "can_error_count", label: "erreurs CAN", color: C.fault },
  { key: "enc_index_err",   label: "erreurs index", color: C.warn },
  { key: "enc_z_glitch",    label: "glitchs Z",   color: C.info },
  { key: "brake_evt_total", label: "évén. brake", color: C.copper },
], { minSpan: 4 });

function legend(el, chart) {
  el.innerHTML = chart.series.map(s =>
    `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("");
}
legend($("lg-rpm"), chRpm);
legend($("lg-err"), chErr);

/* ======================= Rendu d'état ======================= */
function setBadge(el, txt, cls) { el.textContent = txt; el.className = "badge " + cls; }
function setNode(id, cls) { $(id).setAttribute("class", "node " + cls); }

function render(snap) {
  const f = snap.frame, st = snap.stats;
  const chartsVBusMv = f ? f.vbus_mv : null;

  /* --- badges --- */
  setBadge($("b-spi"), st.spi_online ? "SPI ONLINE" : "SPI OFFLINE",
           st.spi_online ? "ok" : "fault");
  setBadge($("b-mode"), st.mode === "simulation" ? "SIMULATION" : "SPI RÉEL", "mode");
  $("btn-sim").classList.toggle("on", st.mode === "simulation");

  if (f) {
    setBadge($("b-fesc"), f.fesc_online ? "FSESC ONLINE" : "FSESC OFFLINE",
             f.fesc_online ? "ok" : "fault");
    setBadge($("b-enc"), f.enc_healthy ? "ENCODEUR OK" : "ENCODEUR LOST",
             f.enc_healthy ? "ok" : "fault");
    setBadge($("b-index"), f.enc_index_valid ? "INDEX VALID" : "NO INDEX",
             f.enc_index_valid ? "ok" : "warn");
    const blc = ["ok", "warn", "warn", "fault", "fault"][f.brake_level];
    setBadge($("b-brake"), "BRAKE " + f.brake_level_txt, blc);
    const mst = f.motor_state_txt;
    setBadge($("b-motor"), "MOTEUR " + mst,
             mst === "FAULT" ? "fault" :
             mst === "RUNNING" ? "ok" :
             mst === "DERATING" ? "warn" : "info");

    /* --- jauges --- */
    gauges.vbus.set(f.vbus_v);
    gauges.rpm.set(Math.abs(f.measured_rpm), null,
                   f.measured_rpm < 0 ? "sens inverse" : "encodeur");
    gauges.cmd.set(Math.abs(f.commanded_rpm), C.copperHi,
                   `cible ${f.target_rpm}`);
    gauges.brake.set(f.brake_level, LEVEL_COLOR[f.brake_level],
                     f.brake_level_txt);
    gauges.can.setText(f.fesc_online ? "ON" : "OFF",
                       f.fesc_online ? C.ok : C.fault,
                       `err ${f.can_error_count}`);

    /* --- synoptique --- */
    $("sy-vbus").textContent = f.vbus_v.toFixed(1) + " V";
    $("sy-fesc").textContent = f.fesc_online ? f.motor_state_txt : "OFFLINE";
    $("sy-rpm").textContent = f.measured_rpm + " rpm";
    $("sy-enc").textContent = f.enc_index_valid ? "INDEX ✓" : "NO INDEX";
    $("sy-brake").textContent = f.ovp_active ? "OVP · DUMP ACTIF"
                                             : f.brake_level_txt;

    setNode("nd-bus", f.vbus_v >= 58 ? "fault" : f.vbus_v >= 54 ? "warn" : "ok");
    setNode("nd-fsesc", !f.fesc_online ? "fault" :
            f.motor_state_txt === "FAULT" ? "fault" : "ok");
    setNode("nd-motor", f.motor_state_txt === "FAULT" ? "fault" :
            f.motor_state_txt === "DERATING" ? "warn" : "ok");
    setNode("nd-enc", "small " + (!f.enc_healthy ? "fault" :
            f.enc_index_valid ? "ok" : "warn"));
    setNode("nd-brake", "small " +
            (f.brake_level >= 3 ? "fault" : f.brake_level >= 1 ? "warn" : "ok"));

    const running = ["STARTING", "RUNNING", "DERATING", "STOPPING",
                     "INDEX_SEARCH"].includes(f.motor_state_txt);
    $("lk-bus-fsesc").setAttribute("class", "link power" + (running ? " flow" : ""));
    $("lk-fsesc-mot").setAttribute("class", "link power" + (running ? " flow" : ""));
    $("lk-bus-brake").setAttribute("class", "link dump" + (f.ovp_active ? " hot" : ""));
    $("lk-mot-enc").setAttribute("class", "link signal" +
        (Math.abs(f.measured_rpm) > 5 ? " live" : ""));
    $("lk-can").setAttribute("class", "link signal dashed" +
        (f.fesc_online ? " live" : ""));

    /* --- graphiques --- */
    const t = st.last_valid_ts;
    chVbus.push(t, f); chRpm.push(t, f); chErr.push(t, f);

    /* --- détails --- */
    renderDetail(f);
  }

  gauges.spi.set(st.poll_hz || 0, st.spi_online ? C.ok : C.fault,
                 st.mode === "simulation" ? "simulation" : "spidev");

  /* --- alarmes --- */
  const al = $("alarms");
  $("alarm-count").textContent = snap.alarms.length;
  $("alarm-count").className = "pill" + (snap.alarms.length ? " hot" : "");
  al.innerHTML = snap.alarms.length
    ? snap.alarms.map(a => `<li class="${a.level}">${a.msg}</li>`).join("")
    : `<li class="empty">Aucune alarme — système nominal</li>`;

  /* --- timeline --- */
  $("events").innerHTML = [...snap.events].reverse().map(e => {
    const d = new Date(e.ts * 1000);
    const ts = d.toTimeString().slice(0, 8);
    return `<li class="${e.level}"><span class="e-ts">${ts}</span>` +
           `<span class="e-src">${e.source}</span>` +
           `<span class="e-msg">${e.msg}</span></li>`;
  }).join("");

  /* --- footer SPI --- */
  $("s-mode").textContent = st.mode === "simulation" ? "SIMULATION" : "SPI";
  $("s-frames").textContent = `${st.rx_valid}/${st.rx_total}`;
  $("s-crc").textContent = st.crc_errors;
  $("s-io").textContent = st.io_errors;
  $("s-hz").textContent = (st.poll_hz || 0) + " Hz";
  $("s-lat").textContent = st.poll_latency_ms + " ms";
  $("s-seq").textContent = f ? f.seq : "—";
  $("s-age").textContent = st.last_valid_ts
    ? ((Date.now() / 1000 - st.last_valid_ts).toFixed(1) + " s") : "—";
  const crcEl = $("s-crcok");
  if (st.rx_valid === 0) { crcEl.textContent = "CRC —"; crcEl.className = "crc-badge"; }
  else if (st.crc_errors === 0 || st.spi_online) {
    crcEl.textContent = "CRC OK"; crcEl.className = "crc-badge ok";
  } else { crcEl.textContent = "CRC ERREUR"; crcEl.className = "crc-badge bad"; }
  void chartsVBusMv;
}

const DETAIL_MAP = [
  ["— BRAKE CHOPPER —", null],
  ["État / défaut", f => `${f.brake_state_txt} / ${f.brake_fault_txt}`],
  ["OVP · FORCE · CMD/PIN", f =>
      `${f.ovp_active} · ${f.brake_force} · ${f.brake_cmd_logical}/${f.brake_cmd_pin}`],
  ["Évén. fenêtre / total", f => `${f.brake_evt_window} / ${f.brake_evt_total}`],
  ["Durées dern/max/cumul", f =>
      `${f.brake_last_dur_ms} / ${f.brake_max_dur_ms} / ${f.brake_total_ms} ms`],
  ["Temp. dump", f => f.temp_dump_na ? "N/A (pas de capteur)" : f.temp_dump / 10 + " °C"],
  ["— ENCODEUR —", null],
  ["Position", f => f.enc_position_ticks + " ticks"],
  ["RPM filt / brut", f => `${f.enc_rpm_filt} / ${f.enc_rpm_raw}`],
  ["Z ok/glitch/stale", f => `${f.enc_z_count} / ${f.enc_z_glitch} / ${f.enc_z_stale}`],
  ["Erreurs d'index", f => f.enc_index_err],
  ["— MOTEUR / CAN —", null],
  ["Défaut moteur", f => f.motor_fault_txt],
  ["Cible / commandé / mesuré", f =>
      `${f.target_rpm} / ${f.commanded_rpm} / ${f.measured_rpm}`],
  ["CAN tx / rx / err", f =>
      `${f.can_tx_count} / ${f.can_rx_count} / ${f.can_error_count}`],
];
function renderDetail(f) {
  $("detail").innerHTML = DETAIL_MAP.map(([k, fn]) =>
    fn === null ? `<span class="sep">${k}</span>`
                : `<span class="k">${k}</span><span class="v">${fn(f)}</span>`
  ).join("");
}

/* ======================= WebSocket ======================= */
let ws, wsRetry = 500;
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.history) { chVbus.seed(msg.history); chRpm.seed(msg.history);
                       chErr.seed(msg.history); return; }
    render(msg);
  };
  ws.onopen = () => { wsRetry = 500; };
  ws.onclose = () => {
    setBadge($("b-spi"), "DASHBOARD OFFLINE", "fault");
    setTimeout(connect, wsRetry);
    wsRetry = Math.min(wsRetry * 2, 5000);
  };
}
connect();
setInterval(() => { if (ws && ws.readyState === 1) ws.send("k"); }, 20000);

/* ======================= Boutons ======================= */
$("btn-sim").onclick = async () => {
  const wantSim = !$("btn-sim").classList.contains("on");
  const r = await fetch("/api/mode", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sim: wantSim }) }).then(r => r.json());
  if (r.error) alert(r.error);
};
$("btn-reset").onclick = async () => {
  await fetch("/api/reset-graphs", { method: "POST" });
  chVbus.clear(); chRpm.clear(); chErr.clear();
};
$("btn-csv").onclick = () => { location.href = "/api/export.csv"; };
$("btn-log").onclick = () => { location.href = "/api/log"; };
$("btn-kiosk").onclick = () => {
  document.fullscreenElement ? document.exitFullscreen()
                             : document.documentElement.requestFullscreen();
};
