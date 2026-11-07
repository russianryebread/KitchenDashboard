"""Read-only providers for the wall dashboard."""
import base64
import json
import re
import socket
from uuid import uuid4
from ipaddress import ip_address
from collections import defaultdict
from datetime import datetime, timedelta
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener
from xml.etree import ElementTree as XML

from dateutil.rrule import rruleset, rrulestr
from dateutil.tz import gettz, UTC

ZONE = gettz("America/Denver")
DAV = "{DAV:}"
CAL = "{urn:ietf:params:xml:ns:caldav}"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, method="GET", data=None, headers=None, allowed=None, include_url=False):
    opener = build_opener(NoRedirect())
    for _ in range(6):
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.username or parts.password or parts.port not in (None, 443):
            raise ValueError("Expected an HTTPS provider URL")
        if allowed and not allowed(parts.hostname or ""):
            raise ValueError("Unexpected provider host")
        try:
            with opener.open(Request(url, data, headers or {}, method=method), timeout=12) as result:
                content = result.read(10 * 1024 * 1024 + 1)
                if len(content) > 10 * 1024 * 1024:
                    raise ValueError("Provider response is too large")
                return (content, url) if include_url else content
        except HTTPError as error:
            location = error.headers.get("Location")
            if error.code == 330:
                new_host = error.headers.get("X-Apple-MMe-Host")
                if not new_host:
                    try:
                        new_host = json.loads(error.read(16384)).get("X-Apple-MMe-Host")
                    except (ValueError, AttributeError):
                        pass
                if new_host and isinstance(new_host, str):
                    location = "https://" + new_host + parts.path
            if error.code not in (301, 302, 307, 308, 330) or not location:
                raise
            target = urljoin(url, location)
            if not allowed and urlsplit(target).hostname != parts.hostname:
                raise ValueError("Unexpected redirect")
            url = target
    raise ValueError("Too many provider redirects")


def apple(host):
    return host.endswith(".icloud.com") or host == "icloud.com"


def public_host(host):
    try:
        addresses = {ip_address(entry[4][0]) for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
    except OSError:
        return False
    return bool(addresses) and all(address.is_global and not address.is_multicast for address in addresses)


def subscription(url):
    parts = urlsplit(url.strip())
    if parts.scheme == "webcal":
        parts = parts._replace(scheme="https")
    raw = request(parts.geturl(), allowed=public_host).decode("utf-8-sig")
    if not raw.lstrip().startswith("BEGIN:VCALENDAR"):
        raise ValueError("The subscription URL did not return an iCalendar feed")
    return raw


def calendar_name(source, fallback):
    unfolded = re.sub(r"\r?\n[ \t]", "", source)
    match = re.search(r"^(?:X-WR-CALNAME|NAME)(?:;[^:\r\n]*)?:([^\r\n]+)", unfolded, re.M | re.I)
    if not match:
        return fallback
    value = ical_text(match[1]).strip()
    return value[:100] or fallback


def calendar_date(item):
    params, value = item
    if re.fullmatch(r"\d{8}", value):
        return datetime.strptime(value, "%Y%m%d").replace(tzinfo=ZONE), True
    zone = UTC if value.endswith("Z") else gettz(params.get("TZID", "")) if params.get("TZID") else ZONE
    return datetime.strptime(value.rstrip("Z"), "%Y%m%dT%H%M%S").replace(tzinfo=zone or ZONE), False


def ical_text(value):
    return re.sub(r"\\([nN,;\\])", lambda m: "\n" if m[1].lower() == "n" else m[1], value)


def events_from_ics(source, first, last, title, color, busy=False):
    groups = defaultdict(list)
    component = None
    depth = 0
    for line in re.sub(r"\r?\n[ \t]", "", source).splitlines():
        if line == "BEGIN:VEVENT":
            component, depth = defaultdict(list), 0
            continue
        if component is None:
            continue
        if line == "END:VEVENT":
            if component["DTSTART"] or component["RECURRENCE-ID"]:
                key = component["UID"][0][1] if component["UID"] else str(len(groups))
                groups[key].append(component)
            component = None
            continue
        if line.startswith("BEGIN:"):
            depth += 1
        if depth == 0:
            left, sep, value = line.partition(":")
            name, *params = left.split(";")
            if sep:
                component[name].append((dict((k, v.strip('"')) for k, _, v in
                                              (p.partition("=") for p in params)), value))
        if line.startswith("END:"):
            depth = max(0, depth - 1)

    def val(part, key, default=""):
        return part[key][0][1] if part[key] else default

    def duration(part, start, all_day, default=None):
        if part["DTEND"]:
            return calendar_date(part["DTEND"][0])[0] - start
        value = val(part, "DURATION")
        match = re.fullmatch(r"\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", value)
        if match:
            weeks, days, hours, minutes, seconds = [int(n or 0) for n in match.groups()]
            return timedelta(weeks=weeks, days=days, hours=hours, minutes=minutes, seconds=seconds)
        if default is not None:
            return default
        return timedelta(days=1) if all_day else timedelta(minutes=1)

    def display(part, start, length, all_day, master):
        end = start + length
        if start >= last or max(end, start + timedelta(seconds=1)) <= first:
            return
        private = busy or val(part, "CLASS", val(master, "CLASS")) in ("PRIVATE", "CONFIDENTIAL")
        name = "Busy" if private else ical_text(val(part, "SUMMARY", val(master, "SUMMARY", "Untitled event")))
        return {"title": name, "calendar": title, "color": color, "allDay": all_day,
                "start": start.date().isoformat() if all_day else start.isoformat(),
                "end": end.date().isoformat() if all_day else end.isoformat(),
                "location": "" if private else ical_text(val(part, "LOCATION", val(master, "LOCATION")))}

    result = []
    for group in groups.values():
        master = next((part for part in group if not part["RECURRENCE-ID"]), None)
        changes = [part for part in group if part["RECURRENCE-ID"]]
        if master and val(master, "STATUS") != "CANCELLED":
            start, all_day = calendar_date(master["DTSTART"][0])
            length = duration(master, start, all_day)
            series = rruleset()
            series.rdate(start)
            for _, value in master["RRULE"]:
                if "UNTIL=" in value and not re.search(r"UNTIL=[^;]+Z", value):
                    value = re.sub(r"UNTIL=(\d{8})(T\d{6})?(?=;|$)", lambda m:
                                   "UNTIL=" + (calendar_date(({}, m[1] + (m[2] or "T235959")))[0]
                                               .astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")), value)
                series.rrule(rrulestr(value, dtstart=start))
            for key, add in (("RDATE", series.rdate), ("EXDATE", series.exdate)):
                for params, values in master[key]:
                    for value in values.split(","):
                        add(calendar_date((params, value.split("/")[0]))[0])
            for part in changes:
                series.exdate(calendar_date(part["RECURRENCE-ID"][0])[0])
            for occurrence in series.xafter(first - length, count=2000, inc=True):
                if occurrence >= last:
                    break
                event = display(master, occurrence, length, all_day, master)
                if event:
                    result.append(event)
        for part in changes:
            if val(part, "STATUS") == "CANCELLED" or not part["DTSTART"]:
                continue
            start, all_day = calendar_date(part["DTSTART"][0])
            fallback = None
            if master:
                base, base_all_day = calendar_date(master["DTSTART"][0])
                fallback = duration(master, base, base_all_day)
            event = display(part, start, duration(part, start, all_day, fallback), all_day, master or part)
            if event:
                result.append(event)
    return result


def dav_xml(url, method, content, credentials, depth):
    body, final_url = request(url, method, content.encode("utf-8"), {
        "Authorization": credentials, "Depth": str(depth), "Content-Type": "application/xml; charset=utf-8"
    }, apple, include_url=True)
    return XML.fromstring(body), final_url


def discover(account):
    credentials = "Basic " + base64.b64encode(
        (account["email"] + ":" + account["app_password"]).encode("utf-8")).decode("ascii")
    root = "https://caldav.icloud.com/"
    principal, root = dav_xml(root, "PROPFIND",
                        '<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>', credentials, 0)
    principal_url = urljoin(root, principal.findtext(".//" + DAV + "current-user-principal/" + DAV + "href"))
    homes, principal_url = dav_xml(principal_url, "PROPFIND",
                    '<propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><prop><c:calendar-home-set/></prop></propfind>',
                    credentials, 0)
    home = urljoin(principal_url, homes.findtext(".//" + CAL + "calendar-home-set/" + DAV + "href"))
    listing, home = dav_xml(home, "PROPFIND",
                      '<propfind xmlns="DAV:"><prop><displayname/><resourcetype/></prop></propfind>', credentials, 1)
    calendars = {}
    for response in listing.findall(DAV + "response"):
        if response.find(".//" + DAV + "resourcetype/" + CAL + "calendar") is not None:
            href = response.findtext(DAV + "href")
            name = response.findtext(".//" + DAV + "displayname") or href
            if href:
                calendars[name] = urljoin(home, href)
    return credentials, calendars


def private_ics(url, credentials, first, last):
    first, last = [(point.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")) for point in (first, last)]
    body = ('''<c:calendar-query xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <prop><c:calendar-data/></prop>
      <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
        <c:time-range start="{}" end="{}"/>
      </c:comp-filter></c:comp-filter></c:filter>
    </c:calendar-query>''').format(first, last)
    tree, _ = dav_xml(url, "REPORT", body, credentials, 1)
    return "\n".join(node.text or "" for node in tree.iter(CAL + "calendar-data"))


def shared_album(url):
    parts = urlsplit(url.strip())
    if (parts.scheme == "https" and parts.netloc == "photos.icloud.com"
            and re.fullmatch(r"/shared/album/[A-Za-z0-9_-]{8,180}/?", parts.path)):
        return cloudkit_album(parts.path.rstrip("/").rsplit("/", 1)[-1])
    token = parts.fragment
    if parts.scheme != "https" or not apple(parts.hostname or "") or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", token):
        raise ValueError("Expected the Public Website link for an iCloud Shared Album")
    base = "https://p01-sharedstreams.icloud.com/{}/sharedstreams/".format(token)
    headers = {"Content-Type": "application/json", "Origin": "https://www.icloud.com",
               "Referer": "https://www.icloud.com/"}

    def post(path, body):
        nonlocal base
        content, final_url = request(base + path, "POST", json.dumps(body).encode(), headers, apple, include_url=True)
        base = final_url.rsplit("/", 1)[0] + "/"
        return json.loads(content)

    photos = [p for p in post("webstream", {"streamCtag": None}).get("photos", [])
              if p.get("mediaAssetType") != "video" and p.get("photoGuid") and p.get("derivatives")]
    photos = photos[:250]
    urls = []
    for offset in range(0, len(photos), 25):
        chunk = photos[offset:offset + 25]
        items = post("webasseturls", {"photoGuids": [photo["photoGuid"] for photo in chunk]}).get("items", {})
        for photo in chunk:
            candidates = [d for d in photo["derivatives"].values() if d.get("checksum") in items]
            if not candidates:
                continue
            derivative = min(candidates, key=lambda d: abs(int(d.get("width") or 0) - 1600))
            item = items[derivative["checksum"]]
            if item.get("url_location") and item.get("url_path", "").startswith("/"):
                candidate = "https://" + item["url_location"] + item["url_path"]
                parts = urlsplit(candidate)
                if (parts.hostname and (apple(parts.hostname) or parts.hostname.endswith(".icloud-content.com"))
                        and not parts.username and not parts.password):
                    urls.append(candidate)
    return urls


def cloudkit_album(token):
    """Read a current Apple Photos public album through its web client's CloudKit endpoints."""
    api = "/database/1/com.apple.photos.cloud/production"
    headers = {"Content-Type": "text/plain", "Origin": "https://photos.icloud.com",
               "Referer": "https://photos.icloud.com/"}
    params = {"remapEnums": "true", "getCurrentSyncToken": "true", "sharing_url_key": token,
              "clientBuildNumber": "2640Build32", "clientMasteringNumber": "2640Build32"}

    def cloudkit_host(host):
        return re.fullmatch(r"(?:p[0-9]+-)?ckdatabasews\.icloud\.com", host) is not None

    def post(base, operation, body):
        endpoint = base + api + operation + "?" + urlencode(params)
        result = request(endpoint, "POST", json.dumps(body).encode(), headers, cloudkit_host)
        return json.loads(result)

    result = post("https://ckdatabasews.icloud.com", "/public/records/resolve",
                  {"shortGUIDs": [{"value": token}]})
    album = next((item for item in result.get("results", []) if item.get("anonymousPublicAccess")), None)
    if not album or album.get("requireAppleLogin"):
        raise ValueError("The Shared Album must be available to anyone with the link")
    access = album["anonymousPublicAccess"]
    partition = urlsplit(access["databasePartition"])
    if (partition.scheme != "https" or not cloudkit_host(partition.hostname or "")
            or partition.port not in (None, 443) or partition.username or partition.password
            or partition.path not in ("", "/") or partition.query or partition.fragment):
        raise ValueError("Unexpected Apple Photos partition")
    base = "https://" + partition.netloc
    params["publicAccessAuthToken"] = access["token"]
    params["clientId"] = str(uuid4())
    urls = []
    seen = set()
    rank = 0
    for _ in range(12):
        result = post(base, "/shared/records/query", {
            "query": {"recordType": "CPLAssetAndMasterByAddedDate", "filterBy": [
                {"fieldName": "direction", "comparator": "EQUALS",
                 "fieldValue": {"type": "STRING", "value": "ASCENDING"}},
                {"fieldName": "startRank", "comparator": "EQUALS",
                 "fieldValue": {"type": "INT64", "value": rank}}
            ]},
            "zoneID": album["zoneID"],
            "resultsLimit": 100,
        })
        if "records" not in result:
            raise ValueError("Apple Photos did not return album records")
        assets = 0
        for record in result["records"]:
            if record.get("recordType") == "CPLAsset":
                assets += 1
            if record.get("recordType") != "CPLMaster" or record.get("deleted"):
                continue
            fields = record.get("fields", {})
            media = fields.get("itemType", {}).get("value", "")
            if media in ("public.movie", "public.video", "public.mpeg-4", "com.apple.quicktime-movie"):
                continue
            for name in ("resJPEGMedRes", "resJPEGThumbRes"):
                url = fields.get(name, {}).get("value", {}).get("downloadURL", "")
                location = urlsplit(url)
                if (location.scheme == "https" and location.hostname
                        and location.hostname.endswith(".icloud-content.com") and location.port in (None, 443)
                        and not location.username and not location.password):
                    if url not in seen:
                        urls.append(url)
                        seen.add(url)
                    break
        rank += assets
        if assets < 50 or len(urls) >= 250:
            break
    return urls[:250]


def weather(latitude, longitude):
    query = urlencode({"latitude": latitude, "longitude": longitude,
                       "current": "temperature_2m,weather_code",
                       "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                       "temperature_unit": "fahrenheit", "timezone": "America/Denver", "forecast_days": 1})
    result = json.loads(request("https://api.open-meteo.com/v1/forecast?" + query).decode())
    return {"temperature": result["current"]["temperature_2m"], "code": result["current"]["weather_code"],
            "high": result["daily"]["temperature_2m_max"][0], "low": result["daily"]["temperature_2m_min"][0],
            "precipitation": result["daily"]["precipitation_probability_max"][0]}
