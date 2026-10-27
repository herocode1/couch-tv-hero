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
