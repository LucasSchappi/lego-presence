# Lego Presence

Browser-based, peer-to-peer telepresence for a micro:bit + Lego Technic phone stand.

```
 Remote person (drive.html) ──── video + audio (both ways) ────  Phone on stand (phone.html)
            │
            └──── ◀ / ▶ commands ────  Computer (base.html) ──► Mbit app / micro:bit ──► stand
```

- Video, audio and commands travel **directly between devices** over WebRTC.
- The free PeerJS cloud server is used only to introduce the devices to each other
  (signalling). No video passes through it.
- All three devices join the same **room name**.

## 1. Host the site (HTTPS is required)

Browsers only allow camera and mic on HTTPS pages, so the phone and the remote person
need a hosted copy. Any static host works, for example:

- **Netlify Drop**: drag this folder onto https://app.netlify.com/drop
- **GitHub Pages**: push the folder to a repo, then turn on Pages in Settings

The computer doesn't need the hosted copy (see step 2).

## 2. Computer (Bluetooth base)

```sh
python3 keys.py
```

Open **http://localhost:8765/base.html?room=YOURROOM** in Chrome or Edge, then choose an output:

| Output | What it does | Use when |
|---|---|---|
| **Key presses → Mbit app** (default) | `keys.py` holds the real ← / → keys down while the remote person holds a button | The Mbit app already turns the stand with the arrow keys. **Keep the Mbit app as the focused window.** |
| **Web Bluetooth → UART** | Sends `L`, `R`, `S` (stop) lines to the micro:bit | You'd rather skip the Mbit app |
| **Web Bluetooth → Event service** | Sends (source, value) events | Same as above, using event blocks |
| **Nothing** | Only shows the arrows on screen | Testing the connection |

**macOS:** the first time, allow your terminal app under System Settings → Privacy & Security →
**Accessibility**, then restart `keys.py`. Without that permission, macOS silently ignores the key presses.

Use the **Test ◀ / Test ▶** buttons on the page to check that the stand moves before
bringing in the remote person.

## 3. Phone on the stand

Open **https://your-site/phone.html?room=YOURROOM**, tap **Start**, and allow the camera and mic.
The screen stays awake while the page is open. The phone shows the remote person full-screen
and sends its front camera back to them.

## 4. Remote person

Open **https://your-site/drive.html?room=YOURROOM** and click **Start**. To turn the stand,
hold ◀ / ▶ (or the arrow keys). The status chips show whether the phone, the computer and
the stand are ready.

## Safety

- If commands stop arriving for 0.5 s (dropped connection, closed tab), `base.html` stops the stand.
- `keys.py` also lets go of the key after 0.6 s without a refresh.
- `keys.py` only listens on `127.0.0.1` and only accepts requests from localhost pages. To use a
  hosted `base.html` instead, add `--allow-origin https://your-site`.

## micro:bit code for the Web Bluetooth modes (MakeCode)

The Mbit app and the browser can't both be connected to the micro:bit at the same time.

UART mode (needs the Bluetooth extension):

```js
bluetooth.startUartService()
bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    const cmd = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    if (cmd == "L") { /* motor left */ }
    else if (cmd == "R") { /* motor right */ }
    else { /* stop */ }
})
```

Event mode (the defaults on the page are source 9010, values 1–4):

```js
control.onEvent(9010, EventBusValue.MICROBIT_EVT_ANY, function () {
    const v = control.eventValue()
    if (v == 1) { /* left pressed */ }
    else if (v == 3) { /* right pressed */ }
    else { /* 2 or 4: released, stop */ }
})
```

## Limitations

- Connections use public STUN only, with no TURN relay. Most home and mobile networks work.
  Some strict corporate or school networks will block the video.
- Web Bluetooth needs Chrome or Edge on desktop. The key-press mode works in any browser on the computer.
