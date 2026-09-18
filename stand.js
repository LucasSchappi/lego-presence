// Talking to the micro:bit, and deciding who gets to drive.
// Used by both the computer page (base.html) and the phone (phone.html).

const STAND_UUID = {
  uartService: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  eventService: 'e95d93af-251d-470a-a062-fa1922dfa9a8',
  clientEvent: 'e95d5404-251d-470a-a062-fa1922dfa9a8',
};

// What the Mbit app itself sends over the micro:bit's UART service.
const MBIT_COMMANDS = { left: 'C#', right: 'D#', stop: '0#' };

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

// Turns "left"/"right" from whoever is driving into commands, and stops the stand if the
// commands go quiet (dropped connection, closed tab). Several people can drive: the most
// recent press takes control, and the others' "still holding" refreshes can't steal it back.
class StandControl {
  constructor({ output, log = () => {}, onChange = () => {}, watchdogMs = 500 }) {
    this.output = output;
    this.log = log;
    this.onChange = onChange;
    this.watchdogMs = watchdogMs;
    this.active = null;     // 'left' | 'right'
    this.controller = null; // driver id
    this.timer = null;
  }

  move(driverId, dir, press = true) {
    if (dir !== 'left' && dir !== 'right') return;
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
