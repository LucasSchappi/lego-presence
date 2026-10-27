# Lego Presence

Browser-based remote control for a micro:bit + Lego Technic phone stand. There's no video or audio:
the phone just drives the stand, by itself (🎲 Auto) or from a remote control page.

```
 Remote control (drive.html) ──── commands ────  Phone on stand (phone.html) ──► Bluetooth ──► micro:bit
            │                                                                    (or)
            └──── commands ────  Computer (base.html) ──► Bluetooth ──► micro:bit
```

**Either the phone or the computer can hold the Bluetooth link to the micro:bit.** The phone
doing it means no computer is needed at all — but that needs a browser with Web Bluetooth:
Chrome on Android, or an app like [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)
on iPhone, since iPhone Safari can't do Bluetooth. The phone page shows a **🔵 Connect stand**
button when its browser can.

- Commands travel **directly between devices** over WebRTC.
- The free PeerJS cloud server is used only to introduce the devices to each other (signalling).
- All the devices join the same **room name**.

## 1. Host the site (HTTPS is required)

Browsers only allow Bluetooth and keeping the screen awake on HTTPS pages, so the phone and the
remote control need a hosted copy. Any static host works, for example:

- **Netlify Drop**: drag this folder onto https://app.netlify.com/drop
- **GitHub Pages**: push the folder to a repo, then turn on Pages in Settings

The computer doesn't need the hosted copy (see step 2).

## 2. Whoever drives the stand: the phone, or a computer

**Option A — the phone (no computer needed).** Open `phone.html` in Chrome on Android or Bluefy
on iPhone, tap **Start**, then **🔵 Connect stand** and pick your micro:bit.

**Option B — a computer.** Close the Mbit app (the micro:bit only accepts one Bluetooth
connection), then in **Chrome or Edge** open:

**https://lucasschappi.github.io/lego-presence/base.html?room=YOURROOM**

Click **Connect micro:bit**, pick your micro:bit, and use **Test ◀ / Test ▶** to check the stand moves.

Either way the same commands go out over the micro:bit's UART service, exactly what the Mbit app sends:

| Button | Command |
|---|---|
| ◀ pressed | `C#` |
| ▶ pressed | `D#` |
| released | `0#` |

(Mbit's spin buttons use `E#` / `F#`; the computer page lets you change the commands.) If the
micro:bit drops out, both pages keep trying to reconnect.

The drive page also has every other button in the Mbit app, sending the app's own commands:

<details><summary>All Mbit commands</summary>

| Buttons | Commands |
|---|---|
| ▲ ▼ ◀ ▶, spin ↺ ↻ (held) | `A#` `B#` `C#` `D#`, `E#` `F#`; released: `0#` |
| Music: Do Re Mi Fa So La Ti high Do (held) | `1#` … `8#`; released: `O#` |
| Music: black keys (held) | `B1#` … `B5#`; released: `O#` |
| Car lights: red, green, blue, yellow, cyan, pink (switches), off | `G#` `H#` `I#` `J#` `K#` `L#`; off: `M#` |
| RGB lights: flowing, marquee, breathing (switches) | `N#` `P#` `Q#`; off: `W#` |
| RGB lights: change colour | `R#` |
| Mode: tracking, obstacle avoidance, following (switches) | `S#` `T#` `U#`; off: `V#` |

Only one light colour, one light effect and one mode can be on at a time; turning one on switches
the other off first. Tapping the one that's on turns it off.
The `keys.py` and Event service outputs on the computer page only do ◀ ▶.

</details>

### Other outputs on the computer page

| Output | What it does |
|---|---|
| **Click the Mbit app's ◀ ▶ buttons** | `keys.py` holds the mouse on Mbit's on-screen buttons (see below) |
| **Web Bluetooth → Event service** | Sends (source, value) events, for your own micro:bit program |
| **Nothing** | Only shows the arrows on screen, for testing the connection |

<details><summary>Using keys.py with the Mbit app instead</summary>

```sh
python3 keys.py --calibrate     # hover over Mbit's ◀, press Enter; hover over ▶, press Enter
python3 keys.py                 # then open http://localhost:8765/base.html?room=YOURROOM
```

- Don't move or resize the Mbit window after calibrating.
- The helper takes over the mouse while someone drives.
- macOS: allow your terminal app under System Settings → Privacy & Security → Accessibility.
- `--mode keys` presses the ← / → keys instead.

</details>

## 3. Phone on the stand

Open **https://your-site/phone.html?room=YOURROOM** and tap **Start**. The phone never uses its camera
or mic. The screen stays awake and goes black apart from the small status chips at the top.

Once the phone is connected to the stand, **🎲 Auto** makes it move and change colour by itself, with
no driver or computer needed: every 1–10 s it either lights red, green or blue and goes forward then back
(0.5–2 s each way), or turns left, right for twice as long, then left again. A driver steering switches it off.

## 4. Remote control

Open **https://your-site/drive.html?room=YOURROOM** and click **Start**. To move the stand,
hold ▲ ▼ ◀ ▶ or the spin buttons ↺ ↻ (or use the arrow keys). The **Music**, **Car lights**, **RGB lights** and
**Mode** tabs have the rest of the Mbit app's buttons. The status chips show whether the phone, the computer and
the stand are ready.

## Several drivers at once

Several people can open `drive.html` in the same room at the same time, and all of them can steer.
**The most recent button press wins**: if someone presses while another person is holding, they take
over. When they let go, the first person's hold carries on. Each driver's status shows who is steering.

## Safety

- If commands stop arriving for 0.5 s (dropped connection, closed tab), whichever page holds the
  Bluetooth link stops the stand and any note that's playing.
- The self-driving modes (tracking, obstacle avoidance, following) switch off when every driver has left.
- `keys.py` (if used) lets go of the mouse after 0.6 s without a refresh, and only listens on `127.0.0.1` and only accepts requests from localhost pages. To use a
  hosted `base.html` instead, add `--allow-origin https://your-site`.

## micro:bit code for the Event service mode (MakeCode)

The page's default mode needs no changes: it works with the program the Mbit app already talks to.
For your own program using the Event service (defaults: source 9010, values 1–4):

```js
control.onEvent(9010, EventBusValue.MICROBIT_EVT_ANY, function () {
    const v = control.eventValue()
    if (v == 1) { /* left pressed */ }
    else if (v == 3) { /* right pressed */ }
    else { /* 2 or 4: released, stop */ }
})
```

## Connecting across different networks (relay)

When everyone is on the same Wi-Fi, devices connect directly. When the remote control is somewhere
else (another house, mobile data), many routers and mobile networks block direct connections and the
controls never connect. The drive page then shows **"Phone: blocked between networks — needs a relay"**.

A TURN relay fixes this by passing the commands through a server when a direct route isn't possible
(direct connections are still used whenever they work). To set one up (free, 20 GB/month):

1. Sign up at https://www.metered.ca/stun-turn and create a TURN app.
2. Copy its credentials URL. It looks like
   `https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOUR_API_KEY`
3. Paste it into `config.js` as `turnCredentialsUrl`, then commit and push.

The key only hands out relay access, but the repo is public, so anyone who finds it could use your
monthly allowance. If that matters, make the repo private (GitHub Pages on private repos needs a paid plan)
or delete and recreate the key in Metered if it's abused.

## Limitations

- Without a relay (see above), the remote control only works when direct connections are possible.
  Some strict corporate or school networks block it even with a relay. 🎲 Auto needs no connection at all.
- The computer needs Chrome or Edge (Web Bluetooth). Safari and Firefox can't talk to the micro:bit.
