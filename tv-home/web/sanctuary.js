// The Sanctuary look: near-black and gold, the Church's season with its stained-glass window, a verse
// for the day, and the house from Home Assistant (train, doors, doorbell). app.js keeps the dock
// of apps and the quick buttons; this file draws everything above them.
//
// Home Assistant data comes through the launcher (https://home.tvos.invalid/ha/...), which reads a
// small JSON file Home Assistant writes into its www folder. The TV never holds a Home Assistant
// login. See HERO.md, "Home Assistant on the home screen".
(function () {
  "use strict";

  var HA = "https://home.tvos.invalid/ha/";
  var POLL_MS = 15000;
  var STALE_S = 600;          // older than this, the house data is not shown as current
  var RING_S = 180;           // a ring older than this when first seen is not announced
  var TOAST_MS = 45000;

  var cfg = {}, clock24 = false, native = null, haOn = false;
  var feed = null, lastRing = null, toastTimer = null, pollTimer = null;
  var weather = null, active = true, tickTimer = null, imageTimer = null;
  var pollEpoch = 0, actionTimer = null;
  var camIndex = 0, settingsIndex = -1, lookToggle = null, thumbSrc = "";
  var hi = -1;                // the house tile with the focus, -1 when the focus is elsewhere
  var panel = null;           // the open tile: { name, ai (chosen action), busy, said }
  var ACT_ID = /^[a-z0-9_]{1,40}$/;
  var $ = function (id) { return document.getElementById(id); };
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---------------- the Church's year ----------------
  function day(y, m, d) { return new Date(y, m - 1, d); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function same(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
  function sundayOnOrAfter(d) { return addDays(d, (7 - d.getDay()) % 7); }

  // Easter Sunday (Gregorian), the anonymous algorithm
  function easter(y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    var f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    var month = Math.floor((h + l - 7 * m + 114) / 31), dd = ((h + l - 7 * m + 114) % 31) + 1;
    return day(y, month, dd);
  }
  function advent1(y) { return sundayOnOrAfter(day(y, 11, 27)); }
  // Epiphany on the Sunday from 2 to 8 January (as in the United States); Baptism of the Lord the
  // Sunday after, or the Monday when Epiphany falls on the 7th or 8th.
  function epiphany(y) { return sundayOnOrAfter(day(y, 1, 2)); }
  function baptism(y) { var e = epiphany(y); return e.getDate() >= 7 ? addDays(e, 1) : addDays(e, 7); }

  function feasts(y) {
    var ea = easter(y), a1 = advent1(y);
    return [
      [day(y, 1, 1), "Mary, Mother of God"], [epiphany(y), "the Epiphany"], [baptism(y), "the Baptism of the Lord"],
      [day(y, 3, 19), "St Joseph"], [day(y, 3, 25), "the Annunciation"],
      [addDays(ea, -46), "Ash Wednesday"], [addDays(ea, -7), "Palm Sunday"], [addDays(ea, -3), "Holy Thursday"],
      [addDays(ea, -2), "Good Friday"], [ea, "Easter"], [addDays(ea, 7), "Divine Mercy Sunday"],
      [addDays(ea, 42), "the Ascension"], [addDays(ea, 49), "Pentecost"], [addDays(ea, 56), "Holy Trinity"],
      [addDays(ea, 63), "Corpus Christi"], [addDays(ea, 68), "the Sacred Heart"],
      [day(y, 6, 29), "Sts Peter and Paul"], [day(y, 8, 15), "the Assumption"], [day(y, 9, 8), "the Nativity of Mary"],
      [day(y, 10, 7), "Our Lady of the Rosary"], [day(y, 11, 1), "All Saints"], [day(y, 11, 2), "All Souls"],
      [addDays(a1, -7), "Christ the King"], [a1, "the First Sunday of Advent"],
      [day(y, 12, 8), "the Immaculate Conception"], [day(y, 12, 12), "Our Lady of Guadalupe"], [day(y, 12, 25), "Christmas"]
    ];
  }

  // The season (its name, the window to show, and the colour of the day)
  function season(d) {
    var y = d.getFullYear(), ea = easter(y), md = (d.getMonth() + 1) * 100 + d.getDate();
    if (d < baptism(y) || (d >= day(y, 12, 25))) return { name: "Christmas", art: "christmas", tone: "white" };
    if (d >= advent1(y)) return { name: "Advent", art: "advent", tone: "violet" };
    if (d >= addDays(ea, -46) && d < ea) return { name: d >= addDays(ea, -7) ? "Holy Week" : "Lent", art: "lent", tone: "violet" };
    if (same(d, addDays(ea, 49))) return { name: "Pentecost", art: "pentecost", tone: "red" };
    if (d >= ea && d < addDays(ea, 49)) return { name: "Easter", art: d >= addDays(ea, 40) ? "pentecost" : "easter", tone: "white" };
    if (md >= 1025 && md <= 1102) return { name: "Ordinary Time", art: "all-saints", tone: "green" };
    return { name: "Ordinary Time", art: "ordinary-time", tone: "green" };
  }

  // "All Saints in 5 days", "Today: Christmas"; nothing when the next feast is weeks away
  function nextFeast(d) {
    var list = feasts(d.getFullYear()).concat(feasts(d.getFullYear() + 1));
    var best = null;
    list.forEach(function (f) {
      var n = daysBetween(d, f[0]);
      if (n >= 0 && (!best || n < best.n)) best = { n: n, name: f[1] };
    });
    if (!best || best.n > 21) return "";
    var name = best.name.charAt(0).toUpperCase() + best.name.slice(1);
    if (best.n === 0) return "Today: " + name;
    if (best.n === 1) return "Tomorrow: " + name;
    return name + " in " + best.n + " days";
  }

  // A verse for the day (Douay-Rheims). In the big seasons every other day is the season's own.
  var VERSES = [
    ["This is the day which the Lord hath made: let us be glad and rejoice therein.", "Psalm 117:24"],
    ["Be still, and see that I am God.", "Psalm 45:11"],
    ["Come to me, all you that labour, and are burdened, and I will refresh you.", "Matthew 11:28"],
    ["I am the light of the world: he that followeth me, walketh not in darkness.", "John 8:12"],
    ["Rejoice in the Lord always; again, I say, rejoice.", "Philippians 4:4"],
    ["Thy word is a lamp to my feet, and a light to my paths.", "Psalm 118:105"],
    ["God is charity: and he that abideth in charity, abideth in God, and God in him.", "1 John 4:16"],
    ["Peace I leave with you, my peace I give unto you.", "John 14:27"],
    ["Ask, and it shall be given you: seek, and you shall find: knock, and it shall be opened to you.", "Matthew 7:7"],
    ["Blessed are the clean of heart: for they shall see God.", "Matthew 5:8"],
    ["Blessed are the peacemakers: for they shall be called the children of God.", "Matthew 5:9"],
    ["I can do all these things in him who strengtheneth me.", "Philippians 4:13"],
    ["The Lord is my light and my salvation, whom shall I fear?", "Psalm 26:1"],
    ["Cast thy care upon the Lord, and he shall sustain thee.", "Psalm 54:23"],
    ["Taste, and see that the Lord is sweet.", "Psalm 33:9"],
    ["Charity is patient, is kind.", "1 Corinthians 13:4"],
    ["Behold I am with you all days, even to the consummation of the world.", "Matthew 28:20"],
    ["Let not your heart be troubled.", "John 14:1"],
    ["I am the resurrection and the life.", "John 11:25"],
    ["Seek ye therefore first the kingdom of God, and his justice.", "Matthew 6:33"],
    ["Give praise to the Lord, for he is good: for his mercy endureth for ever.", "Psalm 117:1"],
    ["My soul doth magnify the Lord.", "Luke 1:46"],
    ["Behold the handmaid of the Lord; be it done to me according to thy word.", "Luke 1:38"]
  ];
  var SEASON_VERSE = {
    advent: ["Prepare ye the way of the Lord, make straight his paths.", "Mark 1:3"],
    christmas: ["And the Word was made flesh, and dwelt among us.", "John 1:14"],
    lent: ["Rend your hearts, and not your garments, and turn to the Lord your God.", "Joel 2:13"],
    easter: ["He is not here, for he is risen, as he said.", "Matthew 28:6"],
    pentecost: ["And they were all filled with the Holy Ghost.", "Acts 2:4"],
    "all-saints": ["Be glad and rejoice, for your reward is very great in heaven.", "Matthew 5:12"]
  };
  function verse(d, s) {
    if (d.getMonth() === 9 && d.getDate() === 28) return VERSES[9];
    var n = daysBetween(day(2000, 1, 1), d);
    if (SEASON_VERSE[s.art] && n % 2 === 0) return SEASON_VERSE[s.art];
    return VERSES[((n % VERSES.length) + VERSES.length) % VERSES.length];
  }

  // ---------------- app icons drawn for this look ----------------
  // By package first, then by the app's name, so a renamed or regional app still finds its icon.
  var ICON_PKG = {
    "com.google.android.youtube.tv": "youtube", "com.google.android.youtube.tvunplugged": "youtube-tv",
    "com.google.android.youtube.tvmusic": "youtube-music", "com.netflix.ninja": "netflix",
    "com.amazon.amazonvideo.livingroom": "prime-video", "com.disney.disneyplus": "disney-plus",
    "com.hulu.livingroomplus": "hulu", "com.wbd.stream": "max", "com.tubitv": "tubi", "com.cbs.ott": "paramount-plus",
    "com.apple.atve.androidtv.appletv": "apple-tv", "com.android.tv.settings": "settings", "com.android.vending": "app-store",
    "com.fox.foxone": "fox-one", "com.instagram.airwave": "instagram",
    "com.nbcu.tve.telemundotv.androidtv": "telemundo", "com.ubnt.unifi.protect": "unifi-protect",
    "com.eliotcougar.tclcompanion": "tv-companion", "com.shieldglow.tv": "shield-glow",
    "com.tcl.dashboard": "dashboard", "com.tcl.suspension": "tv-rest", "com.tcl.tv": "live-tv",
    "com.tcl.ui_mediaCenter": "media-center", "de.cyberdream.androidtv.notifications.google": "notifications"
  };
  var ICON_NAME = [
    [/^youtube tv/i, "youtube-tv"], [/^youtube music/i, "youtube-music"], [/^youtube/i, "youtube"],
    [/netflix/i, "netflix"], [/prime video/i, "prime-video"], [/disney/i, "disney-plus"], [/hulu/i, "hulu"],
    [/^(hbo )?max$/i, "max"], [/tubi/i, "tubi"], [/paramount/i, "paramount-plus"], [/apple tv/i, "apple-tv"],
    [/fox one/i, "fox-one"], [/telemundo/i, "telemundo"], [/instagram/i, "instagram"], [/protect/i, "unifi-protect"]
  ];
  // the tiles there are in art/ (an app with none keeps its own icon)
  var TILES = ["youtube", "youtube-tv", "youtube-music", "netflix", "prime-video", "disney-plus", "hulu", "max",
    "tubi", "paramount-plus", "apple-tv", "fox-one", "telemundo", "instagram", "unifi-protect", "settings",
    "app-store", "more-apps", "tv-companion", "shield-glow", "dashboard", "tv-rest", "live-tv", "media-center", "notifications"];
  function icon(it) {
    var id = it.kind === "more" ? "more-apps" : ICON_PKG[it.package];
    if (!id) ICON_NAME.some(function (r) { if (r[0].test(it.name || "")) { id = r[1]; return true; } return false; });
    return id && TILES.indexOf(id) >= 0 ? "art/tile-" + id + ".webp" : null;
  }

  // ---------------- drawing ----------------
  var GLYPH = {
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
    garage: '<svg viewBox="0 0 24 24"><path d="M3 21V9l9-6 9 6v12M7 21v-8h10v8M7 16h10"/></svg>',
    temp: '<svg viewBox="0 0 24 24"><path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/></svg>',
    light: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5V16h8v-2.5A6 6 0 0 0 12 3z"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4"/></svg>',
    home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v10H3z"/></svg>'
  };

  function build() {
    var el = document.createElement("div");
    el.className = "sanct";
    el.id = "sanct";
    el.setAttribute("aria-label", "Sanctuary home");
    el.innerHTML =
      '<div class="sa-left">' +
        '<div class="sa-time" id="sa-time"></div>' +
        '<div class="sa-orn orn">\u2720</div>' +
        '<div class="sa-date cap" id="sa-date"></div>' +
        '<div class="sa-verse" id="sa-verse"></div>' +
        '<div class="sa-train" id="sa-train"></div>' +
      "</div>" +
      '<div class="sa-arch"><img id="sa-art" alt=""></div>' +
      '<div class="sa-under"><div class="sa-feast" id="sa-feast"></div><div class="sa-wx" id="sa-wx"></div></div>' +
      '<div class="sa-house" id="sa-house"></div>' +
      '<div class="sa-toast" id="sa-toast"><i></i><span>Someone is at the front door</span><b>Press OK for the camera</b></div>' +
      '<div class="sa-act" id="sa-act"></div>' +
      '<div class="sa-cam" id="sa-cam"><img id="sa-cam-img" alt="Front door camera"><span class="sa-cam-live">Live</span>' +
        '<div class="sa-cam-side"><h2>Front door</h2><div class="orn">\u2720</div><p id="sa-cam-note"></p>' +
        '<div class="sa-cam-buttons"><button>Open Protect</button><button>Close</button></div></div></div>' +
      '<div class="sa-title" id="sa-title"></div><div class="sa-title-orn orn">\u2720</div>' +
      '<div class="sa-settings" id="sa-settings"></div><div class="sa-hint">Back to return home</div>';
    document.body.insertBefore(el, document.body.firstChild);
  }

  function hm(d) {
    var h = d.getHours(), m = d.getMinutes(), mm = (m < 10 ? "0" : "") + m;
    return clock24 ? (h < 10 ? "0" : "") + h + ":" + mm : (h % 12 || 12) + ":" + mm;
  }

  var shownDay = "";
  function tick() {
    var d = new Date();
    $("sa-time").innerHTML = esc(hm(d)).replace(":", "<i>:</i>");
    var key = d.toDateString();
    if (key !== shownDay) {
      shownDay = key;
      var today = day(d.getFullYear(), d.getMonth() + 1, d.getDate());
      var s = season(today), f = nextFeast(today), v = verse(today, s);
      document.documentElement.className = document.documentElement.className.replace(/\btone-\w+/g, "").trim() + " tone-" + s.tone;
      // "Thursday · October 29 · Ordinary Time", the feast's name on its day; what is coming goes under the window
      var name = d.getMonth() === 9 && d.getDate() === 28 ? "Sts. Simon and Jude" : f.indexOf("Today: ") === 0 ? f.slice(7) : s.name;
      $("sa-date").textContent = d.toLocaleDateString("en-US", { weekday: "long" }) + " \u00b7 " +
        d.toLocaleDateString("en-US", { month: "long", day: "numeric" }) + " \u00b7 " + name;
      $("sa-feast").textContent = f && f.indexOf("Today: ") !== 0 ? f : s.name;
      $("sa-verse").innerHTML = esc(v[0]) + "<b>" + esc(v[1].replace(":", " \u00b7 ")) + "</b>";
      $("sa-verse").classList.toggle("long", v[0].length > 100);
      $("sa-art").src = "art/arch-" + s.art + ".webp";
    }
    drawTrain();
  }

  function drawWeather() {
    var w = weather;
    if (!w || w.temp == null) { $("sa-wx").textContent = ""; return; }
    var parts = [w.temp + "°", w.text];
    if (w.high != null) parts.push("High " + w.high + "°");
    $("sa-wx").textContent = parts.filter(Boolean).join(" · ");
  }

  function fresh() { return feed && feed.updated && (Date.now() / 1000 - feed.updated) < STALE_S; }

  // The train to catch: the first one there is still time to walk to. Home Assistant's own
  // leave_in says how much platform time it keeps; the trains after that one get the same.
  function trainState(t, updated, now) {
    var elapsed = Math.max(0, (now - updated) / 60), walk = Number(t.walk);
    if (!isFinite(walk)) walk = t.next != null && t.leave_in != null ? t.next - t.leave_in : 0;
    var times = Array.isArray(t.times) ? t.times.filter(function (n) { return typeof n === "number" && isFinite(n); }).sort(function (a, b) { return a - b; }) : [t.next, t.after].filter(function (n) { return typeof n === "number" && isFinite(n); });
    var c = 0;
    while (c < times.length && times[c] < walk) c++;
    var pad = c < times.length && t.leave_in != null && isFinite(Number(t.leave_in)) ? Math.max(0, times[c] - walk - Number(t.leave_in)) : 0;
    var i = 0;
    while (i < times.length && times[i] - walk - pad - elapsed < -0.5) i++;
    if (i === times.length) return null;
    var leave = times[i] - walk - pad - elapsed, nx = times[i + 1];
    return { leave: leave, walk: walk, train: updated + times[i] * 60,
      next: nx != null ? { train: updated + nx * 60, by: updated + (nx - walk - pad) * 60 } : null,
      go: leave <= 1 || (i === c && elapsed < 1 && !!t.leave_now) };
  }
  // "Leave in 7 minutes / for the 6:59 train at Morris Park · 7 min walk / Too late? Next: ..."
  function drawTrain() {
    var t = fresh() && feed.train, el = $("sa-train"), state = t && trainState(t, feed.updated, Date.now() / 1000);
    if (!state) { el.innerHTML = ""; el.classList.remove("go"); return; }
    var mins = Math.max(0, Math.ceil(state.leave));
    el.classList.toggle("go", state.go);
    el.innerHTML = '<span class="bullet">' + esc(t.line) + '</span><div>' +
      '<div class="sa-leave">' + (state.go ? "Leave now" : "Leave in <em>" + mins + "</em> " + (mins === 1 ? "minute" : "minutes")) + '</div>' +
      '<div class="sa-for">for the <b>' + hm(new Date(state.train * 1000)) + '</b> train at ' + esc(t.stop) + ' \u00b7 ' + esc(state.walk) + ' min walk</div>' +
      (state.next ? '<div class="sa-then">Too late? Next: leave at ' + hm(new Date(state.next.by * 1000)) + ' for the ' + hm(new Date(state.next.train * 1000)) + '</div>' : '') +
      '</div>';
  }

  // the doorbell always last: it is the picture card beside the panel
  function houseTiles() {
    var tiles = haOn && feed && Array.isArray(feed.tiles) ? feed.tiles.slice(0, 5) : [];
    return tiles.filter(function (t) { return t.kind !== "bell"; }).concat(tiles.filter(function (t) { return t.kind === "bell"; }));
  }
  // what OK on a tile offers: only the actions Home Assistant listed for it, in its own words
  function actions(t) {
    return (Array.isArray(t.actions) ? t.actions : []).filter(function (a) {
      return a && ACT_ID.test(a.id) && typeof a.label === "string";
    }).slice(0, 4);
  }

  function drawHouse() {
    var box = $("sa-house"), oldThumb = $("sa-thumb-img");
    var tiles = houseTiles();
    if (!tiles.length) { box.innerHTML = ""; return; }
    var old = !fresh();
    box.classList.toggle("old", old);
    if (hi >= tiles.length) hi = tiles.length - 1;
    var last = -1;
    tiles.forEach(function (t, i) { if (t.kind !== "bell") last = i; });
    box.innerHTML = tiles.map(function (t, i) {
      var cls = "sa-tile" + (t.ok === true ? " ok" : t.ok === false ? " warn" : "") + (i === 0 ? " first" : "") + (i === last ? " end" : "") +
        (t.kind === "bell" ? " doorbell" : "") + (i === hi && !old ? " focus" : "");
      if (t.kind === "bell") return '<div class="' + cls + '"><div class="sa-thumb"><img id="sa-thumb-img" alt="Front door"' +
        (thumbSrc ? ' class="ok" src="' + esc(thumbSrc) + '"' : '') + '><span>Front door</span></div></div>';
      return '<div class="' + cls + '">' + esc(t.name) + '<span class="v">' + esc(old ? "…" : t.value) + "</span></div>";
    }).join("") + (old ? '<p class="sa-old">Home Assistant is not answering</p>' : "");
    if (oldThumb && $("sa-thumb-img")) $("sa-thumb-img").replaceWith(oldThumb);
    // a long value ("Locked · Apt unlocked") gets smaller type rather than running past the card
    Array.prototype.forEach.call(box.querySelectorAll(".v"), function (v) { if (v.scrollWidth > v.clientWidth) v.classList.add("tight"); });
  }

  // ---------------- Home Assistant ----------------
  function poll() {
    clearTimeout(pollTimer);
    if (!active || document.hidden) return;
    var ticket = ++pollEpoch;
    var get = window.MOCK_HA ? Promise.resolve(window.MOCK_HA()) :
      fetch(HA + "feed", { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
    get.then(function (j) {
      if (!j || typeof j !== "object") return;
      if (!active || document.hidden || ticket !== pollEpoch) return;
      feed = j;
      drawTrain();
      drawHouse();
      if (!imageTimer) refreshImages();
      if (panel && !panel.busy) drawPanel();
      checkRing();
    }, function () { drawHouse(); })
      .then(function () { if (active && !document.hidden && ticket === pollEpoch) pollTimer = setTimeout(poll, POLL_MS); });
  }

  function checkRing() {
    var last = feed && feed.doorbell && feed.doorbell.last;
    if (!last) return;
    if (lastRing == null) {   // the first look: only a ring that is still happening is news
      lastRing = last;
      if (Date.now() / 1000 - last < RING_S) toast(true);
      return;
    }
    if (last > lastRing) { lastRing = last; toast(true); }
  }

  function toast(on) {
    clearTimeout(toastTimer);
    $("sa-toast").classList.toggle("on", on);
    if (on && active && !document.hidden) toastTimer = setTimeout(function () { toast(false); }, TOAST_MS);
  }
  function toastOn() { return $("sa-toast").classList.contains("on"); }
  function camOn() { return $("sa-cam").classList.contains("on"); }

  function imageSource() { return window.MOCK_DOORBELL || HA + "doorbell?t=" + Date.now(); }
  function homeVisible() { return active && !document.hidden && settingsIndex < 0 && (camOn() || !document.documentElement.classList.contains("expanded")); }
  function refreshImages() {
    clearTimeout(imageTimer); imageTimer = null;
    if (!homeVisible() || !haOn) return;
    var img = camOn() ? $("sa-cam-img") : $("sa-thumb-img");
    if (img) {
      var src = imageSource();
      // swap the picture in only once it has loaded: no broken-image icon while Home Assistant has none yet
      var next = new Image();
      next.onload = function () { img.src = src; img.classList.add("ok"); if (img.id === "sa-thumb-img") thumbSrc = src; };
      next.src = src;
    }
    imageTimer = setTimeout(refreshImages, camOn() ? 1000 : 30000);
  }
  function sendAction(id) {
    return window.MOCK_HA ? Promise.resolve() : fetch(HA + "do/" + id, { method: "POST", cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error(r.status); });
  }
  function camFocus() {
    Array.prototype.forEach.call($("sa-cam").querySelectorAll("button"), function (el, i) { el.classList.toggle("focus", i === camIndex); });
  }
  function openCam() {
    if (camOn()) return;
    toast(false); camIndex = 0;
    var d = feed && feed.doorbell && feed.doorbell.last ? new Date(feed.doorbell.last * 1000) : null;
    $("sa-cam-note").innerHTML = "Live now \u00b7 " + esc(hm(new Date())) + "<br>" +
      (d ? "Last ring " + esc(d.toLocaleDateString("en-US", { weekday: "short" }) + " " + hm(d)) : "No recent ring");
    $("sa-cam").classList.add("on"); document.documentElement.classList.add("camera-open");
    camFocus(); refreshImages();
    sendAction("doorbell_live").catch(function () { if (camOn()) $("sa-cam-note").textContent = "Live refresh unavailable \u00b7 showing latest snapshot"; });
  }
  function closeCam() {
    $("sa-cam").classList.remove("on"); document.documentElement.classList.remove("camera-open");
    $("sa-cam-img").removeAttribute("src"); $("sa-cam-img").classList.remove("ok"); refreshImages();
  }
  var SETTINGS = [["wifi", "Wi-Fi", "Home network", "M3 8q9-9 18 0M6 12q6-6 12 0M9 16q3-3 6 0M12 20h.01"],
    ["picture", "Picture", "Picture modes", "M3 3h18v18H3zM3 18l6-7 5 5 3-3 4 5M16 7h.01"],
    ["sound", "Sound", "Speakers and audio", "M3 9h4l6-5v16l-6-5H3zM17 7q5 5 0 10M20 4q7 8 0 16"],
    ["inputs", "Inputs", "HDMI and more", "M10 3h11v18H10M2 12h14M11 7l5 5-5 5"],
    ["bluetooth", "Bluetooth", "Remotes, speakers", "M7 6l12 12-7 5V1l7 5L7 18"],
    ["sleep", "Display & Sleep", "Energy saving", "M2 3h20v15H2zM12 18v4M7 22h10M13 6a4 4 0 1 0 3 7 5 5 0 0 1-3-7"],
    ["look", "Home look", "Change the look", "M2 11L12 2l10 9M5 9v13h14V9M9 22v-8h6v8"],
    ["all", "All settings", "Everything else", "M4 5h16v14H4zM8 2v6M16 16v6M2 12h6M16 12h6M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0"]];
  function drawSettings() {
    $("sa-settings").innerHTML = SETTINGS.map(function (x, i) {
      return '<div class="sa-setting' + (i === settingsIndex ? ' focus' : '') + '"><svg viewBox="0 0 24 24"><path d="' + x[3] + '"/></svg><div><span>' + esc(x[1]) + '</span><small>' + x[2] + '</small></div></div>';
    }).join('');
  }
  function openSettings() { settingsIndex = 0; document.documentElement.classList.add("settings-open"); $("sa-title").textContent = "Settings"; drawSettings(); refreshImages(); }
  function closeSettings() { settingsIndex = -1; document.documentElement.classList.remove("settings-open"); $("sa-title").textContent = "All apps"; refreshImages(); }
  function settingOK() {
    var id = SETTINGS[settingsIndex][0];
    if (id === "look") { lookToggle(); return; }
    if (native && native.openSettings && !native.openSettings(id)) native.openSettings("all");
  }
  function pause() {
    active = false; pollEpoch++; clearTimeout(actionTimer);
    clearTimeout(pollTimer); clearInterval(tickTimer); clearTimeout(imageTimer); imageTimer = null;
    toast(false);
  }
  function resume() {
    active = true; clearInterval(tickTimer);
    if (document.hidden) return;
    tick(); tickTimer = setInterval(tick, 15000);
    if (haOn) poll(); refreshImages();
  }
  document.addEventListener("visibilitychange", function () { if (!$("sanct")) return; if (document.hidden) pause(); else resume(); });

  // ---------------- a tile, opened ----------------
  function houseOK() {
    var t = houseTiles()[hi];
    if (!t || !fresh()) return;
    if (t.kind === "bell") { openCam(); return; }
    panel = { name: t.name, ai: 0, busy: false, said: "" };
    drawPanel();
    $("sa-act").classList.add("on");
  }
  function panelTile() {
    var tiles = houseTiles();
    for (var i = 0; i < tiles.length; i++) if (tiles[i].name === panel.name) return tiles[i];
    return null;
  }
  function drawPanel() {
    var t = panelTile();
    if (!t) { closePanel(); return; }
    var acts = actions(t);
    if (panel.ai >= acts.length) panel.ai = Math.max(0, acts.length - 1);
    var g = GLYPH[t.kind] || GLYPH.home;
    $("sa-act").innerHTML = '<div class="sa-act-box"><div class="k">' + g + esc(t.name) + '</div>' +
      '<div class="v">' + esc(t.value) + "</div>" +
      (acts.length ? '<div class="sa-act-btns">' + acts.map(function (a, i) {
        return '<span class="sa-btn' + (i === panel.ai && !panel.busy ? " focus" : "") + '">' + esc(a.label) + "</span>";
      }).join("") + "</div>" : '<p class="sa-act-none">Nothing to change from the TV</p>') +
      '<p class="sa-act-note">' + esc(panel.said || "Press BACK to close") + "</p></div>";
  }
  function closePanel() { panel = null; $("sa-act").classList.remove("on"); $("sa-act").innerHTML = ""; }
  function panelOn() { return !!panel; }

  function run() {
    var t = panelTile(), a = t && actions(t)[panel.ai];
    if (!a || panel.busy) return;
    if (a.id === "camera") { closePanel(); openCam(); return; }
    panel.busy = true; panel.said = "Sending…"; drawPanel();
    var send = sendAction(a.id);
    send.then(function () {
      if (!panel) return;
      panel.busy = false; panel.said = "Done"; drawPanel();
      if (active && !document.hidden) actionTimer = setTimeout(function () { if (panel && panel.said === "Done") closePanel(); }, 1500);
      // Home Assistant writes the feed again when the lock, the garage or the AC changes
      if (active && !document.hidden) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, 2000); }
    }, function () {
      if (!panel) return;
      panel.busy = false; panel.said = "Home Assistant did not answer. Try again in a moment."; drawPanel();
    });
  }

  // Keys while the doorbell is up. Runs before app.js (capture), so the dock does not move under it,
  // and the OK that opened or closed the picture does not also reach app.js when it comes back up.
  function isOk(e) { return ["Enter", " ", "Select", "Accept", "NumpadEnter"].indexOf(e.key) >= 0 || e.keyCode === 13 || e.keyCode === 23; }
  var swallowUp = false;
  window.addEventListener("keydown", function (e) {
    if (!document.documentElement.classList.contains("theme-sanctuary")) return;
    var key = ({ Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" })[e.key] || e.key;
    if (!key || key === "Unidentified") key = ({19:"ArrowUp",20:"ArrowDown",21:"ArrowLeft",22:"ArrowRight",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown"})[e.keyCode] || key;
    if (["Escape", "Backspace", "BrowserBack", "GoBack"].indexOf(e.key) >= 0 && window.Sanctuary.back()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (settingsIndex >= 0) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (isOk(e)) { swallowUp = true; if (!e.repeat) settingOK(); }
      else {
        var col = settingsIndex % 4;
        if (key === "ArrowLeft" && col > 0) settingsIndex--;
        if (key === "ArrowRight" && col < 3) settingsIndex++;
        if (key === "ArrowUp" && settingsIndex >= 4) settingsIndex -= 4;
        if (key === "ArrowDown" && settingsIndex < 4) settingsIndex += 4;
        drawSettings();
      }
      return;
    }
    if (panelOn()) {
      if (isOk(e) || /^Arrow/.test(key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (isOk(e)) { swallowUp = true; if (!e.repeat) run(); }
        else if (!panel.busy && (key === "ArrowLeft" || key === "ArrowRight")) {
          panel.ai = Math.max(0, panel.ai + (key === "ArrowLeft" ? -1 : 1));
          panel.said = ""; drawPanel();
        }
      }
      return;
    }
    if (camOn()) {
      if (key === "ArrowLeft" || key === "ArrowRight") { camIndex = key === "ArrowLeft" ? 0 : 1; camFocus(); }
      if (isOk(e) || /^Arrow/.test(key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (isOk(e)) { swallowUp = true; if (!e.repeat) { if (camIndex === 1) closeCam(); else if (native) native.launch("com.ubnt.unifi.protect"); } }
      }
      return;
    }
    if (toastOn() && isOk(e)) {
      e.preventDefault(); e.stopImmediatePropagation();
      swallowUp = true;
      if (!e.repeat) openCam();
    }
  }, true);
  window.addEventListener("keyup", function (e) {
    if (swallowUp && isOk(e)) { e.preventDefault(); e.stopImmediatePropagation(); swallowUp = false; }
  }, true);

  window.Sanctuary = {
    icon: icon,
    start: function (o) {
      cfg = o.config || {};
      clock24 = !!o.clock24;
      native = o.tv; lookToggle = o.toggleLook;
      haOn = !!((cfg.home || {}).ha) || !!window.MOCK_HA;
      build();
      resume();
    },
    weather: function (w) { weather = w; drawWeather(); },
    resume: resume, pause: pause, openSettings: openSettings,
    layout: function () { $("sa-title").textContent = settingsIndex >= 0 ? "Settings" : "All apps"; refreshImages(); },
    // BACK: true when it closed something here
    back: function () {
      if (settingsIndex >= 0) { closeSettings(); return true; }
      if (camOn()) { closeCam(); return true; }
      if (panelOn()) { closePanel(); return true; }
      if (toastOn()) { toast(false); return true; }
      return false;
    },
    // the house row, for app.js's focus: how many tiles can take it, which one has it, where they are
    houseCount: function () { return fresh() ? houseTiles().length : 0; },
    houseFocus: function (i) { hi = i; Array.prototype.forEach.call($("sa-house").children, function (el, n) { el.classList.toggle("focus", n === hi && fresh()); }); },
    houseX: function (i) { var el = $("sa-house").children[i]; if (!el) return 0; var b = el.getBoundingClientRect(); return b.left + b.width / 2; },
    houseNear: function (x) {
      var best = 0, bestD = Infinity, els = $("sa-house").children;
      for (var i = 0; i < Math.min(els.length, houseTiles().length); i++) {
        var b = els[i].getBoundingClientRect(), d = Math.abs(b.left + b.width / 2 - x);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    },
    houseOK: houseOK,
    // for tests: the calendar on any day
    _trainState: trainState, _season: season, _nextFeast: nextFeast
  };
})();
