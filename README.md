# Home Wallboard

The wallboard runs on the home network at **http://192.168.1.184:8765/**. Open it in Safari on the iPad in landscape. In Safari, use Share → Add to Home Screen and turn on Open as Web App if offered. For a dedicated display, you can also set up Guided Access and choose a display auto-lock setting.

The live dashboard includes weather for 80550, a month or week calendar, Next Up, Daylight, weekly household reminders, and a local 41-verse King James Version rotation. The daily verse changes at midnight in America/Denver. Auto appearance switches the dashboard between light and dark at the local sunrise and sunset. If daylight data is unavailable, it uses 6:30 a.m. and 6 p.m. The separate dim clock-only display defaults to 10 p.m.–5 a.m. The moon icon previews night mode, and the round arrow fetches fresh dashboard data. Show dashboard overrides the night schedule for five minutes.

## Customize

Set the PIN in **data/sources.json** using a quoted value such as **"edit_pin": "0427"**. Quoting it preserves leading zeroes. The dashboard reads it on each save, so there is no need to restart. Run the following in this directory on the host to show the current PIN.

    .venv/bin/python server.py --edit-pin

Tap the sliders icon in the top-right corner to customize the dashboard. Add widgets from **Available widgets** or use **Hide** to return them to the library. Use the arrows and width selector under **On the dashboard** to arrange them on a twelve-column grid. The clock stays in the top bar. If equally wide Weather and Daylight cards sit immediately before Reminders and the width of the stack plus the width of Reminders fills a row, Weather and Daylight stack alongside Reminders.

The library includes Coming Up, Today's schedule, Tomorrow's schedule, a three-day forecast, Photo spotlight, Countdowns, and Household note. Add dates and note text in Customize. Choose a font, set the clock-only schedule, and pick Auto, Light, or Dark appearance. Saving these changes requires the edit PIN.

Use **Edit assignments** in Reminders to add chores, children, and usual assignments. Select an **Assignment week** to override the assignee for one week. Daily chores reset each day and other chores reset on Monday. Checkoffs can be made from the display and are shared with the other displays.

## Connect iCloud

On the host, open the private configuration file with an editor.

    nano data/sources.json

- Add public calendar subscriptions under **public_calendars**. Use either a bare **https://** or **webcal://** subscription URL, or an object with **url**, optional **name**, optional **color**, and optional **busy_only**. The feed supplies the name when it is omitted. Use a quoted six-digit hex color such as **"#72dfc1"**. Set **busy_only** to **true** to hide event details.
- For private calendars, enter your Apple Account email and an [app-specific password](https://support.apple.com/en-us/102654) in the **icloud** object. Use the command below to list calendars available to the account. Add only the calendars you want to show to **icloud.calendars**, as objects with **name** (matching the listed name exactly) and optional **color** and **busy_only**. The app only requests calendar data. Events individually marked private or confidential are also shown as “Busy.”
- Under **album_url**, paste the Public Website URL for the [iCloud Shared Album](https://support.apple.com/en-lamr/guide/icloud/mme985ae44d8/1.0/icloud/1.0). Use the newer **photos.icloud.com/shared/album/…** link with **Anyone with the Link**, or the older **www.icloud.com/sharedalbum/#…** Public Website link. Apple lets anyone with this link view the album. Background rotation uses the first 250 photos returned by Apple's Shared Album website. If the album is empty or the website feed is unavailable, the display can use the bundled scenic photo. The website feed is undocumented and may change.

    .venv/bin/python server.py --list-calendars

Example shape for sources.json (with placeholder values):

    {
      "edit_pin": "0427",
      "public_calendars": [
        {"name": "Community", "url": "webcal://p00-caldav.icloud.com/published/example", "busy_only": false, "color": "#72dfc1"}
      ],
      "icloud": {
        "email": "your-account@example.com",
        "app_password": "",
        "calendars": [{"name": "Family", "busy_only": false, "color": "#b9adff"}]
      },
      "album_url": "https://www.icloud.com/sharedalbum/#YourAlbumToken",
      "weather": {"latitude": 40.48, "longitude": -104.90, "label": "Windsor · 80550"}
    }

Source settings are reread as feeds refresh, so no restart is needed. Configuration, the edit PIN, and layout settings stay in **data/**, which is ignored by Git. The display is read-only without the edit PIN. The server accepts connections on the host's 192.168.1.184 address from its 192.168.1.0/24 home subnet. Devices on that subnet can read what's on the wall display. Keep the host address reserved on the router and use the app on your trusted home network.

## Host operation

The host uses Python 3.15.2. To recreate the environment:

    ~/.local/opt/python-3.15.2/bin/python3.15 -m venv .venv
    .venv/bin/python -m pip install -r requirements.txt
    .venv/bin/python server.py --init
    ./run.sh

The user's crontab runs **run.sh** once a minute. A file lock keeps a single instance running and the next cron check restarts it if it stops, including after reboot. The host's cron output goes to **data/service.log**. Remove the entry labeled **home-wallboard** before stopping the process if you want it to stay off. If the host IP changes, update the server's bind address and subnet as needed, then restart it.

Forecast data by [Open-Meteo](https://open-meteo.com/). The bundled scenic photo comes from [Unsplash](https://images.unsplash.com/photo-1470770841072-f978cf4d019e).
