"use strict";

const zone = "America/Denver";
const names = {
  clock: "Clock", calendar: "Calendar", agenda: "Coming up",
  weather: "Weather", next: "Next up", reminders: "Reminders", verse: "Verse of the day"
};
const labels = { calendar: "Calendar", weather: "Weather", album: "Album" };
const data = {};
const due = {};
const pending = new Set();
const cards = {};
const board = document.querySelector("#board");
const form = document.querySelector("#editor-form");
const editor = document.querySelector("#editor");
const scenery = document.querySelector("#scenery");
const clockFormat = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" });
const keyFormat = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
const minutesFormat = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const monthFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long" });
const shortFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

let settings;
let draft;
let anchor;
let dayKey = "";
let lastMinute = "";
let lastNight = false;
let override;
let photoIndex = -1;
let photoVersion = 0;
let nextPhoto = 0;
let photoUrl = "";
let fetchGeneration = 0;

function elem(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function keyOf(date) {
  const values = {};
  keyFormat.formatToParts(date).forEach(part => { values[part.type] = part.value; });
  return values.year + "-" + values.month + "-" + values.day;
}

function calendarDay(key) {
  return new Date(key + "T00:00:00Z");
}

function shift(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function utcKey(date) {
  return date.toISOString().slice(0, 10);
}

function startKey(event) {
  return event.allDay ? event.start : keyOf(new Date(event.start));
}

function overlaps(event, day) {
  if (event.allDay) return event.start <= day && event.end > day;
  return startKey(event) <= day && keyOf(new Date(Math.max(Date.parse(event.start), Date.parse(event.end) - 1))) >= day;
}

function currentEvents(now) {
  return (data.calendar ? data.calendar.data : [])
    .filter(event => event.allDay ? event.end > dayKey : Date.parse(event.end) > +now)
    .sort((a, b) => {
      const dayOrder = startKey(a).localeCompare(startKey(b));
      if (dayOrder) return dayOrder;
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.allDay ? a.title.localeCompare(b.title) : Date.parse(a.start) - Date.parse(b.start);
    });
}

function statusText(name) {
  const source = data[name];
  if (!source) return "Loading " + labels[name].toLowerCase() + "…";
  if (source.status === "setup") return "Connect iCloud calendars on the host to show events.";
  if (source.status === "partial") return "Some calendars could not refresh.";
  if (source.status === "stale") return "Showing the last successful update.";
  if (source.status === "unavailable") return labels[name] + " temporarily unavailable.";
  return "";
}

function addStatus(parent, name) {
  const note = statusText(name);
  if (note) parent.appendChild(elem("p", note, "status-note"));
}

function button(text, label, action) {
  const node = elem("button", text);
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.addEventListener("click", action);
  return node;
}

function dot(event) {
  const node = elem("span", undefined, "dot");
  node.style.setProperty("--event", event.color);
  node.title = event.calendar + " · " + event.title;
  return node;
}

function showCalendar(head, body) {
  const week = settings.calendarView === "week";
  const today = calendarDay(dayKey);
  const view = anchor || today;
  const period = week ? shift(view, -view.getUTCDay()) :
    new Date(Date.UTC(view.getUTCFullYear(), view.getUTCMonth(), 1));
  const first = week ? period : shift(period, -period.getUTCDay());
  const last = week ? shift(period, 6) : shift(new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 1)), -1);
  const slots = week ? 7 : Math.ceil(((last - first) / 86400000 + 1) / 7) * 7;
  const title = week ? shortFormat.format(period) + " – " + shortFormat.format(last) : monthFormat.format(period);
  const nav = elem("div", undefined, "month-nav");
  [-1, 1].forEach(direction => {
    const target = week ? shift(period, 7 * direction) :
      new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + direction, 1));
    const control = button(direction < 0 ? "‹" : "›", (direction < 0 ? "Previous " : "Next ") + (week ? "week" : "month"),
      () => { anchor = target; renderCard("calendar"); });
    control.disabled = Math.abs(target - today) > 65 * 86400000;
    nav.appendChild(control);
  });
  head.appendChild(nav);
  body.appendChild(elem("div", title, "month-title"));
  const grid = elem("div", undefined, week ? "grid week" : "grid");
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(d => grid.appendChild(elem("div", d, "weekday")));
  const events = data.calendar ? data.calendar.data : [];
  for (let i = 0; i < slots; i++) {
    const date = shift(first, i);
    const key = utcKey(date);
    const classes = "cell" + (key === dayKey ? " today" : "") +
      (!week && date.getUTCMonth() !== period.getUTCMonth() ? " outside" : "");
    const cell = elem("div", undefined, classes);
    cell.appendChild(elem("span", String(date.getUTCDate()), "day-num"));
    const matches = events.filter(event => overlaps(event, key));
    if (matches.length) {
      const list = elem("div", undefined, week ? "" : "mini-events");
      matches.slice(0, week ? 3 : 6).forEach(event => {
        if (!week) {
          list.appendChild(dot(event));
        } else {
          const line = elem("span", event.title, "week-event");
          line.style.setProperty("--event", event.color);
          list.appendChild(line);
        }
      });
      if (week && matches.length > 3) list.appendChild(elem("span", "+" + (matches.length - 3) + " more", "detail"));
      cell.appendChild(list);
    }
    grid.appendChild(cell);
  }
  body.appendChild(grid);
}

function describeWhen(event) {
  const day = startKey(event);
  const name = day === dayKey ? "Today" : day === utcKey(shift(calendarDay(dayKey), 1)) ? "Tomorrow" :
    shortFormat.format(calendarDay(day));
  return event.allDay ? (day < dayKey ? "Ongoing" : name + " · All day") :
    name + " · " + clockFormat.format(new Date(event.start));
}

function showAgenda(body) {
  const until = utcKey(shift(calendarDay(dayKey), 7));
  const events = currentEvents(new Date()).filter(event => startKey(event) < until).slice(0, 25);
  if (!events.length && data.calendar && data.calendar.status === "ok") {
    body.appendChild(elem("p", "No events in the next seven days.", "empty"));
  }
  const list = elem("ul", undefined, "agenda-list");
  events.forEach(event => {
    const row = elem("li", undefined, "event");
    const details = elem("div");
    details.appendChild(elem("strong", event.title));
    details.appendChild(elem("span", event.calendar + (event.location ? " · " + event.location : ""), "detail"));
    row.appendChild(dot(event));
    row.appendChild(elem("span", describeWhen(event), "event-time"));
    row.appendChild(details);
    list.appendChild(row);
  });
  body.appendChild(list);
  addStatus(body, "calendar");
}

function condition(code) {
  if (code === 0) return "Clear";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code < 50) return "Fog";
  if (code < 60) return "Drizzle";
  if (code < 70) return "Rain";
  if (code < 80) return "Snow";
  if (code <= 82) return "Showers";
  if (code < 90) return "Snow showers";
  return "Thunderstorms";
}

function degrees(value) {
  return Number.isFinite(value) ? Math.round(value) + "°" : "–";
}

function showWeather(body) {
  const source = data.weather;
  if (!source || !source.data) {
    addStatus(body, "weather");
    return;
  }
  const values = source.data;
  body.appendChild(elem("p", degrees(values.temperature) + "F", "feature-value temperature"));
  body.appendChild(elem("p", condition(values.code) + " · " + source.location, "feature-detail"));
  body.appendChild(elem("p", "H " + degrees(values.high) + " · L " + degrees(values.low) +
    (Number.isFinite(values.precipitation) ? " · " + values.precipitation + "% precip." : ""), "feature-detail"));
  const attribution = elem("a", "Open-Meteo", "detail");
  attribution.href = "https://open-meteo.com/";
  body.appendChild(attribution);
  addStatus(body, "weather");
}

function showNext(body) {
  const now = new Date();
  const events = currentEvents(now);
  const event = events.find(e => !e.allDay && Date.parse(e.start) > +now) || events[0];
  if (!event) {
    body.appendChild(elem("p", "Nothing scheduled yet.", "empty"));
    return;
  }
  body.appendChild(elem("p", event.title, "feature-value"));
  const left = Math.ceil((Date.parse(event.start) - +now) / 60000);
  let countdown = "";
  if (!event.allDay && left > 0 && left <= 180) {
    countdown = left < 60 ? "In " + left + " min · " :
      "In " + Math.floor(left / 60) + " hr" + (left % 60 ? " " + left % 60 + " min" : "") + " · ";
  }
  body.appendChild(elem("p", countdown + describeWhen(event), "feature-detail"));
}

function renderCard(id) {
  const card = cards[id];
  if (!card || !dayKey) return;
  const head = card.querySelector(".card-head");
  const body = card.querySelector(".card-body");
  clear(head);
  clear(body);
  head.appendChild(elem("h2", names[id]));
  if (id === "clock") {
    const now = new Date();
    const line = elem("div", undefined, "clock-line");
    line.appendChild(elem("time", clockFormat.format(now), "clock-value"));
    line.appendChild(elem("span", dateFormat.format(now), "date-label"));
    body.appendChild(line);
  }
  if (id === "calendar") showCalendar(head, body);
  if (id === "agenda") showAgenda(body);
  if (id === "weather") showWeather(body);
  if (id === "next") showNext(body);
  if (id === "reminders") {
    const list = elem("ul", undefined, "reminder-list");
    settings.reminders.forEach(note => list.appendChild(elem("li", note)));
    if (!settings.reminders.length) body.appendChild(elem("p", "Add household reminders in Customize.", "empty"));
    body.appendChild(list);
  }
  if (id === "verse") {
    if (data.verse && data.verse.date === dayKey) {
      body.appendChild(elem("blockquote", "“" + data.verse.text + "”", "verse-line"));
      body.appendChild(elem("p", data.verse.reference + " · KJV", "verse-ref"));
    } else {
      body.appendChild(elem("p", "Loading today’s verse…", "empty"));
    }
  }
}

function applySettings(value) {
  const old = settings;
  if (old && JSON.stringify(old) === JSON.stringify(value)) return;
  settings = value;
  document.body.classList.toggle("no-photo", !settings.photo);
  if (!old || old.calendarView !== value.calendarView) anchor = null;
  if (!old || JSON.stringify(old.widgets) !== JSON.stringify(value.widgets)) {
    clear(board);
    Object.keys(cards).forEach(id => { delete cards[id]; });
    value.widgets.filter(widget => widget.visible).forEach(widget => {
      const card = document.querySelector("#card").content.firstElementChild.cloneNode(true);
      card.classList.add("card-" + widget.id);
      card.style.setProperty("--span", widget.size);
      cards[widget.id] = card;
      board.appendChild(card);
    });
  }
  if (!old || JSON.stringify(old.refresh) !== JSON.stringify(value.refresh)) {
    fetchGeneration++;
    ["weather", "calendar", "album"].forEach(key => { due[key] = 0; });
    nextPhoto = 0;
  }
  Object.keys(cards).forEach(renderCard);
}

function updatePhoto(now) {
  const credit = document.querySelector("#photo-credit");
  credit.hidden = !settings.photo;
  if (!settings.photo || lastNight) return;
  const urls = data.album && data.album.data;
  if (!urls || !urls.length) {
    if (photoUrl) {
      scenery.style.removeProperty("--photo");
      const link = elem("a", "Scenic photo · Unsplash");
      link.href = "https://images.unsplash.com/photo-1470770841072-f978cf4d019e";
      clear(credit);
      credit.appendChild(link);
    }
    photoUrl = "";
    return;
  }
  if (now < nextPhoto && photoUrl) return;
  nextPhoto = now + settings.refresh.rotation * 60000;
  photoIndex = (photoIndex + 1) % urls.length;
  let url = urls[photoIndex];
  if (url === photoUrl && urls.length > 1) {
    photoIndex = (photoIndex + 1) % urls.length;
    url = urls[photoIndex];
  }
  if (url === photoUrl) return;
  const ticket = ++photoVersion;
  const image = new Image();
  image.onload = () => {
    if (ticket !== photoVersion) return;
    photoUrl = url;
    scenery.style.setProperty("--photo", "url(" + JSON.stringify(url) + ")");
    document.querySelector("#photo-credit").textContent = "ICLOUD SHARED ALBUM";
  };
  image.onerror = () => { if (ticket === photoVersion) nextPhoto = Date.now() + 30000; };
  image.src = url;
}

function get(name, minutes, callback) {
  const stamp = Date.now();
  if ((due[name] || 0) > stamp || pending.has(name)) return;
  pending.add(name);
  const generation = fetchGeneration;
  fetch("/api/" + name, { cache: "no-store" })
    .then(response => {
      if (!response.ok) throw new Error("Could not load " + name);
      return response.json();
    })
    .then(value => {
      due[name] = (generation === fetchGeneration || name === "settings") ?
        Date.now() + ((value.status === "unavailable" || value.status === "stale") ? Math.min(minutes, 1) : minutes) * 60000 : 0;
      callback(value);
      if (name === "settings") document.querySelector("#connection").hidden = true;
    })
    .catch(() => {
      due[name] = Date.now() + 15000;
      if (name === "settings") document.querySelector("#connection").hidden = false;
    })
    .then(() => pending.delete(name));
}

function clockMode(now) {
  const minutes = minutesFormat.format(now);
  const start = settings.nightStart;
  const end = settings.nightEnd;
  const scheduled = start === end ? false : start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (override && (override.schedule !== scheduled || +now > override.expires)) override = null;
  return { scheduled: scheduled, active: override ? override.active : scheduled };
}

function tick() {
  const now = new Date();
  const key = keyOf(now);
  if (key !== dayKey) {
    dayKey = key;
    due.verse = 0;
    due.calendar = 0;
    if (settings) ["calendar", "agenda", "verse"].forEach(renderCard);
  }
  get("settings", 0.2, applySettings);
  get("verse", 60, value => {
    if (value.date !== dayKey) { due.verse = 0; return; }
    data.verse = value;
    renderCard("verse");
  });
  if (!settings) return;
  const night = clockMode(now).active && editor.hidden;
  if (night !== lastNight) {
    lastNight = night;
    document.body.classList.toggle("night", night);
    document.querySelector("#day").hidden = night;
    document.querySelector("#night").hidden = !night;
    if (!night) nextPhoto = 0;
  }
  const minute = key + clockFormat.format(now);
  if (minute !== lastMinute) {
    lastMinute = minute;
    document.querySelector("#night-clock").textContent = clockFormat.format(now);
    document.querySelector("#night-date").textContent = dateFormat.format(now);
    ["clock", "next", "agenda"].forEach(renderCard);
  }
  get("calendar", settings.refresh.calendar, value => {
    data.calendar = value;
    ["calendar", "agenda", "next"].forEach(renderCard);
  });
  get("weather", settings.refresh.weather, value => {
    data.weather = value;
    renderCard("weather");
  });
  if (settings.photo) {
    get("album", settings.refresh.album, value => {
      data.album = value;
      if (!photoUrl) nextPhoto = 0;
    });
    updatePhoto(+now);
  }
}

function drawEditor() {
  const list = document.querySelector("#widget-settings");
  clear(list);
  draft.widgets.forEach((widget, index) => {
    const row = elem("div", undefined, "widget-option");
    const label = elem("label");
    const checkbox = elem("input");
    checkbox.type = "checkbox";
    checkbox.checked = widget.visible;
    checkbox.onchange = () => { widget.visible = checkbox.checked; };
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(names[widget.id]));
    row.appendChild(label);
    const width = elem("select");
    width.setAttribute("aria-label", names[widget.id] + " width");
    for (let columns = 3; columns <= 12; columns++) {
      const option = elem("option", columns === 12 ? "Full width" : columns + " / 12 width");
      option.value = columns;
      option.selected = columns === widget.size;
      width.appendChild(option);
    }
    width.onchange = () => { widget.size = Number(width.value); };
    row.appendChild(width);
    [-1, 1].forEach(delta => {
      const target = index + delta;
      const control = button(delta < 0 ? "↑" : "↓", "Move " + names[widget.id] + (delta < 0 ? " up" : " down"), () => {
        draft.widgets.splice(index, 1);
        draft.widgets.splice(target, 0, widget);
        drawEditor();
      });
      control.disabled = target < 0 || target >= draft.widgets.length;
      row.appendChild(control);
    });
    list.appendChild(row);
  });
}

function field(name) {
  return form.elements.namedItem(name);
}

function openEditor() {
  if (!settings) return;
  draft = JSON.parse(JSON.stringify(settings));
  drawEditor();
  ["nightStart", "nightEnd", "calendarView"].forEach(name => { field(name).value = draft[name]; });
  Object.keys(draft.refresh).forEach(name => { field(name).value = draft.refresh[name]; });
  field("photo").checked = draft.photo;
  field("reminders").value = draft.reminders.join("\n");
  field("key").value = "";
  document.querySelector("#save-status").textContent = "";
  editor.hidden = false;
  document.querySelector("#close-settings").focus();
}

function closeEditor() {
  editor.hidden = true;
  document.querySelector("#open-settings").focus();
  tick();
}

form.addEventListener("submit", event => {
  event.preventDefault();
  ["nightStart", "nightEnd", "calendarView"].forEach(name => { draft[name] = field(name).value; });
  Object.keys(draft.refresh).forEach(name => { draft.refresh[name] = Number(field(name).value); });
  draft.reminders = field("reminders").value.split("\n");
  draft.photo = field("photo").checked;
  const status = document.querySelector("#save-status");
  const save = document.querySelector("#save-settings");
  save.disabled = true;
  status.textContent = "Saving…";
  fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Edit-Key": field("key").value.trim() },
    body: JSON.stringify(draft)
  }).then(response => response.json().then(value => {
    if (!response.ok) throw new Error(value.error);
    return value;
  })).then(value => {
    applySettings(value);
    closeEditor();
  }).catch(error => { status.textContent = error.message || "Could not save changes."; })
    .then(() => { save.disabled = false; });
});

document.querySelector("#open-settings").onclick = openEditor;
document.querySelector("#close-settings").onclick = closeEditor;
document.querySelector("#cancel-settings").onclick = closeEditor;
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !editor.hidden) closeEditor();
});
document.querySelector("#preview-night").onclick = () => {
  if (!settings) return;
  const now = new Date();
  override = { active: true, schedule: clockMode(now).scheduled, expires: +now + 300000 };
  tick();
};
document.querySelector("#exit-night").onclick = () => {
  const now = new Date();
  override = { active: false, schedule: clockMode(now).scheduled, expires: +now + 300000 };
  tick();
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
window.addEventListener("online", () => {
  Object.keys(due).forEach(name => { due[name] = 0; });
  tick();
});
tick();
setInterval(tick, 1000);
