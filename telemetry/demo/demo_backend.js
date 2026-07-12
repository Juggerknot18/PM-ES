"use strict";

/* ======================= crc16.py ======================= */

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let byte = 0; byte < 256; byte++) {
    let crc = (byte << 8) & 0xFFFF;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xFFFF)
                           : ((crc << 1) & 0xFFFF);
    }
    t[byte] = crc;
  }
  return t;
})();

function crc16CcittFalse(bytes, len) {
  // CRC16-CCITT-FALSE : poly 0x1021, init 0xFFFF, sans réflexion ni XOR final.
  let crc = 0xFFFF;
  const n = (len === undefined) ? bytes.length : len;
  for (let i = 0; i < n; i++) {
    crc = (((crc << 8) & 0xFFFF) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 0xFF]) & 0xFFFF;
  }
  return crc;
}
// Vecteur de contrôle standard (identique au firmware)
console.assert(
  crc16CcittFalse(new TextEncoder().encode("123456789")) === 0x29B1,
  "CRC16-CCITT-FALSE : vecteur de contrôle invalide");

/* ======================= protocol.py ======================= */

const FRAME_SIZE = 100;
const TX_MAGIC = 0xA55A;
const PROTO_VERSION = 1;
const TEMP_NA = 0x7FFF;

const BRAKE_STATE = ["IDLE", "HW_ACTIVE", "SW_FORCED", "COOLDOWN", "FAULT"];
const BRAKE_FAULT = ["NONE", "OVP_TIMEOUT", "TOO_MANY_EVENTS",
                     "OVERTEMPERATURE", "FORCE_TIMEOUT", "INEFFECTIVE"];
const BRAKE_LEVEL = ["NORMAL", "WARNING", "DERATING", "FAULT", "CRITICAL"];
const MOTOR_STATE = ["OFF", "WAIT_BUS_READY", "ENCODER_INIT", "INDEX_SEARCH",
                     "ARMED", "STARTING", "RUNNING", "DERATING",
                     "STOPPING", "FAULT"];
const MOTOR_FAULT = ["NONE", "BUS_NOT_READY", "ENCODER_NO_INDEX",
                     "ENCODER_LOST", "CAN_TIMEOUT", "FSESC_FAULT",
                     "BRAKE_CRITICAL", "OVERSPEED",
                     "START_TIMEOUT", "STOP_TIMEOUT"];
const txt = (table, v) => (table[v] !== undefined ? table[v] : "?");

/* Layout binaire — offsets identiques à pi_spi_comm.h / protocol.py :
 *   0 u16 magic · 2 u8 version · 3 u8 seq · 4..11 8×u8 bloc brake
 *  12 u16 brake_evt_window · 14 i16 temp_dump · 16 5×u32 compteurs brake+vbus
 *  36 3×i32 enc pos/rpm · 48 2×u8 enc flags · 50 u16 rsv1 · 52 4×u32 enc Z
 *  68 4×u8 motor/fesc · 72 3×i32 rpm cibles · 84 3×u32 CAN
 *  96 u16 rsv3 · 98 u16 crc16 (CCITT-FALSE sur 0..97, little-endian). */

function encodeFrame(f) {
  const buf = new ArrayBuffer(FRAME_SIZE);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const LE = true;

  dv.setUint16(0, TX_MAGIC, LE);
  dv.setUint8(2, PROTO_VERSION);
  dv.setUint8(3, f.seq & 0xFF);
  dv.setUint8(4, f.brake_state);
  dv.setUint8(5, f.brake_fault);
  dv.setUint8(6, f.brake_level);
  dv.setUint8(7, f.ovp_active);
  dv.setUint8(8, f.brake_force);
  dv.setUint8(9, f.brake_cmd_logical);
  dv.setUint8(10, f.brake_cmd_pin);
  dv.setUint8(11, 0);                              // reserved0
  dv.setUint16(12, f.brake_evt_window, LE);
  dv.setInt16(14, f.temp_dump, LE);
  dv.setUint32(16, f.brake_evt_total, LE);
  dv.setUint32(20, f.brake_last_dur_ms, LE);
  dv.setUint32(24, f.brake_max_dur_ms, LE);
  dv.setUint32(28, f.brake_total_ms, LE);
  dv.setUint32(32, f.vbus_mv, LE);
  dv.setInt32(36, f.enc_position_ticks, LE);
  dv.setInt32(40, f.enc_rpm_filt, LE);
  dv.setInt32(44, f.enc_rpm_raw, LE);
  dv.setUint8(48, f.enc_index_valid);
  dv.setUint8(49, f.enc_healthy);
  dv.setUint16(50, 0, LE);                         // reserved1
  dv.setUint32(52, f.enc_z_count, LE);
  dv.setUint32(56, f.enc_z_glitch, LE);
  dv.setUint32(60, f.enc_index_err, LE);
  dv.setUint32(64, f.enc_z_stale, LE);
  dv.setUint8(68, f.motor_state);
  dv.setUint8(69, f.motor_fault);
  dv.setUint8(70, f.fesc_online);
  dv.setUint8(71, 0);                              // reserved2
  dv.setInt32(72, f.target_rpm, LE);
  dv.setInt32(76, f.commanded_rpm, LE);
  dv.setInt32(80, f.measured_rpm, LE);
  dv.setUint32(84, f.can_tx_count, LE);
  dv.setUint32(88, f.can_rx_count, LE);
  dv.setUint32(92, f.can_error_count, LE);
  dv.setUint16(96, 0, LE);                         // reserved3
  dv.setUint16(98, crc16CcittFalse(u8, FRAME_SIZE - 2), LE);
  return u8;
}

class FrameError extends Error {}

function decodeFrame(raw) {
  if (raw.length !== FRAME_SIZE)
    throw new FrameError(`taille ${raw.length} != ${FRAME_SIZE}`);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const LE = true;

  const magic = dv.getUint16(0, LE);
  if (magic !== TX_MAGIC)
    throw new FrameError(`magic 0x${magic.toString(16)} != 0xA55A`);
  const version = dv.getUint8(2);
  if (version !== PROTO_VERSION)
    throw new FrameError(`version ${version} != ${PROTO_VERSION}`);
  const crc = crc16CcittFalse(raw, FRAME_SIZE - 2);
  const crcFrame = dv.getUint16(98, LE);
  if (crc !== crcFrame)
    throw new FrameError(`CRC 0x${crc.toString(16)} != 0x${crcFrame.toString(16)}`);

  const d = {
    magic, version,
    seq: dv.getUint8(3),
    brake_state: dv.getUint8(4),
    brake_fault: dv.getUint8(5),
    brake_level: dv.getUint8(6),
    ovp_active: dv.getUint8(7),
    brake_force: dv.getUint8(8),
    brake_cmd_logical: dv.getUint8(9),
    brake_cmd_pin: dv.getUint8(10),
    reserved0: dv.getUint8(11),
    brake_evt_window: dv.getUint16(12, LE),
    temp_dump: dv.getInt16(14, LE),
    brake_evt_total: dv.getUint32(16, LE),
    brake_last_dur_ms: dv.getUint32(20, LE),
    brake_max_dur_ms: dv.getUint32(24, LE),
    brake_total_ms: dv.getUint32(28, LE),
    vbus_mv: dv.getUint32(32, LE),
    enc_position_ticks: dv.getInt32(36, LE),
    enc_rpm_filt: dv.getInt32(40, LE),
    enc_rpm_raw: dv.getInt32(44, LE),
    enc_index_valid: dv.getUint8(48),
    enc_healthy: dv.getUint8(49),
    reserved1: dv.getUint16(50, LE),
    enc_z_count: dv.getUint32(52, LE),
    enc_z_glitch: dv.getUint32(56, LE),
    enc_index_err: dv.getUint32(60, LE),
    enc_z_stale: dv.getUint32(64, LE),
    motor_state: dv.getUint8(68),
    motor_fault: dv.getUint8(69),
    fesc_online: dv.getUint8(70),
    reserved2: dv.getUint8(71),
    target_rpm: dv.getInt32(72, LE),
    commanded_rpm: dv.getInt32(76, LE),
    measured_rpm: dv.getInt32(80, LE),
    can_tx_count: dv.getUint32(84, LE),
    can_rx_count: dv.getUint32(88, LE),
    can_error_count: dv.getUint32(92, LE),
    reserved3: dv.getUint16(96, LE),
    crc16: crcFrame,
  };
  d.brake_state_txt = txt(BRAKE_STATE, d.brake_state);
  d.brake_fault_txt = txt(BRAKE_FAULT, d.brake_fault);
  d.brake_level_txt = txt(BRAKE_LEVEL, d.brake_level);
  d.motor_state_txt = txt(MOTOR_STATE, d.motor_state);
  d.motor_fault_txt = txt(MOTOR_FAULT, d.motor_fault);
  d.vbus_v = Math.round(d.vbus_mv / 10) / 100;
  d.temp_dump_na = (d.temp_dump === TEMP_NA);
  return d;
}

/* ======================= simulator.py ======================= */

const TICKS_PER_REV = 1440;
const POLE_RPM_NOISE = 3.0;
const uniform = (a, b) => a + Math.random() * (b - a);
const randint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const mono = () => performance.now() / 1000.0;     // time.monotonic()

class Simulator {
  constructor() {
    const t = mono();
    this.t0 = t; this.last = t; this.seq = 0;
    // État "physique"
    this.vbus = 50.0; this.actual_rpm = 0.0; this.cmd_rpm = 0.0;
    this.pos_ticks = 0.0;
    // État "firmware"
    this.motor_state = 0; this.motor_fault = 0;
    this.index_valid = false;
    this.z_count = 0; this.z_glitch = 0; this.idx_err = 0; this.z_stale = 0;
    this.brake_state = 0; this.brake_level = 0; this.brake_fault = 0;
    this.ovp = false;
    this.evt_total = 0; this.evt_window = 0;
    this.last_dur = 0; this.max_dur = 0; this.total_ms = 0;
    this.can_tx = 0; this.can_rx = 0; this.can_err = 0;
    this.target = 300;
    // Scénario régénération
    this.next_regen = t + uniform(15.0, 25.0);
    this.regen_until = 0.0; this.ovp_since = 0.0;
    this._state_since = t;
  }

  _enter(state) { this.motor_state = state; this._state_since = mono(); }

  _stepMotor(now, dt) {
    const st = this.motor_state;
    const elapsed = now - this._state_since;

    if (st === 0 && elapsed > 1.0) {                    // OFF -> start auto
      this._enter(1);
    } else if (st === 1 && elapsed > 0.5) {             // WAIT_BUS_READY
      this._enter(2);
    } else if (st === 2 && elapsed > 0.4) {             // ENCODER_INIT
      this._enter(3);                                   // INDEX_SEARCH
      this.cmd_rpm = 0.0;
    } else if (st === 3) {                              // INDEX_SEARCH
      this.cmd_rpm = Math.min(60.0, this.cmd_rpm + 200.0 * dt);
      if (!this.index_valid && this.pos_ticks > 700) {
        this.index_valid = true;
        this.z_count += 1;
        this.pos_ticks = 0.0;
        this._enter(4);                                 // ARMED
        this.cmd_rpm = 0.0;
      }
    } else if (st === 4 && elapsed > 0.3) {             // ARMED
      this._enter(5);                                   // STARTING
    } else if (st === 5) {                              // STARTING
      this.cmd_rpm = Math.min(this.target, this.cmd_rpm + 200.0 * dt);
      if (this.cmd_rpm >= this.target
          && Math.abs(this.actual_rpm - this.target) < 15) {
        this._enter(6);                                 // RUNNING
      }
    } else if (st === 6) {                              // RUNNING
      this.cmd_rpm = this.target;
      if (this.brake_level === 2) this._enter(7);       // DERATING
    } else if (st === 7) {                              // DERATING
      this.cmd_rpm = this.target * 0.5;
      if (this.brake_level < 2) this._enter(6);
    }
  }

  _stepPhysics(now, dt) {
    // Moteur 1er ordre (tau ~200 ms) + bruit de mesure
    this.actual_rpm += (this.cmd_rpm - this.actual_rpm) * dt / 0.2;
    this.pos_ticks += this.actual_rpm * TICKS_PER_REV / 60.0 * dt;
    if (this.index_valid && this.pos_ticks >= TICKS_PER_REV * this.z_count) {
      this.z_count += 1;
      if (Math.random() < 0.01) this.z_glitch += 1;     // glitch rare
    }

    // Régénération périodique : VBUS grimpe, OVP à 58, dump vers 54
    if (!this.ovp && now >= this.next_regen && this.motor_state === 6) {
      this.regen_until = now + uniform(0.8, 2.0);
      this.next_regen = now + uniform(18.0, 35.0);
    }

    const regen = now < this.regen_until;
    if (regen) this.vbus += 6.0 * dt;                   // montée régén
    else this.vbus += (50.0 - this.vbus) * dt / 0.8;    // retour nominal
    this.vbus += uniform(-0.05, 0.05);

    // Chopper matériel : trip 58 V, release 54 V
    if (!this.ovp && this.vbus >= 58.0) {
      this.ovp = true;
      this.ovp_since = now;
      this.brake_state = 1;                             // HW_ACTIVE
    }
    if (this.ovp) {
      this.vbus -= 12.0 * dt;                           // dump 10R
      if (this.vbus <= 54.0) {
        this.ovp = false;
        this.brake_state = 3;                           // COOLDOWN
        const dur = Math.trunc((now - this.ovp_since) * 1000);
        this.last_dur = dur;
        this.max_dur = Math.max(this.max_dur, dur);
        this.total_ms += dur;
        this.evt_total += 1;
        this.evt_window = Math.min(this.evt_window + 1, 15);
      }
    } else if (this.brake_state === 3 && (now - this.ovp_since) > 0.4) {
      this.brake_state = 0;
    }
    if (!this.ovp && Math.random() < 0.002)
      this.evt_window = Math.max(0, this.evt_window - 1);
    this.brake_level = this.evt_window >= 15 ? 2
                     : this.evt_window > 0 ? 1 : 0;

    // CAN : consigne @20 Hz + status @20 Hz, erreur rare
    this.can_tx += Math.max(1, Math.trunc(20 * dt));
    this.can_rx += Math.max(1, Math.trunc(20 * dt));
    if (Math.random() < 0.001) this.can_err += 1;
  }

  nextFrame() {
    const now = mono();
    const dt = Math.min(now - this.last, 0.5);
    this.last = now;

    this._stepMotor(now, dt);
    this._stepPhysics(now, dt);
    this.seq = (this.seq + 1) & 0xFF;

    const meas = Math.trunc(this.actual_rpm
                            + uniform(-POLE_RPM_NOISE, POLE_RPM_NOISE));
    return encodeFrame({
      seq: this.seq,
      brake_state: this.brake_state,
      brake_fault: this.brake_fault,
      brake_level: this.brake_level,
      ovp_active: this.ovp ? 1 : 0,
      brake_force: 0,
      brake_cmd_logical: this.ovp ? 1 : 0,
      brake_cmd_pin: this.ovp ? 1 : 0,
      brake_evt_window: this.evt_window,
      temp_dump: TEMP_NA,
      brake_evt_total: this.evt_total,
      brake_last_dur_ms: this.last_dur,
      brake_max_dur_ms: this.max_dur,
      brake_total_ms: this.total_ms,
      vbus_mv: Math.trunc(this.vbus * 1000),
      enc_position_ticks: Math.trunc(this.pos_ticks) & 0x7FFFFFFF,
      enc_rpm_filt: meas,
      enc_rpm_raw: meas + randint(-8, 8),
      enc_index_valid: this.index_valid ? 1 : 0,
      enc_healthy: 1,
      enc_z_count: this.z_count,
      enc_z_glitch: this.z_glitch,
      enc_index_err: this.idx_err,
      enc_z_stale: this.z_stale,
      motor_state: this.motor_state,
      motor_fault: this.motor_fault,
      fesc_online: this.motor_state >= 2 ? 1 : 0,
      target_rpm: this.target,
      commanded_rpm: Math.trunc(this.cmd_rpm),
      measured_rpm: meas,
      can_tx_count: this.can_tx,
      can_rx_count: this.can_rx,
      can_error_count: this.can_err,
    });
  }
}

/* ======================= models.py ======================= */

const HISTORY_LEN = 600;                 // 60 s @ 10 Hz
const EVENTS_LEN = 300;
const SERIES = ["vbus_mv", "enc_rpm_filt", "enc_rpm_raw", "commanded_rpm",
                "target_rpm", "can_error_count", "enc_index_err",
                "enc_z_glitch", "brake_evt_total"];
const epoch = () => Date.now() / 1000.0;              // time.time()

class TelemetryStore {
  constructor() {
    this.frame = null;
    this.prev = null;
    this.history = { t: [] };
    for (const s of SERIES) this.history[s] = [];
    this.events = [];
    this.log_lines = [];
    this.stats = {
      mode: "simulation",
      spi_online: false,
      rx_valid: 0, rx_total: 0,
      crc_errors: 0, io_errors: 0,
      last_valid_ts: 0.0,
      poll_hz: 0.0, poll_latency_ms: 0.0,
    };
    this._poll_times = [];
    this.event("dashboard", "info", "Dashboard démarré (démo GitHub Pages)");
  }

  event(source, level, msg) {
    const ts = epoch();
    this.events.push({ ts, source, level, msg });
    if (this.events.length > EVENTS_LEN) this.events.shift();
    const d = new Date(ts * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
                + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    this.log_lines.push(
      `${stamp} [${level.toUpperCase().padEnd(8)}] ${source}: ${msg}`);
    if (this.log_lines.length > 5000) this.log_lines.splice(0, 1000);
  }

  notePoll(latency_s) {
    const now = epoch();
    this._poll_times.push(now);
    if (this._poll_times.length > 20) this._poll_times.shift();
    this.stats.poll_latency_ms = Math.round(latency_s * 1000 * 100) / 100;
    if (this._poll_times.length >= 2) {
      const span = this._poll_times[this._poll_times.length - 1] - this._poll_times[0];
      if (span > 0)
        this.stats.poll_hz =
          Math.round((this._poll_times.length - 1) / span * 10) / 10;
    }
  }

  noteError(kind) {
    this.stats.rx_total += 1;
    this.stats[kind === "crc" ? "crc_errors" : "io_errors"] += 1;
  }

  pushFrame(frame) {
    const now = epoch();
    this.stats.rx_total += 1;
    this.stats.rx_valid += 1;
    this.stats.last_valid_ts = now;
    this.prev = this.frame;
    this.frame = frame;

    this.history.t.push(Math.round(now * 100) / 100);
    for (const s of SERIES) this.history[s].push(frame[s]);
    if (this.history.t.length > HISTORY_LEN) {
      this.history.t.shift();
      for (const s of SERIES) this.history[s].shift();
    }
    this._deriveEvents(frame);
  }

  _deriveEvents(f) {
    const p = this.prev;
    if (p === null) {
      this.event("système", "info", `Première trame valide (seq=${f.seq})`);
      return;
    }
    if (f.motor_state !== p.motor_state) {
      const lvl = f.motor_state_txt === "FAULT" ? "fault" : "info";
      this.event("moteur", lvl, `${p.motor_state_txt} -> ${f.motor_state_txt}`);
    }
    if (f.motor_fault !== p.motor_fault && f.motor_fault !== 0)
      this.event("moteur", "fault", `Défaut: ${f.motor_fault_txt}`);

    if (f.brake_level !== p.brake_level) {
      const lvl = f.brake_level >= 3 ? "fault"
                : f.brake_level >= 1 ? "warn" : "info";
      this.event("brake", lvl,
                 `Niveau ${p.brake_level_txt} -> ${f.brake_level_txt}`);
    }
    if (f.brake_fault !== p.brake_fault && f.brake_fault !== 0)
      this.event("brake", "fault", `Défaut: ${f.brake_fault_txt}`);
    if (f.ovp_active && !p.ovp_active)
      this.event("brake", "warn", "OVP active (chopper matériel ON)");
    if (!f.ovp_active && p.ovp_active)
      this.event("brake", "info", `OVP terminée (${f.brake_last_dur_ms} ms)`);
    if (f.brake_evt_total > p.brake_evt_total)
      this.event("brake", "info", `Événement chopper #${f.brake_evt_total}`);

    if (f.fesc_online !== p.fesc_online)
      this.event("fsesc", f.fesc_online ? "info" : "warn",
                 f.fesc_online ? "FSESC online" : "FSESC OFFLINE");
    if (f.can_error_count > p.can_error_count)
      this.event("can", "warn",
                 `Erreur CAN (+${f.can_error_count - p.can_error_count})`);

    if (f.enc_index_valid && !p.enc_index_valid)
      this.event("encodeur", "info", "Index Z trouvé, position référencée");
    if (!f.enc_healthy && p.enc_healthy)
      this.event("encodeur", "fault", "Encodeur non sain (ticks perdus)");
    if (f.enc_z_glitch > p.enc_z_glitch)
      this.event("encodeur", "warn", "Glitch Z rejeté");
  }

  alarms() {
    const out = [];
    if (!this.stats.spi_online)
      out.push({ level: "fault", msg: "Liaison STM32 perdue (SPI)" });
    const f = this.frame;
    if (f === null) return out;
    if (f.brake_level >= 4)
      out.push({ level: "fault", msg: "BRAKE CRITICAL — " + f.brake_fault_txt });
    else if (f.brake_level === 3)
      out.push({ level: "fault", msg: "Brake FAULT — " + f.brake_fault_txt });
    else if (f.brake_level === 2)
      out.push({ level: "warn", msg: "Brake DERATING" });
    if (f.motor_state_txt === "FAULT")
      out.push({ level: "fault", msg: "Moteur FAULT — " + f.motor_fault_txt });
    if (!f.fesc_online)
      out.push({ level: "warn", msg: "FSESC hors ligne" });
    if (!f.enc_healthy)
      out.push({ level: "fault", msg: "Encodeur non sain" });
    if (f.ovp_active)
      out.push({ level: "warn", msg: "OVP active — dump en cours" });
    return out;
  }

  snapshot() {
    return { frame: this.frame, stats: this.stats,
             alarms: this.alarms(), events: this.events.slice(-30) };
  }

  resetHistory() {
    this.history.t.length = 0;
    for (const s of SERIES) this.history[s].length = 0;
    this.event("dashboard", "info", "Graphiques réinitialisés");
  }

  exportCsv() {
    const rows = [["t", ...SERIES].join(",")];
    for (let i = 0; i < this.history.t.length; i++) {
      rows.push([this.history.t[i],
                 ...SERIES.map(s => this.history[s][i])].join(","));
    }
    return rows.join("\r\n") + "\r\n";
  }

  exportLog() { return this.log_lines.join("\n") + "\n"; }
}

/* ======================= main.py (boucle 10 Hz + WS + API) ======================= */

const POLL_HZ = 10.0;
const ONLINE_TIMEOUT_S = 0.5;

const store = new TelemetryStore();
const sim = new Simulator();
const clients = new Set();               // FakeWebSocket connectés

store.event("spi", "warn", "spidev indisponible : mode simulation automatique");
store.event("dashboard", "info", "Mode initial : SIMULATION");

function acquisitionTick() {
  const t0 = performance.now();
  store.stats.mode = "simulation";

  const raw = sim.nextFrame();
  try {
    // Le même chemin que le SPI réel : décodage + vérification CRC.
    const frame = decodeFrame(raw);
    store.pushFrame(frame);
    store.notePoll((performance.now() - t0) / 1000.0);
  } catch (e) {
    store.noteError("crc");
    if (store.stats.crc_errors % 25 === 1)
      store.event("spi", "warn", `Trame invalide : ${e.message}`);
  }

  store.stats.spi_online =
    (epoch() - store.stats.last_valid_ts) < ONLINE_TIMEOUT_S;

  const msg = JSON.stringify(store.snapshot());
  for (const ws of clients) ws._deliver(msg);
}
setInterval(acquisitionTick, 1000.0 / POLL_HZ);

/* --------- Shim WebSocket : remplace ws://<host>/ws --------- */

const RealWebSocket = window.WebSocket;

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;                 // CONNECTING
    this.onopen = null; this.onmessage = null;
    this.onclose = null; this.onerror = null;
    setTimeout(() => {
      this.readyState = 1;               // OPEN
      if (this.onopen) this.onopen({});
      // Historique complet à la connexion (remplit les graphiques)
      this._deliver(JSON.stringify({ history: store.history }));
      clients.add(this);
    }, 0);
  }
  _deliver(text) {
    if (this.readyState === 1 && this.onmessage)
      this.onmessage({ data: text });
  }
  send(_data) { /* keepalive client : ignoré, comme côté serveur */ }
  close() {
    this.readyState = 3;                 // CLOSED
    clients.delete(this);
    if (this.onclose) this.onclose({});
  }
}

window.WebSocket = function (url, protocols) {
  if (typeof url === "string" && new URL(url, location.href).pathname.endsWith("/ws"))
    return new FakeWebSocket(url);
  return protocols !== undefined ? new RealWebSocket(url, protocols)
                                 : new RealWebSocket(url);
};
window.WebSocket.prototype = RealWebSocket.prototype;
["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(
  (k, i) => { window.WebSocket[k] = i; });

/* --------- Shim fetch : /api/mode et /api/reset-graphs --------- */

const realFetch = window.fetch.bind(window);

window.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input.url;
  const path = new URL(url, location.href).pathname;

  if (path.endsWith("/api/mode")) {
    let body = {};
    try { body = JSON.parse((init && init.body) || "{}"); } catch (_e) {}
    const wantSim = body.sim !== false;
    if (!wantSim) {
      return Promise.resolve(jsonResponse({
        ok: false, sim: true,
        error: "Démo GitHub Pages : pas de matériel SPI, simulation uniquement.",
      }));
    }
    return Promise.resolve(jsonResponse({ ok: true, sim: true }));
  }
  if (path.endsWith("/api/reset-graphs")) {
    store.resetHistory();
    return Promise.resolve(jsonResponse({ ok: true }));
  }
  return realFetch(input, init);
};

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj),
    { status: 200, headers: { "Content-Type": "application/json" } });
}

/* --------- Boutons Export CSV / Journal : téléchargement Blob --------- */
/* app.js fait `location.href = "/api/export.csv"` : impossible en statique.
 * On re-binde ces deux boutons APRÈS l'exécution d'app.js (DOMContentLoaded
 * est déclenché une fois tous les scripts classiques exécutés). */

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

window.addEventListener("DOMContentLoaded", () => {
  const csv = document.getElementById("btn-csv");
  const log = document.getElementById("btn-log");
  if (csv) csv.onclick = () =>
    downloadText("pm_es_telemetry.csv", store.exportCsv(), "text/csv");
  if (log) log.onclick = () =>
    downloadText("pm_es_events.log", store.exportLog(), "text/plain");
});
