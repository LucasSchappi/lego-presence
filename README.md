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

**Close the Mbit app** (the micro:bit only accepts one Bluetooth connection), then in **Chrome or Edge** open:

**https://lucasschappi.github.io/lego-presence/base.html?room=YOURROOM**

Click **Connect micro:bit**, pick your micro:bit, and use **Test ◀ / Test ▶** to check the stand moves.
The page sends the same Bluetooth commands as the Mbit app, over the micro:bit's UART service:

| Button | Command |
|---|---|
| ◀ pressed | `C#` |
| ▶ pressed | `D#` |
| released | `0#` |

(Mbit's spin buttons use `E#` / `F#`; you can change the commands on the page.) If the micro:bit
drops out, the page keeps trying to reconnect until you click **Disconnect**.

### Other outputs

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

Open **https://your-site/phone.html?room=YOURROOM**, tap **Start**, and allow the camera and mic.
The screen stays awake while the page is open. The phone shows the remote person full-screen
and sends its front camera back to them.

## 4. Remote person

Open **https://your-site/drive.html?room=YOURROOM** and click **Start**. To turn the stand,
hold ◀ / ▶ (or the arrow keys). The status chips show whether the phone, the computer and
the stand are ready.

## How drivers appear on the phone

Before starting, each driver chooses a look (and can switch during the call from the menu under the video):

| Look | What the phone shows | Camera permission? |
|---|---|---|
| 📷 Camera | Their camera | Yes |
| 🙂 Animated face | A Lego head that copies their expressions (independent eyebrows, smiles, frowns, pursed lips, puffed cheeks, winks) and head movement. It learns their resting face in the first second; **😐 Reset face** relearns it | Yes, but the camera is only used on their device for face tracking (MediaPipe) and never sent |
| 🖼️ Picture | A picture they choose (remembered in that browser) | No |
| 🔤 Name only | Their name and initials | No |

The microphone is optional too ("Use my microphone" on the start screen).

## Several drivers at once

Up to **4** people can open `drive.html` in the same room at the same time:

- The phone shows everyone in a split-screen grid, labelled with the names they typed. The phone's
  upload is shared between them.
- Everyone sees the phone's camera and can steer. **The most recent button press wins**: if someone
  presses while another person is holding, they take over. When they let go, the first person's
  hold carries on. Each driver's status shows who is steering.
- A fifth driver sees "Phone: full" and joins automatically when a spot opens.

## Safety

- If commands stop arriving for 0.5 s (dropped connection, closed tab), `base.html` stops the stand.
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

When everyone is on the same Wi-Fi, devices connect directly. When the remote person is somewhere
else (their home, mobile data), many routers and mobile networks block direct connections and the
video never starts. The drive page then shows **"Phone: blocked between networks — needs a relay"**.

A TURN relay fixes this by passing the video through a server when a direct route isn't possible
(direct connections are still used whenever they work). To set one up (free, 20 GB/month):

1. Sign up at https://www.metered.ca/stun-turn and create a TURN app.
2. Copy its credentials URL. It looks like
   `https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOUR_API_KEY`
3. Paste it into `config.js` as `turnCredentialsUrl`, then commit and push.

The key only hands out relay access, but the repo is public, so anyone who finds it could use your
monthly allowance. If that matters, make the repo private (GitHub Pages on private repos needs a paid plan)
or delete and recreate the key in Metered if it's abused.

## Limitations

- Without a relay (see above), the video only works when direct connections are possible.
  Some strict corporate or school networks block the video even with a relay.
- The computer needs Chrome or Edge (Web Bluetooth). Safari and Firefox can't talk to the micro:bit.
