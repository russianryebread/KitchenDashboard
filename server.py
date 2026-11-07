#!/usr/bin/env python3
"""Serve the household wall display and its read-only data feeds."""
import argparse
import hmac
import json
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from ipaddress import ip_address, ip_network
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import urlsplit

import integrations as providers

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
LAN = ip_network("192.168.1.0/24")
WIDGETS = ("clock", "calendar", "agenda", "weather", "next", "reminders", "verse")
COLORS = ("#72dfc1", "#f9c879", "#b9adff", "#8dd6ff", "#ffadbc", "#c7e48a")
DEFAULT = {
    "widgets": [{"id": name, "size": size, "visible": True}
                for name, size in zip(WIDGETS, (12, 7, 5, 4, 4, 4, 12))],
    "refresh": {"calendar": 5, "weather": 20, "album": 60, "rotation": 2},
    "reminders": [], "nightStart": "22:00", "nightEnd": "05:00", "calendarView": "month",
    "photo": True,
}
EXAMPLE = {
    "public_calendars": [],
    "icloud": {"email": "", "app_password": "", "calendars": []},
    "album_url": "",
    "weather": {"latitude": 40.48, "longitude": -104.90, "label": "Windsor · 80550"},
}
STATE_LOCK = threading.Lock()
PIN_LOCK = threading.Lock()
PIN_FAILURES = {}
PIN_MAX_ATTEMPTS = 5
PIN_WINDOW_SECONDS = 60
CACHE_LOCK = threading.Lock()
CACHE = {}
PROVIDER_LOCKS = {}
VERSES = [(line.split("|", 1)) for line in (ROOT / "verses.txt").read_text().splitlines() if line.strip()]


def read(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save(path, value):
    temporary = path.with_suffix(".tmp")
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    os.replace(str(temporary), str(path))


def initialize():
    DATA.mkdir(mode=0o700, exist_ok=True)
    os.chmod(str(DATA), 0o700)
    sources = DATA / "sources.json"
    if not sources.exists():
        save(sources, EXAMPLE)
    admin = DATA / "admin.json"
    pin = read(admin, {}).get("key", "")
    if not re.fullmatch(r"[0-9]{4}", pin):
        save(admin, {"key": "{:04d}".format(secrets.randbelow(10000))})


def settings():
    return {**DEFAULT, **read(DATA / "settings.json", {})}


def clean_settings(value):
    widgets = value["widgets"]
    if sorted(widget["id"] for widget in widgets) != sorted(WIDGETS):
        raise ValueError("Widget list is incomplete")
    result = {"widgets": [{"id": widget["id"], "size": int(widget["size"]),
                           "visible": bool(widget["visible"])} for widget in widgets]}
    if any(not 3 <= widget["size"] <= 12 for widget in result["widgets"]):
        raise ValueError("Widget widths must be between 3 and 12")
    result["refresh"] = {key: int(value["refresh"][key]) for key in DEFAULT["refresh"]}
    if any(not 1 <= number <= 1440 for number in result["refresh"].values()):
        raise ValueError("Refresh intervals must be between 1 and 1440 minutes")
    for key in ("nightStart", "nightEnd"):
        result[key] = value[key]
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", result[key]):
            raise ValueError("Invalid night schedule")
    result["calendarView"] = value["calendarView"]
    if result["calendarView"] not in ("month", "week"):
        raise ValueError("Invalid calendar view")
    result["photo"] = bool(value["photo"])
    result["reminders"] = [line.strip()[:150] for line in value["reminders"][:30] if line.strip()]
    return result


def cached(key, minutes, fetch, empty):
    with CACHE_LOCK:
        lock = PROVIDER_LOCKS.setdefault(key[0], threading.Lock())
    with lock:
        now = time.monotonic()
        with CACHE_LOCK:
            old = CACHE.get(key)
        if old and old[0] > now:
            return old[1]
        try:
            result = {"data": fetch(), "status": "ok"}
            ttl = minutes * 60
        except Exception as error:
            # Provider errors can contain credentials or private URLs.
            print("{} refresh failed ({})".format(key[0], type(error).__name__), file=sys.stderr, flush=True)
            has_last = old and old[1]["status"] in ("ok", "stale")
            result = {"data": old[1]["data"] if has_last else empty,
                      "status": "stale" if has_last else "unavailable"}
            ttl = min(minutes * 60, 60)
        with CACHE_LOCK:
            for obsolete in list(CACHE):
                if obsolete != key and obsolete[0] == key[0]:
                    del CACHE[obsolete]
            CACHE[key] = (time.monotonic() + ttl, result)
        return result


def calendars(config, refresh, now):
    public = config.get("public_calendars", [])
    account = config.get("icloud", {})
    selected = account.get("calendars", [])
    if not public and not selected:
        return {"data": [], "status": "setup"}
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    first, last = midnight - timedelta(days=65), midnight + timedelta(days=100)

    def read_source(source, index, loader):
        return providers.events_from_ics(loader(), first, last, source["name"],
                                         COLORS[index % len(COLORS)], source.get("busy_only", False))

    def read_public(source, index):
        url = source["url"]
        if url.startswith("webcal://"):
            url = "https://" + url[len("webcal://"):]
        return read_source(source, index, lambda: providers.request(url, allowed=providers.apple).decode("utf-8-sig"))

    key = ("calendar", json.dumps([public, account], sort_keys=True), now.date())

    def collect():
        jobs = []
        failed = 0
        with ThreadPoolExecutor(max_workers=6) as pool:
            for index, source in enumerate(public):
                jobs.append(pool.submit(read_public, source, index))
            if selected:
                try:
                    authorization, available = providers.discover(account)
                    for index, source in enumerate(selected, len(public)):
                        url = available.get(source["name"])
                        if url:
                            jobs.append(pool.submit(read_source, source, index, lambda url=url:
                                                    providers.private_ics(url, authorization, first, last)))
                        else:
                            failed += 1
                except Exception:
                    failed += len(selected)
            events = []
            succeeded = 0
            for job in jobs:
                try:
                    events.extend(job.result())
                    succeeded += 1
                except Exception:
                    failed += 1
        if not succeeded:
            raise ValueError("No calendar could be read")
        return {"events": sorted(events, key=lambda event: event["start"]), "partial": failed > 0}

    result = cached(key, refresh, collect, {"events": [], "partial": False})
    return {"data": result["data"]["events"],
            "status": "partial" if result["status"] == "ok" and result["data"]["partial"] else result["status"]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, template, *args):
        # Avoid logging private request data.
        pass

    def respond(self, status, data, media="application/json; charset=utf-8", cache="no-store"):
        if isinstance(data, (dict, list)):
            data = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(data)

    def allowed(self):
        client = ip_address(self.client_address[0])
        host = self.headers.get("Host", "").split(":")[0]
        if (client.is_loopback or client in LAN) and host in self.server.hosts:
            return True
        self.respond(403, {"error": "Open the dashboard from your home network using its local URL."})
        return False

    def do_GET(self):
        if not self.allowed():
            return
        path = urlsplit(self.path).path
        try:
            if path.startswith("/api/"):
                value = self.api(path[5:])
                self.respond(200 if value is not None else 404, value if value is not None else {"error": "Not found"})
                return
            filename = {"": "index.html", "app.js": "app.js", "style.css": "style.css",
                        "background.jpg": "background.jpg", "icon.svg": "icon.svg",
                        "icon.png": "icon.png", "manifest.webmanifest": "manifest.webmanifest"}.get(path[1:])
            if filename is None:
                self.respond(404, {"error": "Not found"})
                return
            media = mimetypes.guess_type(filename)[0] or "application/manifest+json"
            self.respond(200, (ROOT / "static" / filename).read_bytes(), media,
                         "public, max-age=86400" if filename in ("background.jpg", "icon.svg", "icon.png") else "no-cache")
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            print("Request failed ({})".format(type(error).__name__), file=sys.stderr, flush=True)
            self.respond(500, {"error": "Dashboard data could not be loaded."})

    def api(self, name):
        if name == "settings":
            return settings()
        now = datetime.now(providers.ZONE)
        if name == "verse":
            ref, verse = VERSES[(now.date().toordinal() - 1) % len(VERSES)]
            return {"reference": ref, "text": verse, "date": now.date().isoformat()}
        config = read(DATA / "sources.json", EXAMPLE)
        refresh = settings()["refresh"]
        if name == "calendar":
            return calendars(config, refresh["calendar"], now)
        if name == "weather":
            location = config.get("weather", EXAMPLE["weather"])
            key = ("weather", location["latitude"], location["longitude"])
            result = cached(key, refresh["weather"], lambda: providers.weather(*key[1:]), None)
            return {**result, "location": location["label"]}
        if name == "album":
            url = config.get("album_url")
            if not url:
                return {"data": [], "status": "setup"}
            return cached(("album", url), refresh["album"], lambda: providers.shared_album(url), [])

    def do_POST(self):
        if not self.allowed():
            return
        if self.path != "/api/settings":
            self.respond(404, {"error": "Not found"})
            return
        if self.headers.get("Origin") != "http://" + self.headers.get("Host", ""):
            self.respond(403, {"error": "Open settings directly from the dashboard."})
            return
        pin = read(DATA / "admin.json", {})["key"]
        candidate = self.headers.get("X-Edit-Key", "")
        client = self.client_address[0]
        with PIN_LOCK:
            now = time.monotonic()
            failures, reset = PIN_FAILURES.get(client, (0, now + PIN_WINDOW_SECONDS))
            if now >= reset:
                failures, reset = 0, now + PIN_WINDOW_SECONDS
            if failures >= PIN_MAX_ATTEMPTS:
                status = 429
            elif re.fullmatch(r"[0-9]{4}", candidate) and hmac.compare_digest(candidate, pin):
                PIN_FAILURES.pop(client, None)
                status = 200
            else:
                PIN_FAILURES[client] = (failures + 1, reset)
                status = 403
        if status != 200:
            error = ("Too many incorrect PINs. Try again in a minute." if status == 429 else
                     "The edit PIN is incorrect.")
            self.respond(status, {"error": error})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 32768:
                raise ValueError("Invalid settings size")
            value = clean_settings(json.loads(self.rfile.read(size).decode("utf-8")))
        except (ValueError, TypeError, KeyError, AttributeError):
            self.respond(400, {"error": "Check widget widths, refresh rates and night times."})
            return
        with STATE_LOCK:
            save(DATA / "settings.json", value)
        self.respond(200, value)


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--bind", default="192.168.1.184")
    cli.add_argument("--port", type=int, default=8765)
    cli.add_argument("--list-calendars", action="store_true")
    cli.add_argument("--edit-pin", "--edit-key", action="store_true")
    cli.add_argument("--init", action="store_true")
    args = cli.parse_args()
    initialize()
    if args.init:
        return
    if args.edit_pin:
        print(read(DATA / "admin.json", {})["key"])
        return
    if args.list_calendars:
        try:
            _, found = providers.discover(read(DATA / "sources.json", EXAMPLE)["icloud"])
            print("\n".join(sorted(found)) or "No calendars found.")
        except Exception as error:
            cli.exit(1, "Could not discover iCloud calendars ({}). Check the account and app-specific password.\n".format(type(error).__name__))
        return
    with Server((args.bind, args.port), Handler) as server:
        server.hosts = {"localhost", "127.0.0.1", args.bind}
        print("Wallboard is available at http://{}:{}".format(args.bind, args.port), flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
