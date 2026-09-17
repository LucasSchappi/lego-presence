#!/usr/bin/env python3
"""Local helper for base.html: serves this folder and clicks the Mbit app's ◀ / ▶ buttons.

    python3 keys.py --calibrate          # once: point at Mbit's ◀ and ▶ buttons
    python3 keys.py                      # then open http://localhost:8765/base.html

While the remote person holds ◀ or ▶, the helper holds the mouse button down on the
matching on-screen button in Mbit, then puts the pointer back where it was.
If you move or resize the Mbit window, run --calibrate again.

    python3 keys.py --mode keys          # press the real ← / → keys instead of clicking
    python3 keys.py --allow-origin https://you.github.io   # if base.html is hosted elsewhere

Standard library only. Listens on 127.0.0.1, so nothing else on the network can use it.
"""

import argparse
import ctypes
import ctypes.util
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

AUTO_RELEASE_SECONDS = 0.6  # let go if base.html stops refreshing (tab closed, crash, ...)
DEFAULT_APP = "com.yahboom.bstmbit"  # Yahboom Mbit
FOLDER = os.path.dirname(os.path.abspath(__file__))
BUTTONS_FILE = os.path.join(FOLDER, "buttons.json")


# ---- Platform input -------------------------------------------------------

class MacInput:
    KEYS = {"left": 123, "right": 124}
    MOUSE_MOVED, LEFT_DOWN, LEFT_UP = 5, 1, 2

    class CGPoint(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

    def __init__(self, app_id):
        q = ctypes.cdll.LoadLibrary(
            "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
        cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
        P = self.CGPoint
        q.CGEventCreate.restype = ctypes.c_void_p
        q.CGEventCreate.argtypes = [ctypes.c_void_p]
        q.CGEventGetLocation.restype = P
        q.CGEventGetLocation.argtypes = [ctypes.c_void_p]
        q.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
        q.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
        q.CGEventCreateMouseEvent.restype = ctypes.c_void_p
        q.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, P, ctypes.c_uint32]
        q.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        q.CGWarpMouseCursorPosition.argtypes = [P]
        q.AXIsProcessTrusted.restype = ctypes.c_bool
        cf.CFRelease.argtypes = [ctypes.c_void_p]
        self.q, self.cf, self.app_id = q, cf, app_id

    def trusted(self):
        return self.q.AXIsProcessTrusted()

    def _post(self, event):
        self.q.CGEventPost(0, event)  # kCGHIDEventTap
        self.cf.CFRelease(event)

    def key(self, direction, down):
        self._post(self.q.CGEventCreateKeyboardEvent(None, self.KEYS[direction], down))

    def mouse_position(self):
        event = self.q.CGEventCreate(None)
        point = self.q.CGEventGetLocation(event)
        self.cf.CFRelease(event)
        return point.x, point.y

    def mouse(self, x, y, down):
        point = self.CGPoint(x, y)
        if down:
            self._post(self.q.CGEventCreateMouseEvent(None, self.MOUSE_MOVED, point, 0))
        self._post(self.q.CGEventCreateMouseEvent(None, self.LEFT_DOWN if down else self.LEFT_UP, point, 0))

    def move_pointer(self, x, y):
        self.q.CGWarpMouseCursorPosition(self.CGPoint(x, y))

    def bring_app_to_front(self):
        front = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()
        info = subprocess.run(["lsappinfo", "info", "-only", "bundleid", front],
                              capture_output=True, text=True).stdout
        if f'"{self.app_id}"' in info:
            return
        subprocess.run(["open", "-b", self.app_id], check=False)
        time.sleep(0.4)  # give the window a moment to come forward


class WindowsInput:
    KEYS = {"left": 0x25, "right": 0x27}

    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    def __init__(self, app_id):
        self.user32 = ctypes.windll.user32

    def trusted(self):
        return True

    def key(self, direction, down):
        self.user32.keybd_event(self.KEYS[direction], 0, 0x0001 | (0 if down else 0x0002), 0)

    def mouse_position(self):
        p = self.POINT()
        self.user32.GetCursorPos(ctypes.byref(p))
        return p.x, p.y

    def mouse(self, x, y, down):
        self.user32.SetCursorPos(int(x), int(y))
        self.user32.mouse_event(0x0002 if down else 0x0004, 0, 0, 0, 0)

    def move_pointer(self, x, y):
        self.user32.SetCursorPos(int(x), int(y))

    def bring_app_to_front(self):
        pass  # the click itself focuses the window


class LinuxInput:
    KEYS = {"left": "Left", "right": "Right"}

    def __init__(self, app_id):
        if not shutil.which("xdotool"):
            sys.exit("Install xdotool first (e.g. sudo apt install xdotool).")

    def trusted(self):
        return True

    def _xdo(self, *args):
        return subprocess.run(["xdotool", *map(str, args)], capture_output=True, text=True).stdout

    def key(self, direction, down):
        self._xdo("keydown" if down else "keyup", self.KEYS[direction])

    def mouse_position(self):
        parts = dict(p.split(":") for p in self._xdo("getmouselocation").split()[:2])
        return int(parts["x"]), int(parts["y"])

    def mouse(self, x, y, down):
        self._xdo("mousemove", int(x), int(y))
        self._xdo("mousedown" if down else "mouseup", 1)

    def move_pointer(self, x, y):
        self._xdo("mousemove", int(x), int(y))

    def bring_app_to_front(self):
        pass


def make_input(app_id):
    if sys.platform == "darwin":
        return MacInput(app_id)
    if sys.platform.startswith("win"):
        return WindowsInput(app_id)
    return LinuxInput(app_id)


# ---- What "press left/right" means ----------------------------------------

class KeyPresser:
    def __init__(self, inp):
        self.inp = inp

    def ready(self):
        return True, "ok"

    def down(self, direction):
        self.inp.key(direction, True)

    def up(self, direction):
        self.inp.key(direction, False)


class ButtonClicker:
    def __init__(self, inp):
        self.inp = inp
        self.buttons = load_buttons()
        self.saved_pointer = None

    def ready(self):
        if not self.buttons:
            return False, "not calibrated: run python3 keys.py --calibrate"
        return True, "ok"

    def down(self, direction):
        if not self.buttons:
            return
        self.inp.bring_app_to_front()
        self.saved_pointer = self.inp.mouse_position()
        self.inp.mouse(*self.buttons[direction], True)

    def up(self, direction):
        if not self.buttons:
            return
        self.inp.mouse(*self.buttons[direction], False)
        if self.saved_pointer:
            self.inp.move_pointer(*self.saved_pointer)
            self.saved_pointer = None


def load_buttons():
    try:
        with open(BUTTONS_FILE) as f:
            data = json.load(f)
        return {d: tuple(data[d]) for d in ("left", "right")}
    except (OSError, ValueError, KeyError):
        return None


def calibrate(inp):
    print("Open Mbit and connect it to the stand. Keep this terminal window visible next to it.\n")
    buttons = {}
    for direction, arrow in (("left", "◀"), ("right", "▶")):
        input(f"Move the mouse over Mbit's {arrow} button (don't click), then press Enter here… ")
        buttons[direction] = inp.mouse_position()
        print(f"  {direction}: x={buttons[direction][0]:.0f} y={buttons[direction][1]:.0f}")
    with open(BUTTONS_FILE, "w") as f:
        json.dump(buttons, f, indent=2)
    print(f"\nSaved to {BUTTONS_FILE}. Now run: python3 keys.py")


class HoldState:
    """Tracks the held direction and lets go if refreshes stop arriving."""

    def __init__(self, presser):
        self.presser = presser
        self.lock = threading.Lock()
        self.held = None
        self.last_seen = 0.0
        threading.Thread(target=self._watchdog, daemon=True).start()

    def down(self, direction):
        with self.lock:
            self.last_seen = time.monotonic()
            if self.held == direction:
                return
            if self.held:
                self.presser.up(self.held)
            self.presser.down(direction)
            self.held = direction
            print(f"hold {direction}")

    def up(self, direction=None):
        with self.lock:
            if not self.held or (direction and direction != self.held):
                return
            self.presser.up(self.held)
            print(f"let go {self.held}")
            self.held = None

    def _watchdog(self):
        while True:
            time.sleep(0.1)
            if self.held and time.monotonic() - self.last_seen > AUTO_RELEASE_SECONDS:
                print("auto-release (no refresh)")
                self.up()


# ---- HTTP -----------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    hold: HoldState
    allowed_origins: set

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        host = urlparse(origin).hostname
        return host in ("localhost", "127.0.0.1") or origin in self.allowed_origins

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and self._origin_ok():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        self.send_response(204 if self._origin_ok() else 403)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if not self._origin_ok():
            return self._reply(403, "origin not allowed (use --allow-origin)")
        url = urlparse(self.path)
        if url.path == "/ping":
            ready, text = self.hold.presser.ready()
            return self._reply(200 if ready else 409, text)
        if url.path == "/press":
            query = parse_qs(url.query)
            direction = query.get("dir", [""])[0]
            state = query.get("state", [""])[0]
            if direction not in ("left", "right") or state not in ("down", "up"):
                return self._reply(400, "bad dir/state")
            if state == "down":
                self.hold.down(direction)
            else:
                self.hold.up(direction)
            return self._reply(200, "ok")
        self._reply(404, "not found")

    def _reply(self, code, text):
        body = text.encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # keep the terminal readable; presses are printed instead


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--calibrate", action="store_true", help="record where Mbit's ◀ and ▶ buttons are")
    parser.add_argument("--mode", choices=["click", "keys"], default="click")
    parser.add_argument("--app", default=DEFAULT_APP, help="macOS bundle id of the app to bring to the front")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--allow-origin", action="append", default=[],
                        help="extra site allowed to use the helper, e.g. https://you.github.io")
    args = parser.parse_args()

    inp = make_input(args.app)
    if not inp.trusted():
        print("!! macOS is blocking mouse/key control. Open System Settings > Privacy & Security >\n"
              "   Accessibility, allow your terminal app, then restart this script.")
    if args.calibrate:
        return calibrate(inp)

    presser = ButtonClicker(inp) if args.mode == "click" else KeyPresser(inp)
    ready, text = presser.ready()
    if not ready:
        print(f"!! {text}")
    elif args.mode == "click":
        print(f"Clicking Mbit buttons at {presser.buttons['left']} (◀) and {presser.buttons['right']} (▶)")

    Handler.hold = HoldState(presser)
    Handler.allowed_origins = {o.rstrip("/") for o in args.allow_origin}
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=FOLDER))
    print(f"Open http://localhost:{args.port}/base.html  (Ctrl+C to quit)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        Handler.hold.up()


if __name__ == "__main__":
    main()
