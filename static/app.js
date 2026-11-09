"use strict";

const zone = "America/Denver";
const names = {
  clock: "Clock", calendar: "Calendar", agenda: "Coming up",
  weather: "Weather", next: "Next up", reminders: "Reminders", verse: "Verse of the day",
  daylight: "Daylight", today: "Today’s schedule", tomorrow: "Tomorrow’s schedule", forecast: "Three-day forecast",
  spotlight: "Photo spotlight", countdowns: "Countdowns", notes: "Household note"
};
const widgetDetails = {
  clock: "Time and date in the top bar", next: "The next calendar event in a slim strip",
  calendar: "A color-coded week or month", weather: "Current conditions and today’s outlook",
  daylight: "Local sunrise and sunset", reminders: "Chores, assignments and checkboxes",
  verse: "A KJV verse that changes at midnight", agenda: "The next seven days in a list",
  today: "The remaining events today", tomorrow: "A heads-up for tomorrow",
  forecast: "Highs, lows and rain chances", spotlight: "A rotating photo from your album",
  countdowns: "Days until your own dates", notes: "A message for the household"
};
const choreDays = ["Daily", "Weekly", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const labels = { calendar: "Calendar", weather: "Weather", album: "Album" };
const data = {};
const due = {};
const pending = new Map();
const cards = {};
const verseObserver = typeof ResizeObserver === "function"
  ? new ResizeObserver(entries => entries.forEach(entry => fitVerse(entry.target)))
  : null;
const board = document.querySelector("#board");
const eventDialog = document.querySelector("#event-detail");
const headerClock = document.querySelector("#header-clock");
const refreshButton = document.querySelector("#refresh-feeds");
const refreshStatus = document.querySelector("#refresh-status");
const form = document.querySelector("#editor-form");
const editor = document.querySelector("#editor");
const scenery = document.querySelector("#scenery");
const clockFormat = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" });
const keyFormat = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
const minutesFormat = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const monthFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long" });
const weekdayFormat = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" });
const dateDetailFormat = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "long", day: "numeric" });
const eventDateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", weekday: "long", month: "long", day: "numeric"
});
const shortFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

let settings;
let draft;
let anchor;
const weekDaysStorageKey = "wallboard.weekDays";
let weekDays = 7;
try {
  if (localStorage.getItem(weekDaysStorageKey) === "4") weekDays = 4;
} catch (_) {
  // The toggle still works for this session if storage is unavailable.
}
let dayKey = "";
let lastMinute = "";
let lastNight = false;
let override;
let photoIndex = -1;
let photoVersion = 0;
let nextPhoto = 0;
let photoUrl = "";
let fetchGeneration = 0;
let assignmentWeek = "";
let reminderNotice = "";
let completionSaving = false;

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

function showEventDetails(event) {
  const start = startKey(event);
  // All-day dates have an exclusive end, while timed events end at the actual instant shown.
  const end = event.allDay ? utcKey(shift(calendarDay(event.end), -1)) : keyOf(new Date(event.end));
  const firstDate = eventDateFormat.format(calendarDay(start));
  const date = end > start ? firstDate + " – " + eventDateFormat.format(calendarDay(end)) : firstDate;
  const time = event.allDay ? "All day" :
    clockFormat.format(new Date(event.start)) + " – " + clockFormat.format(new Date(event.end)) + " · Mountain Time";
  const calendar = eventDialog.querySelector("#event-detail-calendar");
  calendar.textContent = event.calendar;
  calendar.style.setProperty("--event", event.color);
  eventDialog.querySelector("#event-detail-title").textContent = event.title;
  eventDialog.querySelector("#event-detail-date").textContent = date;
  eventDialog.querySelector("#event-detail-time").textContent = time;
  eventDialog.querySelector("#event-detail-location").textContent = event.location || "No location listed";
  eventDialog.showModal();
}

eventDialog.addEventListener("click", event => {
  if (event.target !== eventDialog) return;
  const bounds = eventDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) eventDialog.close();
});

function showCalendar(head, body) {
  const week = settings.calendarView === "week";
  const four = week && weekDays === 4;
  const today = calendarDay(dayKey);
  const view = anchor || today;
  const period = four ? today : week ? shift(view, -view.getUTCDay()) :
    new Date(Date.UTC(view.getUTCFullYear(), view.getUTCMonth(), 1));
  const first = week ? period : shift(period, -period.getUTCDay());
  const last = week ? shift(period, weekDays - 1) :
    shift(new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 1)), -1);
  const slots = week ? weekDays : Math.ceil(((last - first) / 86400000 + 1) / 7) * 7;
  const title = week ? shortFormat.format(period) + " – " + shortFormat.format(last) : monthFormat.format(period);
  const caption = elem("div", undefined, "calendar-caption");
  caption.appendChild(elem("p", title, "month-title"));
  head.appendChild(caption);
  const controls = elem("div", undefined, "calendar-controls");
  if (week) {
    const range = elem("div", undefined, "calendar-range");
    range.setAttribute("role", "group");
    range.setAttribute("aria-label", "Calendar days shown");
    [[4, "4 days"], [7, "Full week"]].forEach(([count, label]) => {
      const control = button(label, label, () => {
        if (weekDays === count) return;
        weekDays = count;
        try { localStorage.setItem(weekDaysStorageKey, String(count)); } catch (_) {}
        renderCard("calendar");
        head.querySelector('.calendar-range [aria-pressed="true"]').focus({preventScroll: true});
      });
      control.setAttribute("aria-pressed", String(weekDays === count));
      range.appendChild(control);
    });
    controls.appendChild(range);
  }
  if (!four) {
    const nav = elem("div", undefined, "month-nav");
    const current = week ? shift(today, -today.getUTCDay()) :
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const todayButton = button("Today", "Return to today", () => { anchor = null; renderCard("calendar"); });
    todayButton.hidden = +current === +period;
    nav.appendChild(todayButton);
    [-1, 1].forEach(direction => {
      const target = week ? shift(period, 7 * direction) :
        new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + direction, 1));
      const label = (direction < 0 ? "Previous " : "Next ") + (week ? "week" : "month");
      const control = button(direction < 0 ? "‹" : "›", label, () => {
        anchor = target;
        renderCard("calendar");
        const replacement = head.querySelector('[aria-label="' + label + '"]');
        if (!replacement.disabled) replacement.focus({preventScroll: true});
      });
      control.disabled = Math.abs(target - today) > 65 * 86400000;
      nav.appendChild(control);
    });
    controls.appendChild(nav);
  }
  head.appendChild(controls);
  const grid = elem("div", undefined, four ? "grid week four-day" : week ? "grid week" : "grid month");
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (!week) weekdays.forEach(d => grid.appendChild(elem("div", d, "weekday")));
  const events = data.calendar ? data.calendar.data : [];
  for (let i = 0; i < slots; i++) {
    const date = shift(first, i);
    const key = utcKey(date);
    const classes = "cell" + (key === dayKey ? " today" : "") +
      (!week && date.getUTCMonth() !== period.getUTCMonth() ? " outside" : "");
    const cell = elem("div", undefined, classes);
    const dateHead = elem("div", undefined, "cell-date");
    dateHead.appendChild(elem("span", String(date.getUTCDate()), "day-num"));
    if (week) dateHead.appendChild(elem("span", weekdays[date.getUTCDay()], "weekday"));
    if (key === dayKey) dateHead.setAttribute("aria-current", "date");
    cell.appendChild(dateHead);
    const matches = events.filter(event => overlaps(event, key))
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.start) - Date.parse(b.start));
    if (matches.length) {
      const list = elem("div", undefined, week ? "week-events" : "mini-events");
      matches.slice(0, week ? matches.length : 6).forEach(event => {
        if (!week) {
          list.appendChild(dot(event));
          return;
        }
        const entry = elem("button", undefined, "week-event");
        entry.type = "button";
        entry.setAttribute("aria-haspopup", "dialog");
        entry.addEventListener("click", () => showEventDetails(event));
        entry.style.setProperty("--event", event.color);
        const when = event.allDay ? "All day" : startKey(event) < key ? "Continues" : clockFormat.format(new Date(event.start));
        entry.appendChild(elem("span", when, "week-time"));
        entry.appendChild(elem("span", event.title, "week-title"));
        list.appendChild(entry);
      });
      if (!week && matches.length > 6) list.appendChild(elem("span", "+" + (matches.length - 6), "month-more"));
      cell.appendChild(list);
    }
    grid.appendChild(cell);
  }
  body.appendChild(grid);
  const sources = new Map();
  events.forEach(event => sources.set(event.calendar, event));
  if (sources.size) {
    const legend = elem("div", undefined, "calendar-legend");
    sources.forEach(event => {
      const item = elem("span", undefined, "legend-item");
      const swatch = dot(event);
      swatch.removeAttribute("title");
      item.appendChild(swatch);
      item.appendChild(elem("span", event.calendar));
      legend.appendChild(item);
    });
    body.appendChild(legend);
  }
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
    row.style.setProperty("--event", event.color);
    const [day, time] = describeWhen(event).split(" · ");
    const when = elem("div", undefined, "event-time");
    when.appendChild(elem("span", day, "event-day"));
    if (time) when.appendChild(elem("span", time));
    const details = elem("div", undefined, "event-details");
    const title = elem("strong", event.title);
    title.title = event.title;
    const metadata = event.calendar + (event.location ? " · " + event.location : "");
    const meta = elem("span", metadata, "detail");
    meta.title = metadata;
    details.append(title, meta);
    row.append(when, details);
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

function weatherIcon(code) {
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  icon.setAttribute("viewBox", "0 0 32 32");
  icon.setAttribute("aria-hidden", "true");
  icon.classList.add("weather-icon");
  const sun = "M22 16a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM16 3v3m0 20v3M3 16h3m20 0h3M7 7l2 2m14 14 2 2M7 25l2-2M23 9l2-2";
  const cloud = "M8 22a5 5 0 1 1 1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 2 11H8Z";
  const drops = "M10 25l-1 3m8-3-1 3m8-3-1 3";
  const flake = "M10 26h.01m6 2h.01m6-2h.01";
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", code <= 1 ? sun : cloud + (code >= 71 && code <= 77 || code === 85 || code === 86 ? flake : code >= 50 ? drops : ""));
  icon.appendChild(path);
  return icon;
}

function showWeather(body) {
  const source = data.weather;
  if (!source || !source.data) {
    addStatus(body, "weather");
    return;
  }
  const values = source.data;
  const current = elem("div", undefined, "weather-current");
  const temp = elem("p", degrees(values.temperature), "temperature");
  temp.appendChild(elem("span", "F", "temperature-unit"));
  const place = elem("p", undefined, "weather-place");
  place.append(weatherIcon(values.code), document.createTextNode(condition(values.code) + " · " + source.location.split(" · ")[0]));
  current.append(temp, place);
  const details = elem("dl", undefined, "weather-details");
  const metrics = [["High / low", degrees(values.high) + " / " + degrees(values.low)],
                   ["Precipitation", Number.isFinite(values.precipitation) ? values.precipitation + "%" : "–"]];
  metrics.forEach(([label, value]) => {
    const row = elem("div");
    row.append(elem("dt", label), elem("dd", value));
    details.appendChild(row);
  });
  const reading = elem("div", undefined, "weather-reading");
  reading.append(current, details);
  const attribution = elem("a", "Open-Meteo", "weather-credit");
  attribution.href = "https://open-meteo.com/";
  body.append(reading, attribution);
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
  const meta = elem("div", undefined, "next-meta");
  meta.style.setProperty("--event", event.color);
  if (!event.allDay && left > 0 && left <= 180) {
    const countdown = left < 60 ? "In " + left + " min" :
      "In " + Math.floor(left / 60) + " hr" + (left % 60 ? " " + left % 60 + " min" : "");
    meta.appendChild(elem("span", countdown, "countdown"));
  }
  meta.appendChild(elem("span", describeWhen(event), "feature-detail"));
  body.appendChild(meta);
}

function forecastDays() {
  return (data.weather && data.weather.data && data.weather.data.forecast) || [];
}

function sunTimes() {
  return forecastDays().find(day => day.date === dayKey);
}

function showDaylight(body) {
  const sun = sunTimes();
  if (!sun || !sun.sunrise || !sun.sunset) {
    body.appendChild(elem("p", "Sunrise and sunset are unavailable.", "empty"));
    return;
  }
  const line = elem("div", undefined, "daylight-times");
  [["Sunrise", sun.sunrise], ["Sunset", sun.sunset]].forEach(([label, date]) => {
    const parts = date.slice(11, 16).split(":").map(Number);
    const time = (parts[0] % 12 || 12) + ":" + String(parts[1]).padStart(2, "0") + (parts[0] < 12 ? " AM" : " PM");
    const pair = elem("span", undefined, "daylight-pair");
    pair.append(elem("span", label, "detail"), elem("strong", time));
    line.appendChild(pair);
  });
  body.appendChild(line);
}

function showForecast(body) {
  const days = forecastDays().filter(day => day.date >= dayKey);
  if (!days.length) { addStatus(body, "weather"); return; }
  const list = elem("ul", undefined, "widget-list");
  days.forEach(day => {
    const line = elem("li");
    const label = day.date === dayKey ? "Today" : shortFormat.format(calendarDay(day.date));
    line.append(elem("strong", label), elem("span", condition(day.code) + " · " + degrees(day.high) + " / " +
      degrees(day.low) + (Number.isFinite(day.precipitation) ? " · " + day.precipitation + "% rain/snow" : ""), "detail"));
    list.appendChild(line);
  });
  body.appendChild(list);
}

function showDaySchedule(body, offset) {
  const key = utcKey(shift(calendarDay(dayKey), offset));
  const events = currentEvents(new Date()).filter(event => overlaps(event, key));
  const list = elem("ul", undefined, "widget-list");
  events.forEach(event => {
    const line = elem("li");
    line.append(dot(event), elem("strong", event.title), elem("span", event.allDay ? "All day" :
      startKey(event) < key ? "Ongoing" : clockFormat.format(new Date(event.start)), "detail"));
    list.appendChild(line);
  });
  if (!events.length && data.calendar && data.calendar.status === "ok") body.appendChild(elem("p", "Nothing scheduled.", "empty"));
  body.appendChild(list);
  addStatus(body, "calendar");
}

function showCountdowns(body) {
  const list = elem("ul", undefined, "widget-list");
  settings.countdowns.filter(item => item.date >= dayKey).sort((a, b) => a.date.localeCompare(b.date)).forEach(item => {
    const days = Math.round((calendarDay(item.date) - calendarDay(dayKey)) / 86400000);
    const row = elem("li");
    row.append(elem("strong", item.title), elem("span", days === 0 ? "Today" : days + (days === 1 ? " day" : " days"), "detail"));
    list.appendChild(row);
  });
  if (!list.children.length) body.appendChild(elem("p", "Add a future date in Customize.", "empty"));
  body.appendChild(list);
}

function monday(key, offset = 0) {
  const date = calendarDay(key);
  return utcKey(shift(date, -((date.getUTCDay() + 6) % 7) + 7 * offset));
}

function assignedChild(config, chore, week) {
  const overrides = config.assignments[week] || {};
  return Object.prototype.hasOwnProperty.call(overrides, chore.id) ? overrides[chore.id] : chore.assignee;
}

function showReminders(head, body) {
  head.appendChild(button("Edit assignments", "Edit reminders and weekly assignments", () => openEditor("chores")));
  if (!settings.chores.length) {
    body.appendChild(elem("p", "Add chores and assign them in Edit assignments.", "empty"));
    return;
  }
  const list = elem("div", undefined, "chore-list");
  const header = elem("div", undefined, "chore-row chore-labels");
  ["Chore", "Due", "Assigned to"].forEach(label => header.appendChild(elem("span", label)));
  list.appendChild(header);
  const current = monday(dayKey);
  settings.chores.forEach(chore => {
    const row = elem("div", undefined, "chore-row");
    const label = elem("label");
    const check = elem("input");
    check.type = "checkbox";
    const item = data.chores && data.chores[chore.id];
    check.checked = Boolean(item && item.done);
    check.disabled = !item || completionSaving;
    check.onchange = async () => {
      completionSaving = true;
      reminderNotice = "";
      renderCard("reminders");
      try {
        const response = await fetch("/api/chores", {method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({id: chore.id, period: item.period, done: check.checked})});
        if (!response.ok) throw new Error();
        data.chores = await response.json();
        due.chores = 0;
      } catch (_) {
        reminderNotice = "Could not save. Refresh and try again.";
        due.chores = 0;
      } finally {
        completionSaving = false;
        renderCard("reminders");
      }
    };
    label.append(check, elem("span", chore.title));
    row.append(label, elem("span", chore.due, "detail"),
      elem("span", assignedChild(settings, chore, current) || "Unassigned", "chore-child"));
    list.appendChild(row);
  });
  body.appendChild(list);
  if (reminderNotice) body.appendChild(elem("p", reminderNotice, "status-note"));
}

function showSpotlight(body) {
  const img = elem("img");
  img.alt = photoUrl ? "Photo from the shared album" : "Scenic landscape";
  img.src = photoUrl || "/background.jpg";
  body.appendChild(img);
}

function renderClock(now) {
  clear(headerClock);
  const time = elem("time", undefined, "clock-value");
  time.dateTime = now.toISOString();
  const parts = clockFormat.formatToParts(now);
  time.appendChild(document.createTextNode(parts.filter(p => p.type !== "dayPeriod").map(p => p.value).join("").trim()));
  const period = parts.find(p => p.type === "dayPeriod");
  if (period) time.appendChild(elem("span", period.value, "clock-period"));
  const date = elem("div", undefined, "date-label");
  date.append(elem("span", weekdayFormat.format(now)), elem("span", dateDetailFormat.format(now)));
  headerClock.append(time, date);
}

function fitVerse(body) {
  const content = body.querySelector(".verse-content");
  if (!content || !body.clientHeight) return;
  let low = 10;
  let high = Math.max(19, Math.min(44, Math.round(body.clientWidth * .045)));
  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    content.style.setProperty("--verse-size", size + "px");
    if (content.getBoundingClientRect().height <= body.clientHeight) low = size;
    else high = size - 1;
  }
  content.style.setProperty("--verse-size", low + "px");
}

function packWidgets(widgets) {
  const packed = [];
  for (let i = 0; i < widgets.length; i++) {
    const [weather, daylight, reminders] = widgets.slice(i, i + 3);
    if (weather.id === "weather" && daylight && daylight.id === "daylight" && daylight.size === weather.size
        && reminders && reminders.id === "reminders" && weather.size + reminders.size === 12) {
      packed.push({id: "stack", size: weather.size, children: [weather, daylight]});
      i++;
    } else {
      packed.push(weather);
    }
  }
  return packed;
}

function setBoardRows(widgets) {
  const weights = [];
  let remaining = 0;
  widgets.forEach(widget => {
    if (remaining < widget.size) {
      weights.push({weight: 0, compact: false, stack: false});
      remaining = 12;
    }
    remaining -= widget.size;
    const row = weights[weights.length - 1];
    row.compact = widget.id === "next" && widget.size === 12;
    row.stack = row.stack || widget.id === "stack";
    row.weight = Math.max(row.weight, {calendar: 2.8, agenda: 2, stack: 1.5, reminders: 1.5, verse: .8}[widget.id] || 1);
  });
  board.style.setProperty("--card-rows", weights.map(row => row.compact ? "auto" :
    "minmax(" + (row.stack ? "148px" : "min(72px,13vh)") + "," + row.weight + "fr)").join(" "));
}

function renderCard(id) {
  const card = cards[id];
  if (!card || !dayKey) return;
  const head = card.querySelector(".card-head");
  const body = card.querySelector(".card-body");
  clear(head);
  clear(body);
  if (!["verse", "calendar", "weather"].includes(id)) head.appendChild(elem("h2", names[id]));
  if (id === "calendar") showCalendar(head, body);
  if (id === "agenda") showAgenda(body);
  if (id === "weather") showWeather(body);
  if (id === "next") showNext(body);
  if (id === "reminders") showReminders(head, body);
  if (id === "daylight") showDaylight(body);
  if (id === "forecast") showForecast(body);
  if (id === "today" || id === "tomorrow") showDaySchedule(body, id === "today" ? 0 : 1);
  if (id === "spotlight") showSpotlight(body);
  if (id === "countdowns") showCountdowns(body);
  if (id === "notes") body.appendChild(elem("p", settings.notes || "Add a household note in Customize.", "house-note"));
  if (id === "verse") {
    if (data.verse && data.verse.date === dayKey) {
      const content = elem("div", undefined, "verse-content");
      content.appendChild(elem("blockquote", "“" + data.verse.text + "”", "verse-line"));
      content.appendChild(elem("p", data.verse.reference + " · KJV", "verse-ref"));
      body.appendChild(content);
      fitVerse(body);
    } else {
      body.appendChild(elem("p", "Loading today’s verse…", "empty"));
    }
  }
}

function applyFont(name) {
  const style = document.documentElement.style;
  if (!name || name === "System") {
    style.removeProperty("--board-font");
    style.removeProperty("--verse-font");
    return;
  }
  const family = JSON.stringify(name);
  style.setProperty("--board-font", family + ", system-ui, sans-serif");
  style.setProperty("--verse-font", family + ", Georgia, serif");
  if (document.fonts) {
    document.fonts.load("16px " + family).then(() => {
      if (cards.verse) fitVerse(cards.verse.querySelector(".card-body"));
    }).catch(() => {});
  }
}

function applySettings(value) {
  const old = settings;
  if (old && JSON.stringify(old) === JSON.stringify(value)) return;
  settings = value;
  applyAppearance(new Date());
  due.chores = 0;
  if (!old || old.font !== value.font) applyFont(value.font);
  headerClock.hidden = !settings.widgets.some(widget => widget.id === "clock" && widget.visible);
  renderClock(new Date());
  document.body.classList.toggle("no-photo", !settings.photo);
  document.querySelector("#photo-footer").hidden = !settings.photo;
  if (!old || old.calendarView !== value.calendarView) anchor = null;
  if (!old || JSON.stringify(old.widgets) !== JSON.stringify(value.widgets)) {
    if (verseObserver) verseObserver.disconnect();
    clear(board);
    Object.keys(cards).forEach(id => { delete cards[id]; });
    const widgets = value.widgets.filter(widget => widget.visible && widget.id !== "clock");
    const packed = packWidgets(widgets);
    setBoardRows(packed);
    const createCard = (widget, container) => {
      const card = document.querySelector("#card").content.firstElementChild.cloneNode(true);
      card.classList.add("card-" + widget.id);
      if (widget.size === 12) card.classList.add("full-width");
      if (["weather", "verse", "calendar"].includes(widget.id)) card.setAttribute("aria-label", names[widget.id]);
      card.style.setProperty("--span", widget.size);
      cards[widget.id] = card;
      container.appendChild(card);
      if (widget.id === "verse" && verseObserver) verseObserver.observe(card.querySelector(".card-body"));
    };
    packed.forEach(widget => {
      if (!widget.children) { createCard(widget, board); return; }
      const stack = elem("div", undefined, "widget-stack");
      stack.style.setProperty("--span", widget.size);
      board.appendChild(stack);
      widget.children.forEach(child => createCard(child, stack));
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
  if ((!settings.photo && !cards.spotlight) || lastNight) return;
  const urls = data.album && data.album.data;
  if (!urls || !urls.length) {
    if (photoUrl) {
      scenery.style.removeProperty("--photo");
      const link = elem("a", "Scenic photo · Unsplash");
      link.href = "https://images.unsplash.com/photo-1470770841072-f978cf4d019e";
      clear(credit);
      credit.appendChild(link);
    }
    if (photoUrl) {
      photoUrl = "";
      renderCard("spotlight");
    }
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
    renderCard("spotlight");
    scenery.style.setProperty("--photo", "url(" + JSON.stringify(url) + ")");
    document.querySelector("#photo-credit").textContent = "ICLOUD SHARED ALBUM";
  };
  image.onerror = () => { if (ticket === photoVersion) nextPhoto = Date.now() + 30000; };
  image.src = url;
}

function get(name, minutes, callback, force = false) {
  const inFlight = pending.get(name);
  if (inFlight) return force ? inFlight.then(() => get(name, minutes, callback, true)) : inFlight;
  if (!force && (due[name] || 0) > Date.now()) return;
  const generation = fetchGeneration;
  const request = fetch("/api/" + name + (force ? "?refresh=1" : ""), { cache: "no-store" })
    .then(response => {
      if (!response.ok) throw new Error("Could not load " + name);
      return response.json();
    })
    .then(value => {
      due[name] = (generation === fetchGeneration || name === "settings") ?
        Date.now() + ((value.status === "unavailable" || value.status === "stale") ? Math.min(minutes, 1) : minutes) * 60000 : 0;
      callback(value);
      if (name === "settings") document.querySelector("#connection").textContent = "";
      return !["unavailable", "stale", "partial"].includes(value.status);
    })
    .catch(() => {
      due[name] = Date.now() + 15000;
      if (name === "settings") document.querySelector("#connection").textContent = "Connection interrupted";
      return false;
    })
    .then(success => {
      pending.delete(name);
      return success;
    });
  pending.set(name, request);
  return request;
}

function refreshFeeds(force = false) {
  const requests = [
    get("settings", 0.2, applySettings, force),
    get("verse", 60, value => {
      if (value.date !== dayKey) { due.verse = 0; return; }
      data.verse = value;
      renderCard("verse");
    }, force)
  ];
  if (!settings) return requests;
  requests.push(
    get("calendar", settings.refresh.calendar, value => {
      data.calendar = value;
      ["calendar", "agenda", "next", "today", "tomorrow"].forEach(renderCard);
    }, force),
    get("weather", settings.refresh.weather, value => {
      data.weather = value;
      ["weather", "daylight", "forecast"].forEach(renderCard);
      applyAppearance(new Date());
    }, force)
  );
  if (cards.reminders && !completionSaving) {
    requests.push(get("chores", .25, value => {
      if (completionSaving || JSON.stringify(data.chores) === JSON.stringify(value)) return;
      data.chores = value;
      renderCard("reminders");
    }, force));
  }
  if (settings.photo || cards.spotlight) {
    requests.push(get("album", settings.refresh.album, value => {
      data.album = value;
      if (!photoUrl) nextPhoto = 0;
      updatePhoto(Date.now());
    }, force));
  }
  return requests;
}

function applyAppearance(now) {
  const minutes = minutesFormat.format(now);
  const sun = sunTimes();
  const rise = sun && sun.sunrise ? sun.sunrise.slice(11, 16) : "06:30";
  const set = sun && sun.sunset ? sun.sunset.slice(11, 16) : "18:00";
  const dark = settings.appearance === "dark" ||
    (settings.appearance === "auto" && (minutes < rise || minutes >= set));
  document.body.classList.toggle("theme-dark", dark);
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
    due.calendar = due.weather = due.chores = 0;
    if (settings) ["calendar", "agenda", "verse", "today", "tomorrow", "daylight", "countdowns", "reminders"].forEach(renderCard);
  }
  refreshFeeds();
  if (!settings) return;
  const night = clockMode(now).active && editor.hidden;
  if (night !== lastNight) {
    lastNight = night;
    if (night && eventDialog.open) eventDialog.close();
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
    renderClock(now);
    applyAppearance(now);
    ["next", "agenda", "today"].forEach(renderCard);
  }
  updatePhoto(+now);
}

function drawEditor() {
  const list = document.querySelector("#widget-settings");
  const catalog = document.querySelector("#widget-catalog");
  clear(list);
  clear(catalog);
  const movable = draft.widgets.filter(widget => widget.visible && widget.id !== "clock");
  draft.widgets.forEach(widget => {
    const row = elem("div", undefined, widget.visible ? "widget-option" : "catalog-option");
    const label = elem("div");
    label.append(elem("strong", names[widget.id]), elem("span", widgetDetails[widget.id], "detail"));
    row.appendChild(label);
    if (!widget.visible) {
      row.appendChild(button("Add", "Add " + names[widget.id], () => {
        widget.visible = true;
        draft.widgets.splice(draft.widgets.indexOf(widget), 1);
        if (widget.id === "clock") draft.widgets.unshift(widget);
        else draft.widgets.push(widget);
        drawEditor();
      }));
      catalog.appendChild(row);
      return;
    }
    if (widget.id === "clock") {
      row.appendChild(elem("span", "Top bar", "detail"));
    } else {
      const width = choreSelect(Array.from({length: 10}, (_, i) => [i + 3, i === 9 ? "Full width" : (i + 3) + " / 12"]),
        widget.size, names[widget.id] + " width");
      width.onchange = () => { widget.size = Number(width.value); };
      row.appendChild(width);
      const index = movable.indexOf(widget);
      [-1, 1].forEach(delta => {
        const target = index + delta;
        const control = button(delta < 0 ? "↑" : "↓", "Move " + names[widget.id] + (delta < 0 ? " up" : " down"), () => {
          const a = draft.widgets.indexOf(widget);
          const b = draft.widgets.indexOf(movable[target]);
          [draft.widgets[a], draft.widgets[b]] = [draft.widgets[b], draft.widgets[a]];
          drawEditor();
        });
        control.disabled = target < 0 || target >= movable.length;
        row.appendChild(control);
      });
    }
    row.appendChild(button("Hide", "Hide " + names[widget.id], () => {
      widget.visible = false;
      drawEditor();
    }));
    list.appendChild(row);
  });
  if (!catalog.children.length) catalog.appendChild(elem("p", "All widgets are enabled.", "empty"));
}

function choreSelect(values, selected, label) {
  const picker = elem("select");
  picker.setAttribute("aria-label", label);
  values.forEach(([value, name]) => {
    const option = elem("option", name);
    option.value = value;
    picker.appendChild(option);
  });
  picker.value = selected;
  return picker;
}

function drawChoreEditor() {
  const list = document.querySelector("#chore-settings-list");
  clear(list);
  draft.chores.forEach((chore, index) => {
    const row = elem("div", undefined, "chore-editor-row");
    const title = elem("input");
    title.setAttribute("aria-label", "Chore name");
    title.placeholder = "Chore name";
    title.maxLength = 150;
    title.value = chore.title;
    title.oninput = () => { chore.title = title.value; };
    const schedule = choreSelect(choreDays.map(day => [day, day]), chore.due, "When " + (chore.title || "chore") + " is due");
    schedule.onchange = () => { chore.due = schedule.value; };
    const options = [["", "Unassigned"], ...draft.children.map(name => [name, name])];
    const week = draft.assignments[assignmentWeek] || {};
    const selected = assignmentWeek ? (Object.prototype.hasOwnProperty.call(week, chore.id) ? week[chore.id] : "@default") : chore.assignee;
    const assigned = choreSelect(assignmentWeek ? [["@default", "Usual assignment"], ...options] : options,
      selected, "Assign " + (chore.title || "chore"));
    assigned.onchange = () => {
      if (!assignmentWeek) chore.assignee = assigned.value;
      else {
        const overrides = draft.assignments[assignmentWeek] || (draft.assignments[assignmentWeek] = {});
        if (assigned.value === "@default") delete overrides[chore.id];
        else overrides[chore.id] = assigned.value;
      }
    };
    const remove = button("×", "Remove " + (chore.title || "chore"), () => {
      draft.chores.splice(index, 1);
      drawChoreEditor();
    });
    row.append(title, schedule, assigned, remove);
    list.appendChild(row);
  });
  document.querySelector("#add-chore").disabled = draft.chores.length >= 30;
}

function readChildren() {
  const previous = draft.children;
  draft.children = [...new Set(field("children").value.split(",").map(name => name.trim().slice(0, 35))
    .filter(name => name && name !== "@default"))].slice(0, 12);
  if (JSON.stringify(previous) !== JSON.stringify(draft.children)) drawChoreEditor();
}

function setupChoreEditor() {
  assignmentWeek = "";
  field("children").value = draft.children.join(", ");
  const picker = field("assignmentWeek");
  clear(picker);
  const usual = elem("option", "Usual assignment");
  usual.value = "";
  picker.appendChild(usual);
  for (let i = 0; i < 12; i++) {
    const key = monday(dayKey, i);
    const start = calendarDay(key);
    const option = elem("option", shortFormat.format(start) + " – " + shortFormat.format(shift(start, 6)));
    option.value = key;
    picker.appendChild(option);
  }
  drawChoreEditor();
}

function field(name) {
  return form.elements.namedItem(name);
}

function openEditor(section) {
  if (!settings) return;
  draft = JSON.parse(JSON.stringify(settings));
  const clock = draft.widgets.findIndex(widget => widget.id === "clock");
  draft.widgets.unshift(draft.widgets.splice(clock, 1)[0]);
  drawEditor();
  ["nightStart", "nightEnd", "calendarView", "font", "appearance"].forEach(name => { field(name).value = draft[name]; });
  Object.keys(draft.refresh).forEach(name => { field(name).value = draft.refresh[name]; });
  field("photo").checked = draft.photo;
  field("notes").value = draft.notes;
  field("countdowns").value = draft.countdowns.map(item => item.date + " | " + item.title).join("\n");
  setupChoreEditor();
  field("key").value = "";
  document.querySelector("#save-status").textContent = "";
  editor.hidden = false;
  editor.scrollTop = 0;
  if (section === "chores") {
    document.querySelector("#chores-settings").scrollIntoView({block: "start"});
    field("children").focus({preventScroll: true});
  } else {
    document.querySelector("#close-settings").focus();
  }
}

function closeEditor() {
  editor.hidden = true;
  document.querySelector("#open-settings").focus();
  tick();
}

field("children").onchange = readChildren;
field("assignmentWeek").onchange = () => {
  assignmentWeek = field("assignmentWeek").value;
  drawChoreEditor();
};
document.querySelector("#add-chore").onclick = () => {
  if (draft.chores.length >= 30) return;
  const id = "chore-" + Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join("-");
  draft.chores.push({id, title: "", due: "Weekly", assignee: ""});
  drawChoreEditor();
  document.querySelector("#chore-settings-list .chore-editor-row:last-child input").focus();
};

form.addEventListener("submit", event => {
  event.preventDefault();
  ["nightStart", "nightEnd", "calendarView", "font", "appearance"].forEach(name => { draft[name] = field(name).value; });
  Object.keys(draft.refresh).forEach(name => { draft.refresh[name] = Number(field(name).value); });
  readChildren();
  draft.notes = field("notes").value;
  draft.countdowns = field("countdowns").value.split("\n").filter(line => line.trim()).map(line => {
    const divider = line.indexOf("|");
    return divider < 0 ? {date: "", title: line.trim()} :
      {date: line.slice(0, divider).trim(), title: line.slice(divider + 1).trim()};
  });
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

let refreshFeedback;
refreshButton.onclick = async () => {
  if (refreshButton.disabled) return;
  clearTimeout(refreshFeedback);
  refreshButton.disabled = true;
  refreshButton.dataset.state = "busy";
  refreshStatus.textContent = "Refreshing dashboard";
  const results = await Promise.all(refreshFeeds(true));
  const success = results.every(Boolean);
  refreshButton.dataset.state = success ? "done" : "error";
  refreshStatus.textContent = success ? "Dashboard refreshed" : "Some dashboard data could not refresh";
  refreshButton.title = refreshStatus.textContent;
  refreshButton.disabled = false;
  refreshFeedback = setTimeout(() => {
    delete refreshButton.dataset.state;
    refreshButton.title = "Refresh dashboard";
  }, 2500);
};
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
