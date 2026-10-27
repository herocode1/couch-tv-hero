# couch-tv-hero

A fork of [couch-tv](https://github.com/Seagey/couch-tv) that keeps only the TV home app
(`tv-home/`) and locks it down. The bridge, phone remote, "ask" assistant and on-TV app are still
in the tree from upstream, but they are not built or installed here.

## What is different from upstream

| | upstream | here |
| --- | --- | --- |
| Where the home page comes from | the bridge over plain HTTP, else the copy in the app | **only** the copy built into the app |
| `bridge` intent extra | sets the address the home loads | removed: no app or command can point the home at a web page |
| `config_b64` intent extra | stored as given | re-written by `org.json` before it becomes a script, so its lenient parser can't smuggle code in |
| `tv` intent extra | any text | `a-z` and `-`, up to 32 characters |
| Plain HTTP (`usesCleartextTraffic`) | allowed | off; the page and app icons use `https://*.tvos.invalid`, answered inside the app and never sent to the network |
| WebView debugging | always on | debug builds only |
| Release signing | the debug key | our own key, passed in from outside the repo; with no key the APK is unsigned and won't install |
| Permissions | internet, network state | the same two; CI fails if that changes |

The page still reaches the internet for one thing: the weather, from Open-Meteo over HTTPS, for
the place in `config.json`.

## Building

CI (`.github/workflows/build-tv-home.yml`) builds every pull request. To get a signed APK, add the
key to the repo's Actions secrets (`HERO_KEYSTORE_B64`, `HERO_KEYSTORE_PASSWORD`,
`HERO_KEY_ALIAS`). Locally: `HERO_KEYSTORE=... HERO_KEYSTORE_PASSWORD=... sh scripts/build-apk.sh`.

## Installing safely

Do **not** run `tv-home/tools/apply.sh` as it is on a Google TV whose setup wizard still has its
recovery home (check with `cmd package query-activities ... HOME`). It switches the Google home off
before it sets the new one, and on some TVs that sends Home to the wizard's `RecoveryActivity`,
which can crash-loop the system and take Wi-Fi and ADB with it.

The safe order: install, `cmd package set-home-activity app.couchtv.launcher/.MainActivity` with
the Google home still on, confirm `cmd package resolve-activity ... HOME` names this app, and only
then reboot.

## The Sanctuary look

`home.look: "sanctuary"` puts the Sanctuary look on the TV. The `look` quick button steps
Sanctuary, Night, Classic.

- **The Church's year.** The season is worked out on the TV: Advent, Christmas, Lent and Holy
  Week, Easter, Pentecost and Ordinary Time, with All Saints (25 October to 2 November) getting
  its own window. Moveable feasts follow the United States calendar (Epiphany, Ascension and
  Corpus Christi on Sundays). It also shows a countdown to the next feast within three weeks, and
  a verse for the day from the Douay-Rheims Bible.
- **Art.** `tv-home/web/art/arch-<season>.webp` holds the seven windows, and
  `art/tile-<app>.webp` holds the app tiles. An app with no tile keeps its own icon.
- **Weather.** Set `"unit": "f"` under `weather` to show Fahrenheit.

## Home Assistant on the home screen

The Sanctuary look can show a train line, up to five house tiles and a doorbell pop-up
(press OK to see the snapshot). It reads two files that Home Assistant keeps in its
`www` folder (served at `/local/`):

```json
"home": {
  "look": "sanctuary",
  "ha": {
    "url": "http://<home assistant address>:8123",
    "feed": "/local/<feed file name>.json",
    "doorbell": "/local/<doorbell snapshot>.jpg"
  }
}
```

- **The TV holds no login.** It only reads those two files. Anyone who can reach Home Assistant
  on the network could read them too, so give the feed an unguessable name, and keep the firewall
  rule from the TV narrow (the TV's address to Home Assistant's port only).
- **Narrow by design.** The app fetches only from a private IPv4 address and only `/local/`
  paths, with a plain GET. Home Assistant on a home network speaks http, which the app otherwise
  refuses, so this one read uses its own socket. Nothing else in the app can use cleartext.
- Leave `ha` out and the look shows no house tiles, train or doorbell.

### The feed

Home Assistant writes the feed whenever something on it changes, and every minute. The format:

```json
{
  "updated": 1793082000,
  "train": { "line": "5", "stop": "Station name", "next": 9.6, "after": 29.6, "leave_in": 2.6 },
  "doorbell": { "last": 1793081000 },
  "tiles": [
    { "kind": "lock", "name": "Front door", "value": "Locked", "ok": true },
    { "kind": "garage", "name": "Garage", "value": "Closed", "ok": true },
    { "kind": "temp", "name": "Living room", "value": "76° · AC off" }
  ]
}
```

- `updated` and `doorbell.last` are Unix seconds. Train minutes count from `updated`, and the TV
  counts them down itself.
- `ok` colours a tile: `true` green, `false` amber, left out plain.
- `kind` picks the tile's icon: `lock`, `unlock`, `garage`, `temp`, `light`, `bell` or `home`.
- The house tiles go grey when the feed is more than 10 minutes old.

One way to write it, in `configuration.yaml`:

```yaml
shell_command:
  tv_feed: "echo {{ feed }} | base64 -d > /config/www/<feed file name>.json"
```

Then add an automation that calls `shell_command.tv_feed` with
`feed: "{{ <the JSON above, built with a template> | to_json | base64_encode }}"`. Trigger it
when the entities change, and on a one-minute `time_pattern`.
