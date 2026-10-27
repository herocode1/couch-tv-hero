// The Sanctuary look: green and gold, the Church's season with its stained-glass window, a verse
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
  var weather = null;
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
    "com.apple.atve.androidtv.appletv": "apple-tv", "com.android.tv.settings": "settings", "com.android.vending": "app-store"
  };
  var ICON_NAME = [
    [/^youtube tv/i, "youtube-tv"], [/^youtube music/i, "youtube-music"], [/^youtube/i, "youtube"],
    [/netflix/i, "netflix"], [/prime video/i, "prime-video"], [/disney/i, "disney-plus"], [/hulu/i, "hulu"],
    [/^(hbo )?max$/i, "max"], [/tubi/i, "tubi"], [/paramount/i, "paramount-plus"], [/apple tv/i, "apple-tv"],
    [/fox one/i, "fox-one"], [/telemundo/i, "telemundo"], [/instagram/i, "instagram"], [/protect/i, "unifi-protect"]
  ];
  // the tiles there are in art/ (an app with none keeps its own icon)
  var TILES = [];
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
    el.setAttribute("aria-hidden", "true");
    el.innerHTML =
      '<div class="sa-left">' +
        '<div class="sa-time" id="sa-time"></div>' +
        '<div class="sa-date" id="sa-date"></div>' +
        '<div class="sa-season" id="sa-season"></div>' +
        '<div class="sa-wx" id="sa-wx"></div>' +
        '<div class="sa-train" id="sa-train"></div>' +
        '<div class="sa-verse" id="sa-verse"></div>' +
      "</div>" +
      '<div class="sa-arch"><img id="sa-art" alt=""></div>' +
      '<div class="sa-house" id="sa-house"></div>' +
      '<div class="sa-toast" id="sa-toast"><i></i><span>Someone is at the front door</span><b>Press OK for the camera</b></div>' +
      '<div class="sa-cam" id="sa-cam"><img id="sa-cam-img" alt=""><p id="sa-cam-note"></p></div>';
    document.body.insertBefore(el, document.body.firstChild);
  }

  function hm(d) {
    var h = d.getHours(), m = d.getMinutes(), mm = (m < 10 ? "0" : "") + m;
    return clock24 ? (h < 10 ? "0" : "") + h + ":" + mm : (h % 12 || 12) + ":" + mm;
  }

  var shownDay = "";
  function tick() {
    var d = new Date();
    $("sa-time").textContent = hm(d);
    var key = d.toDateString();
    if (key !== shownDay) {
      shownDay = key;
      var today = day(d.getFullYear(), d.getMonth() + 1, d.getDate());
      var s = season(today), f = nextFeast(today), v = verse(today, s);
      document.documentElement.className = document.documentElement.className.replace(/\btone-\w+/g, "").trim() + " tone-" + s.tone;
      $("sa-date").textContent = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      $("sa-season").innerHTML = "<i></i>" + esc(s.name) + (f ? '<span class="sep">·</span>' + esc(f) : "");
      $("sa-verse").innerHTML = "“" + esc(v[0]) + "”<b>" + esc(v[1]) + "</b>";
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

  function drawTrain() {
    var t = fresh() && feed.train, el = $("sa-train");
    if (!t || t.next == null) { el.innerHTML = ""; return; }
    // minutes as of now, not as of when Home Assistant wrote them
    var gone = Math.max(0, (Date.now() / 1000 - feed.updated) / 60);
    var next = Math.round(t.next - gone), leave = t.leave_in == null ? null : Math.round(t.leave_in - gone);
    var html = '<span class="bullet">' + esc(t.line || "") + "</span>" + esc(t.stop || "") +
      '<span class="sep">·</span>next train <b>' + Math.max(0, next) + " min</b>";
    if (leave != null && leave > 0) html += '<span class="sep">·</span>leave in <b>' + leave + "</b>";
    else if (leave != null && leave >= -1) html += '<span class="sep">·</span><b>leave now</b>';
    else if (t.after != null) html += '<span class="sep">·</span>then <b>' + Math.max(0, Math.round(t.after - gone)) + " min</b>";
    el.innerHTML = html;
  }

  function drawHouse() {
    var box = $("sa-house");
    var tiles = feed && Array.isArray(feed.tiles) ? feed.tiles.slice(0, 5) : [];
    if (!haOn || !tiles.length) { box.innerHTML = ""; return; }
    var old = !fresh();
    box.classList.toggle("old", old);
    box.innerHTML = tiles.map(function (t) {
      var g = GLYPH[t.kind] || GLYPH.home;
      return '<div class="sa-tile' + (t.ok === true ? " ok" : t.ok === false ? " warn" : "") + '">' +
        '<div class="k">' + g + esc(t.name) + '</div><div class="v">' + esc(old ? "…" : t.value) + "</div></div>";
    }).join("") + (old ? '<p class="sa-old">Home Assistant is not answering</p>' : "");
  }

  // ---------------- Home Assistant ----------------
  function poll() {
    clearTimeout(pollTimer);
    var get = window.MOCK_HA ? Promise.resolve(window.MOCK_HA()) :
      fetch(HA + "feed", { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
    get.then(function (j) {
      if (!j || typeof j !== "object") return;
      feed = j;
      drawTrain();
      drawHouse();
      checkRing();
    }, function () { drawHouse(); })
      .then(function () { pollTimer = setTimeout(poll, POLL_MS); });
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
    if (on) toastTimer = setTimeout(function () { toast(false); }, TOAST_MS);
  }
  function toastOn() { return $("sa-toast").classList.contains("on"); }
  function camOn() { return $("sa-cam").classList.contains("on"); }

  function openCam() {
    toast(false);
    var d = feed && feed.doorbell && feed.doorbell.last ? new Date(feed.doorbell.last * 1000) : null;
    $("sa-cam-img").src = HA + "doorbell?t=" + Date.now();
    $("sa-cam-note").textContent = (d ? "Front door at " + hm(d) : "Front door") + "  ·  Press OK or BACK to close";
    $("sa-cam").classList.add("on");
  }
  function closeCam() { $("sa-cam").classList.remove("on"); $("sa-cam-img").removeAttribute("src"); }

  // Keys while the doorbell is up. Runs before app.js (capture), so the dock does not move under it,
  // and the OK that opened or closed the picture does not also reach app.js when it comes back up.
  function isOk(e) { return e.key === "Enter" || e.keyCode === 13 || e.keyCode === 23; }
  var swallowUp = false;
  window.addEventListener("keydown", function (e) {
    if (!document.documentElement.classList.contains("theme-sanctuary")) return;
    if (camOn()) {
      if (isOk(e) || /^Arrow/.test(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (isOk(e)) { swallowUp = true; if (!e.repeat) closeCam(); }
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
      native = o.tv;
      haOn = !!((cfg.home || {}).ha) || !!window.MOCK_HA;
      build();
      tick();
      setInterval(tick, 15000);
      if (haOn) poll();
    },
    weather: function (w) { weather = w; drawWeather(); },
    resume: function () { if (haOn) poll(); tick(); },
    // BACK: true when it closed something here
    back: function () {
      if (camOn()) { closeCam(); return true; }
      if (toastOn()) { toast(false); return true; }
      return false;
    },
    // for tests: the calendar on any day
    _season: season, _nextFeast: nextFeast
  };
})();
