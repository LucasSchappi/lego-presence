#!/usr/bin/env python3
"""Local helper for base.html: serves this folder and presses the real <- / -> keys.

    python3 keys.py                      # then open http://localhost:8765/base.html
    python3 keys.py --allow-origin https://you.github.io   # if base.html is hosted elsewhere

The key goes to whichever window is focused, so keep the Mbit app in front.
Standard library only. Listens on 127.0.0.1, so nothing else on the network can press keys.
"""

import argparse
import ctypes
import ctypes.util
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


# ---- Platform key presses -------------------------------------------------

class MacKeys:
    CODES = {"left": 123, "right": 124}

    def __init__(self):
        q = ctypes.cdll.LoadLibrary(
            "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
        cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
        q.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
        q.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
        q.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        q.AXIsProcessTrusted.restype = ctypes.c_bool
        cf.CFRelease.argtypes = [ctypes.c_void_p]
        self.q, self.cf = q, cf
        if not q.AXIsProcessTrusted():
            print("!! macOS is blocking key presses. Open System Settings > Privacy & Security >\n"
                  "   Accessibility, allow your terminal app, then restart this script.")

    def send(self, direction, down):
        event = self.q.CGEventCreateKeyboardEvent(None, self.CODES[direction], down)
        self.q.CGEventPost(0, event)  # kCGHIDEventTap
        self.cf.CFRelease(event)


class WindowsKeys:
    CODES = {"left": 0x25, "right": 0x27}
    EXTENDED, KEYUP = 0x0001, 0x0002

    def __init__(self):
        self.user32 = ctypes.windll.user32

    def send(self, direction, down):
        flags = self.EXTENDED | (0 if down else self.KEYUP)
        self.user32.keybd_event(self.CODES[direction], 0, flags, 0)


class LinuxKeys:
    CODES = {"left": "Left", "right": "Right"}

    def __init__(self):
        if not shutil.which("xdotool"):
            sys.exit("Install xdotool first (e.g. sudo apt install xdotool).")

    def send(self, direction, down):
        subprocess.run(["xdotool", "keydown" if down else "keyup", self.CODES[direction]], check=False)


def make_keyboard():
    if sys.platform == "darwin":
        return MacKeys()
    if sys.platform.startswith("win"):
        return WindowsKeys()
    return LinuxKeys()


class KeyState:
    """Tracks the held key and releases it if refreshes stop arriving."""

    def __init__(self, keyboard):
        self.keyboard = keyboard
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
                self.keyboard.send(self.held, False)
            self.keyboard.send(direction, True)
            self.held = direction
            print(f"down {direction}")

    def up(self, direction=None):
        with self.lock:
            if not self.held or (direction and direction != self.held):
                return
            self.keyboard.send(self.held, False)
            print(f"up   {self.held}")
            self.held = None

    def _watchdog(self):
        while True:
            time.sleep(0.1)
            if self.held and time.monotonic() - self.last_seen > AUTO_RELEASE_SECONDS:
                print("auto-release (no refresh)")
                self.up()


# ---- HTTP -----------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    keys: KeyState
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
            return self._reply(200, "ok")
        if url.path == "/key":
            query = parse_qs(url.query)
            direction = query.get("dir", [""])[0]
            state = query.get("state", [""])[0]
            if direction not in ("left", "right") or state not in ("down", "up"):
                return self._reply(400, "bad dir/state")
            if state == "down":
                self.keys.down(direction)
            else:
                self.keys.up(direction)
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
        pass  # keep the terminal readable; key events are printed instead


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--allow-origin", action="append", default=[],
                        help="extra site allowed to press keys, e.g. https://you.github.io")
    args = parser.parse_args()

    Handler.keys = KeyState(make_keyboard())
    Handler.allowed_origins = {o.rstrip("/") for o in args.allow_origin}
    folder = os.path.dirname(os.path.abspath(__file__))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=folder))
    print(f"Open http://localhost:{args.port}/base.html  (Ctrl+C to quit)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        Handler.keys.up()


if __name__ == "__main__":
    main()
