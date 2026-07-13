#!/usr/bin/env python3
"""Mock ESP32 server for the plotter web app. Stdlib only.

Serves the static app from web/ and implements the same API contract the
ESP32 firmware will expose later:

  GET    /api/board  -> {"drawings": [...]}     board state
  POST   /api/board  -> append one drawing record (JSON body)
  POST   /api/print  -> receive gcode (text body)
                        mock: saved to server/prints/<timestamp>.gcode
                        ESP32: streamed to the SKR 1.4 over UART
  DELETE /api/board  -> clear board state (new sheet of paper)
  GET    /api/status -> {"state","line","error","ip","rssi"} job status
                        (mock plots instantly: always idle, never an error)

Run:  python3 server/server.py [port]
"""
import json
import pathlib
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent
WEB_DIR = ROOT.parent / "web"
BOARD_FILE = ROOT / "board.json"
PRINTS_DIR = ROOT / "prints"

_lock = threading.Lock()
_status = {"line": 0}  # lines of the last received print job


def load_board():
    if BOARD_FILE.exists():
        return json.loads(BOARD_FILE.read_text())
    return {"drawings": []}


def save_board(board):
    BOARD_FILE.write_text(json.dumps(board, separators=(",", ":")))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length)

    def do_GET(self):
        if self.path == "/api/board":
            with _lock:
                self._json(load_board())
        elif self.path == "/api/status":
            # Same shape as the firmware's /api/status. The mock "plots"
            # instantly, so state is always idle and error always empty.
            with _lock:
                self._json({"state": "idle", "line": _status["line"],
                            "error": "", "ip": "127.0.0.1", "rssi": 0})
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/api/board":
            try:
                record = json.loads(self._body())
            except ValueError:
                self._json({"error": "invalid JSON"}, 400)
                return
            with _lock:
                board = load_board()
                board["drawings"].append(record)
                save_board(board)
            print(f"[board] added {record.get('name')!r} "
                  f"at x={record.get('x')} y={record.get('y')} "
                  f"({len(board['drawings'])} total)")
            self._json({"ok": True})
        elif self.path == "/api/command":
            gcode = self._body().decode("utf-8", "replace")
            with _lock, open(ROOT / "commands.log", "a") as f:
                f.write(f"--- {time.strftime('%H:%M:%S')}\n{gcode.rstrip()}\n")
            print(f"[command] {' | '.join(gcode.strip().splitlines())}")
            self._json({"ok": True})
        elif self.path == "/api/print":
            gcode = self._body().decode("utf-8", "replace")
            PRINTS_DIR.mkdir(exist_ok=True)
            name = f"{time.strftime('%Y%m%d-%H%M%S')}-{int(time.time() * 1000) % 1000:03d}.gcode"
            (PRINTS_DIR / name).write_text(gcode)
            with _lock:
                _status["line"] = len(gcode.splitlines())
            print(f"[print] received {_status['line']} lines "
                  f"-> prints/{name}")
            self._json({"ok": True, "file": name})
        else:
            self.send_error(404)

    def do_DELETE(self):
        if self.path == "/api/board":
            with _lock:
                save_board({"drawings": []})
            print("[board] cleared")
            self._json({"ok": True})
        else:
            self.send_error(404)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Plotter mock server on http://localhost:{port} (serving {WEB_DIR})")
    server.serve_forever()


if __name__ == "__main__":
    main()
