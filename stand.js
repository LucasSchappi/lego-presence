// Talking to the micro:bit, and deciding who gets to drive.
// Used by both the computer page (base.html) and the phone (phone.html).

const STAND_UUID = {
  uartService: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  eventService: 'e95d93af-251d-470a-a062-fa1922dfa9a8',
  clientEvent: 'e95d5404-251d-470a-a062-fa1922dfa9a8',
};

// Every button in the Yahboom Mbit app, and the text it writes to the micro:bit's UART service
// (read out of the app itself).
const MBIT = {
  // Held: the command goes out on press, and `release` on let go.
  move: {
    release: '0#',
    keys: { forward: 'A#', back: 'B#', left: 'C#', right: 'D#', spinLeft: 'E#', spinRight: 'F#' },
  },
  note: {
    release: 'O#',
    keys: {
      do: '1#', re: '2#', mi: '3#', fa: '4#', so: '5#', la: '6#', ti: '7#', highDo: '8#',
      doSharp: 'B1#', reSharp: 'B2#', faSharp: 'B3#', soSharp: 'B4#', laSharp: 'B5#',
    },
  },
  // Tapped.
  tap: { changeColor: 'R#' },
  // Tap to turn on, tap again to turn off. Only one of each can be on at a time.
  // `offButton` is a button that always sends `off`, even when we don't know what's on.
  switches: {
    light: {
      off: 'M#', offButton: 'lightsOff',
      keys: { red: 'G#', green: 'H#', blue: 'I#', yellow: 'J#', cyan: 'K#', pink: 'L#' },
    },
    effect: { off: 'W#', keys: { flow: 'N#', marquee: 'P#', breathe: 'Q#' } },
    mode: { off: 'V#', keys: { tracking: 'S#', avoid: 'T#', follow: 'U#' } },
  },
};

// A Bluetooth connection to the micro:bit that reconnects itself if the stand drops out.
class MicrobitLink {
  constructor({ log = () => {}, onStatus = () => {} } = {}) {
    this.log = log;
    this.onStatus = onStatus;
    this.device = null;
    this.uartRx = null;
    this.clientEvent = null;
    this.wanted = false; // false once the user disconnects, so we stop reconnecting
    this.writes = Promise.resolve();
    this.ready = false;
    this.text = MicrobitLink.supported ? 'micro:bit not connected' : 'No Web Bluetooth in this browser';
  }

  static get supported() {
    return !!navigator.bluetooth;
  }

  _set(ready, text) {
    this.ready = ready;
    this.text = text;
    this.onStatus(ready, text);
  }

  // Must be called from a click: browsers only show the device chooser on a real tap.
  async connect() {
    if (!MicrobitLink.supported) {
      this._set(false, 'No Web Bluetooth in this browser');
      throw new Error('this browser has no Web Bluetooth');
    }
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [STAND_UUID.uartService, STAND_UUID.eventService],
    });
    if (this.device && this.device !== device) this.device.gatt.disconnect();
    this.wanted = true;
    device.addEventListener('gattserverdisconnected', () => this._reconnect(device));
    await this._open(device);
  }

  async _open(device) {
    this._set(false, 'Connecting…');
    const server = await device.gatt.connect();
    this.device = device;
    this.uartRx = null;
    this.clientEvent = null;

    try {
      const uart = await server.getPrimaryService(STAND_UUID.uartService);
      // micro:bit swaps the usual Nordic RX/TX UUIDs, so pick whichever one is writable.
      for (const c of await uart.getCharacteristics()) {
        if (c.properties.write || c.properties.writeWithoutResponse) this.uartRx = c;
      }
    } catch { /* UART service not in this program */ }

    try {
      const events = await server.getPrimaryService(STAND_UUID.eventService);
      this.clientEvent = await events.getCharacteristic(STAND_UUID.clientEvent);
    } catch { /* Event service not in this program */ }

    this.log(`Connected to ${device.name}. UART: ${this.uartRx ? 'yes' : 'no'}, Event service: ${this.clientEvent ? 'yes' : 'no'}`);
    this._set(!!this.uartRx || !!this.clientEvent, this.uartRx || this.clientEvent ? 'micro:bit ready' : 'micro:bit has no usable service');
  }

  async _reconnect(device) {
    if (this.device === device) {
      this.device = null;
      this.uartRx = null;
      this.clientEvent = null;
    }
    this._set(false, 'micro:bit disconnected');
    this.log('micro:bit disconnected');
    // It may just be out of range or switched off and on: keep trying.
    for (let attempt = 1; this.wanted && !device.gatt.connected; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!this.wanted) return;
      try {
        await this._open(device);
      } catch (err) {
        if (attempt === 1 || attempt % 15 === 0) this.log(`Reconnecting to micro:bit… (${err.message})`);
      }
    }
  }

  disconnect() {
    this.wanted = false;
    this.device?.gatt.disconnect();
  }

  // GATT allows one operation at a time, so writes are queued.
  _write(characteristic, bytes) {
    this.writes = this.writes
      .then(() => (characteristic.properties.writeWithoutResponse
        ? characteristic.writeValueWithoutResponse(bytes)
        : characteristic.writeValueWithResponse(bytes)))
      .catch((err) => this.log(`Bluetooth write failed: ${err.message}`));
    return this.writes;
  }

  sendText(text) {
    if (!this.uartRx || !text) return;
    return this._write(this.uartRx, new TextEncoder().encode(text));
  }

  sendEvent(source, value) {
    if (!this.clientEvent) return;
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, Number(source), true);
    view.setUint16(2, Number(value), true);
    return this._write(this.clientEvent, bytes);
  }
}

// Turns held buttons (a direction, or a piano key) from whoever is driving into commands, and
// lets go if the commands go quiet (dropped connection, closed tab). Several people can drive:
// the most recent press takes control, and the others' "still holding" refreshes can't steal it back.
class StandControl {
  constructor({ output, keys = Object.keys(MBIT.move.keys), log = () => {}, onChange = () => {}, watchdogMs = 500 }) {
    this.output = output;
    this.keys = keys;
    this.log = log;
    this.onChange = onChange;
    this.watchdogMs = watchdogMs;
    this.active = null;     // one of keys
    this.controller = null; // driver id
    this.timer = null;
  }

  move(driverId, dir, press = true) {
    if (!this.keys.includes(dir)) return;
    if (!press && this.controller && this.controller !== driverId) return;
    this.controller = driverId;
    if (this.active !== dir) {
      this._halt(); // not stop(): that would drop whoever just took control
      this.active = dir;
      this.log(`▶ ${dir}`);
      this.output.start(dir);
      this.onChange(this);
    } else {
      this.output.refresh?.(dir);
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.log('Watchdog: no signal, stopping');
      this.stop();
    }, this.watchdogMs);
  }

  // Ends the move, but only for whoever is actually driving.
  stop(driverId = null) {
    if (driverId && this.controller !== driverId) return;
    clearTimeout(this.timer);
    this.controller = null;
    this._halt();
    this.onChange(this);
  }

  _halt() {
    if (!this.active) return;
    const dir = this.active;
    this.active = null;
    this.log('■ stop');
    this.output.stop(dir);
  }
}

// The Mbit app's tap buttons. The car light colours, the light effects and the self-driving
// modes are switches: only one of each can be on, and tapping the one that's on turns it off.
class StandTaps {
  constructor({ send, log = () => {}, onChange = () => {} }) {
    this.send = send;
    this.log = log;
    this.onChange = onChange;
    this.on = Object.fromEntries(Object.keys(MBIT.switches).map((g) => [g, null]));
  }

  tap(key) {
    if (Object.hasOwn(MBIT.tap, key)) {
      this.log(`● ${key}`);
      this.send(MBIT.tap[key]);
      return;
    }
    const offGroup = Object.keys(MBIT.switches).find((g) => MBIT.switches[g].offButton === key);
    if (offGroup) return this.turnOff(offGroup, true);
    const group = Object.keys(MBIT.switches).find((g) => Object.hasOwn(MBIT.switches[g].keys, key));
    if (!group) return;
    const wasOn = this.on[group];
    this.turnOff(group);
    if (wasOn === key) return;
    this.on[group] = key;
    this.log(`● ${key} on`);
    this.send(MBIT.switches[group].keys[key]);
    this.onChange(this);
  }

  turnOff(group, always = false) {
    if (!this.on[group] && !always) return;
    this.log(`○ ${this.on[group] || group} off`);
    this.on[group] = null;
    this.send(MBIT.switches[group].off);
    this.onChange(this);
  }
}

// Auto: every 1–10 s, either lights red, green or blue and goes forward then back for the same
// 0.5–2 s, or turns left for 0.5–2 s, right for twice that, then left again. It drives the stand
// like one more driver, so a real driver's press takes over.
class StandAuto {
  static ID = 'auto';

  constructor({ stand, taps, log = () => {}, onChange = () => {} }) {
    this.stand = stand;
    this.taps = taps;
    this.log = log;
    this.onChange = onChange;
    this.on = false;
    this.run = 0; // bumped on every start/stop, so a stopped run can't carry on
    this.timer = null;
    this.refresh = null;
  }

  set(on) {
    this.run++;
    clearTimeout(this.timer);
    this._release();
    if (this.on !== on) this.log(on ? '🎲 Auto on' : '🎲 Auto off');
    this.on = on;
    this.onChange(this);
    if (on) this._loop(this.run);
  }

  _hold(dir) {
    clearInterval(this.refresh);
    this.stand.move(StandAuto.ID, dir, true);
    // Keep refreshing like a held button does, or the stand's watchdog lets go.
    this.refresh = setInterval(() => this.stand.move(StandAuto.ID, dir, false), 150);
  }

  _release() {
    clearInterval(this.refresh);
    this.refresh = null;
    this.stand.stop(StandAuto.ID);
  }

  async _loop(run) {
    const rand = (min, max) => min + Math.random() * (max - min);
    const wait = (ms) => new Promise((r) => (this.timer = setTimeout(r, ms)));
    const hold = async (dir, ms) => {
      if (run !== this.run) return;
      this._hold(dir);
      await wait(ms);
    };
    while (run === this.run) {
      await wait(rand(1000, 10000));
      if (run !== this.run) return;
      if (Math.random() < 0.5) {
        const colour = ['red', 'green', 'blue'][Math.floor(Math.random() * 3)];
        // The colours are switches: tapping the one that's already lit would turn it off.
        if (this.taps.on.light !== colour) this.taps.tap(colour);
        const t = rand(500, 2000);
        await hold('forward', t);
        await hold('back', t);
      } else {
        const t = rand(500, 2000);
        await hold('left', t);
        await hold('right', 2 * t);
        await hold('left', t);
      }
      if (run === this.run) this._release();
    }
  }
}
