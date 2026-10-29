package app.couchtv.launcher

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * The TV home screen. Shows the copy of the home page built into the app (scenes, clock, weather,
 * apps) full screen. couch-tv-hero has no bridge: the page is never loaded from the network, so no
 * other device can change what this screen runs. A plain grid of the TV's apps is the last resort,
 * so the TV is never stuck.
 */
class MainActivity : Activity() {

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val banners = ConcurrentHashMap<String, ByteArray>()
    private val icons = ConcurrentHashMap<String, ByteArray>()

    private lateinit var root: FrameLayout
    private var web: WebView? = null
    private var fallback: View? = null
    private var pageReady = false
    private var loadFailed = false
    private var retries = 0

    private val prefs by lazy { getSharedPreferences("home", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Lets a computer inspect the page over ADB (chrome://inspect). Debug builds only.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        root = FrameLayout(this).apply { setBackgroundColor(GROUND) }
        setContentView(root)
        hideSystemBars()
        intent?.let { readExtras(it) }
        io.execute { warmApps() }
        showHome()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.hasExtra("config_b64") || intent.hasExtra("tv")) {
            readExtras(intent)
            showHome()
            return
        }
        // HOME pressed while we are already in front: back to the first tile.
        js("window.tv && tv.home()")
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        if (pageReady) js("window.tv && tv.resume()")
        else if (fallback != null || web == null) showHome()
        io.execute { warmApps() }
    }

    // Out of sight (an app is playing), the page sleeps: no clock, no polling, no animation.
    override fun onStart() {
        super.onStart()
        web?.onResume()
        web?.resumeTimers()
    }

    override fun onPause() {
        js("window.tv && tv.pause()")
        super.onPause()
    }

    override fun onStop() {
        web?.pauseTimers()
        web?.onPause()
        super.onStop()
    }

    // The TV has little memory. When Android asks for it back while an app is in front, give up the
    // page (about 250 MB with its renderer); onResume builds it again when HOME comes back.
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_BACKGROUND && !hasWindowFocus()) dropPage()
    }

    private fun dropPage() {
        val w = web ?: return
        root.removeView(w)
        w.destroy()
        web = null
        pageReady = false
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // Every kind of remote: game controller A, Select and the number pad's Enter count as OK,
        // controller B and Escape as BACK. The page then only has to know OK and BACK.
        val same = when (event.keyCode) {
            KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_BUTTON_SELECT, KeyEvent.KEYCODE_NUMPAD_ENTER -> KeyEvent.KEYCODE_DPAD_CENTER
            KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_ESCAPE -> KeyEvent.KEYCODE_BACK
            else -> null
        }
        if (same != null) {
            return dispatchKeyEvent(KeyEvent(event.downTime, event.eventTime, event.action, same, event.repeatCount,
                event.metaState, event.deviceId, event.scanCode, event.flags, event.source))
        }
        // The home screen never exits on BACK; the page decides what BACK means.
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP && pageReady) js("window.tv && tv.back()")
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    /**
     * What apply.sh tells the app: "config_b64" (the home's settings from config.json, base64 JSON,
     * for the built-in copy) and "tv" (which TV this is, for a house with more than one; none = the
     * default TV). There is no "bridge" extra: the page always comes from inside the app.
     */
    private fun readExtras(i: Intent) {
        val e = prefs.edit()
        i.getStringExtra("config_b64")?.let {
            try {
                val json = String(android.util.Base64.decode(it, android.util.Base64.DEFAULT), Charsets.UTF_8)
                // Only real JSON, and stored as org.json writes it back out: its parser is lenient (it
                // takes unquoted words), and this text becomes a script, so the raw string never does.
                e.putString("config", JSONObject(json).toString())
            } catch (x: Exception) {
                // a broken value keeps the settings the app already had
            }
        }
        i.getStringExtra("tv")?.takeIf { TV_ID.matches(it) }?.let { e.putString("tv", it) }
        e.apply()
    }

    // ---------------------------------------------------------------- the page

    private fun makeWebView(): WebView = WebView(this).apply {
        setBackgroundColor(GROUND)
        isFocusable = true
        isFocusableInTouchMode = true
        overScrollMode = View.OVER_SCROLL_NEVER
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.textZoom = 100
        addJavascriptInterface(Native(), "TVOS")
        webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                Log.i(TAG, "page finished (failed=$loadFailed)")
                if (!loadFailed && url.startsWith("https://$HOME_HOST/")) {
                    pageReady = true
                    retries = 0
                    removeFallback()
                    view.visibility = View.VISIBLE
                    view.requestFocus()
                }
            }

            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                // A load cut short by a newer one (config sent just after install) is not a failure.
                if (req.isForMainFrame) Log.i(TAG, "page error ${err.errorCode} ${err.description}")
                if (req.isForMainFrame && !err.description.contains("ERR_ABORTED")) pageFailed()
            }

            override fun onReceivedHttpError(view: WebView, req: WebResourceRequest, res: WebResourceResponse) {
                if (req.isForMainFrame && res.statusCode >= 500) pageFailed()
            }

            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest) = true

            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url
                if (u.scheme != "https") return null
                if (u.host == HOME_HOST) {
                    val path = u.path ?: ""
                    return if (path.startsWith("/ha/")) haFile(path.removePrefix("/ha/")) else homeFile(path)
                }
                if (u.host != "tvos.invalid") return null
                val pkg = u.lastPathSegment ?: return null
                val isIcon = u.pathSegments.firstOrNull() == "icon"
                val img = (if (isIcon) iconImage(pkg) else bannerImage(pkg)) ?: return null
                return WebResourceResponse(if (isIcon) "image/png" else "image/jpeg", null, ByteArrayInputStream(img)).apply {
                    responseHeaders = mapOf("Cache-Control" to "max-age=86400")
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The page crashed or was killed for memory. Drop it and start again.
                if (view === web) dropPage() else { root.removeView(view); view.destroy() }
                showHome()
                return true
            }
        }
    }

    private fun pageFailed() {
        if (loadFailed) return
        loadFailed = true
        pageReady = false
        web?.visibility = View.INVISIBLE
        web?.stopLoading()
        showFallback()
    }

    // While the grid stands in for the page, keep trying: soon the first time (right after an
    // install the WebView is still warming up), then every RETRY_MS.
    private val retryHome = Runnable { if (!pageReady && fallback != null) { Log.i(TAG, "retrying the page"); showHome() } }

    // ---------------------------------------------------------------- the built-in copy

    /** The copy of the home built into the app (assets/www/tv, from tv-home/web at build time). */
    private val hasBundled by lazy {
        try { assets.list(BUNDLED)?.contains("index.html") == true } catch (e: Exception) { false }
    }

    /** The home page, from inside the app. Only HOME_HOST, which shouldInterceptRequest answers. */
    private fun showHome() {
        if (!hasBundled) { showFallback(); return }
        val w = web ?: makeWebView().also { web = it; root.addView(it, 0, MATCH) }
        w.resumeTimers()   // timers are shared by every page, and onStop may have paused them
        loadFailed = false
        pageReady = false
        val tv = prefs.getString("tv", null)
        w.loadUrl("https://$HOME_HOST/tv/index.html?offline=1&alone=1" + if (tv.isNullOrEmpty()) "" else "&tv=$tv")
        // Never a blank screen: if the page is slow, show the app grid until it arrives.
        main.postDelayed({ if (!pageReady) showFallback() }, SLOW_MS)
    }

    private fun homeFile(path: String): WebResourceResponse {
        val rel = path.removePrefix("/tv/").ifEmpty { "index.html" }
        val notFound = { WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), ByteArrayInputStream(ByteArray(0))) }
        if (rel.contains("..")) return notFound()
        // The settings: what apply.sh passed from config.json, else the defaults built into the app.
        val given = prefs.getString("config", null)
        if (rel == "config.js" && given != null) {
            val js = "window.COUCH_CONFIG = $given;\n".toByteArray()
            return WebResourceResponse("application/javascript", "utf-8", ByteArrayInputStream(js))
        }
        val type = mimeFor(rel.substringAfterLast('.', ""))
        val text = type.startsWith("text/") || type.endsWith("javascript") || type.endsWith("json")
        return try {
            WebResourceResponse(type, if (text) "utf-8" else null, assets.open("$BUNDLED/$rel"))
        } catch (e: Exception) {
            notFound()
        }
    }

    // ---------------------------------------------------------------- Home Assistant, read only

    /**
     * The house for the Sanctuary look: two files Home Assistant keeps in its www folder (a small
     * JSON feed and the doorbell's last snapshot), named in config.json under home.ha. The page asks
     * for https://home.tvos.invalid/ha/feed or /ha/doorbell and this fetches the file. Only a
     * plain GET of those two /local/ paths, only to a private address on the home network, and no
     * login: the TV never holds a Home Assistant token. Home Assistant on the home network speaks
     * plain http, which the app otherwise refuses, so this one read goes over its own socket.
     *
     * /ha/do/<action> is the one thing the TV can ask of the house: it POSTs {"action": ...} to the
     * webhook named in home.ha.webhook (on the same address). Home Assistant decides what each action
     * does, and only runs the safe ones it lists (lock, close, the AC, lights); the TV only names one.
     */
    private fun haFile(name: String): WebResourceResponse {
        val none = { code: Int -> WebResourceResponse("text/plain", "utf-8", code, if (code == 404) "Not found" else "Bad gateway", emptyMap(), ByteArrayInputStream(ByteArray(0))) }
        val ha = haConfig() ?: return none(404)
        if (name.startsWith("do/")) return haDo(ha, name.removePrefix("do/"))
        val (path, type) = when (name) {
            "feed" -> ha.optString("feed") to "application/json"
            "doorbell" -> ha.optString("doorbell") to "image/jpeg"
            else -> return none(404)
        }
        if (!HA_PATH.matches(path) || path.contains("..")) return none(404)
        val m = HA_URL.matchEntire(ha.optString("url")) ?: return none(404)
        val host = m.groupValues[1]
        val port = m.groupValues[2].ifEmpty { "80" }.toInt()
        val body = try { httpGet(host, port, path) } catch (e: Exception) { null } ?: return none(502)
        return WebResourceResponse(type, if (type.endsWith("json")) "utf-8" else null, 200, "OK",
            mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(body))
    }

    private fun haDo(ha: JSONObject, action: String): WebResourceResponse {
        val reply = { code: Int, text: String -> WebResourceResponse("text/plain", "utf-8", code, text,
            mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0))) }
        val hook = ha.optString("webhook")
        if (!HA_ACTION.matches(action) || !HA_HOOK.matches(hook)) return reply(404, "Not found")
        val m = HA_URL.matchEntire(ha.optString("url")) ?: return reply(404, "Not found")
        val host = m.groupValues[1]
        val port = m.groupValues[2].ifEmpty { "80" }.toInt()
        val ok = try { httpPost(host, port, hook, JSONObject().put("action", action).toString()) } catch (e: Exception) { false }
        return if (ok) reply(200, "OK") else reply(502, "Bad gateway")
    }

    /** HTTP/1.0 POST of a small JSON body; true for any 2xx answer. */
    private fun httpPost(host: String, port: Int, path: String, json: String): Boolean {
        java.net.Socket().use { s ->
            s.connect(java.net.InetSocketAddress(host, port), 3000)
            s.soTimeout = 5000
            val body = json.toByteArray(Charsets.UTF_8)
            s.getOutputStream().write(("POST $path HTTP/1.0\r\nHost: $host:$port\r\nContent-Type: application/json\r\n" +
                "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII) + body)
            val status = s.getInputStream().bufferedReader(Charsets.US_ASCII).readLine() ?: return false
            return status.matches(Regex("HTTP/1\\.[01] 2\\d\\d.*"))
        }
    }

    private fun haConfig(): JSONObject? = try {
        prefs.getString("config", null)?.let { JSONObject(it).optJSONObject("home")?.optJSONObject("ha") }
    } catch (e: Exception) { null }

    /** HTTP/1.0 GET, body of a 200 only, at most HA_MAX bytes. */
    private fun httpGet(host: String, port: Int, path: String): ByteArray? {
        java.net.Socket().use { s ->
            s.connect(java.net.InetSocketAddress(host, port), 3000)
            s.soTimeout = 5000
            s.getOutputStream().write("GET $path HTTP/1.0\r\nHost: $host:$port\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
            val all = ByteArrayOutputStream()
            val buf = ByteArray(16384)
            val input = s.getInputStream()
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                all.write(buf, 0, n)
                if (all.size() > HA_MAX) return null
            }
            val raw = all.toByteArray()
            var end = -1
            for (i in 0 until raw.size - 3) {
                if (raw[i] == '\r'.code.toByte() && raw[i + 1] == '\n'.code.toByte() && raw[i + 2] == '\r'.code.toByte() && raw[i + 3] == '\n'.code.toByte()) { end = i; break }
            }
            if (end < 0) return null
            val status = String(raw, 0, end, Charsets.US_ASCII).lineSequence().first()
            if (!status.matches(Regex("HTTP/1\\.[01] 200 .*"))) return null
            return raw.copyOfRange(end + 4, raw.size)
        }
    }

    private fun mimeFor(ext: String): String {
        val type = when (ext.lowercase()) {
            "html" -> "text/html"
            "js" -> "application/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "webp" -> "image/webp"
            "svg" -> "image/svg+xml"
            "woff2" -> "font/woff2"
            else -> "application/octet-stream"
        }
        return type
    }

    private fun js(code: String) {
        web?.takeIf { pageReady }?.evaluateJavascript(code, null)
    }

    // ---------------------------------------------------------------- what the page can ask for

    inner class Native {
        @JavascriptInterface
        fun apps(): String {
            val out = JSONArray()
            for ((ri, label) in appList()) {
                val ai = ri.activityInfo
                out.put(JSONObject().apply {
                    put("package", ai.packageName)
                    put("label", label)
                    put("hasBanner", ai.banner != 0 || ai.applicationInfo.banner != 0)
                })
            }
            return out.toString()
        }

        @JavascriptInterface
        fun launch(pkg: String): Boolean = launchPackage(pkg)

        @JavascriptInterface
        fun openSettings(id: String): Boolean {
            val intent = when (id) {
                "wifi" -> Intent(Settings.ACTION_WIFI_SETTINGS)
                "picture" -> Intent(Settings.ACTION_DISPLAY_SETTINGS)
                "sound" -> Intent("com.android.tv.action.VIEW_SOUND_SETTINGS")
                "inputs" -> inputsIntent() ?: return false
                "bluetooth" -> Intent("com.android.tv.settings.ACCESSORIES_CONNECTED_DEVICES")
                "sleep" -> Intent("com.android.tv.settings.action.ENERGY_SAVING")
                "all" -> Intent(Settings.ACTION_SETTINGS)
                else -> return false
            }
            if (packageManager.resolveActivity(intent, 0) == null) return false
            return start(intent)
        }

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        // The TV's own input list (HDMI and the rest), for the Input quick button when there is no
        // bridge to press the TV_INPUT key. Only where the TV has a screen for it.
        @JavascriptInterface
        fun canOpenInputs(): Boolean = inputsIntent() != null

        @JavascriptInterface
        fun openInputs(): Boolean = inputsIntent()?.let { start(it) } ?: false

        // Start the page again (the Look button). The page cannot navigate itself: every
        // navigation is refused in shouldOverrideUrlLoading, reloads included.
        @JavascriptInterface
        fun reload() { main.post { showHome() } }

        // The saved copy has its own web storage, so the page keeps what it needs offline here.
        @JavascriptInterface
        fun keep(key: String, value: String) {
            getSharedPreferences("page", MODE_PRIVATE).edit().putString(key, value).apply()
        }

        @JavascriptInterface
        fun kept(key: String): String? = getSharedPreferences("page", MODE_PRIVATE).getString(key, null)
    }

    /**
     * An input list screen, if this TV has one. Makers name it differently, so each guess is checked
     * with resolveActivity: a wrong guess is skipped and, with none left, the Input button is hidden.
     */
    private fun inputsIntent(): Intent? = INPUT_ACTIONS.asSequence()
        .map { Intent(it) }
        .firstOrNull { packageManager.resolveActivity(it, 0) != null }

    @Volatile private var appCache: List<Pair<ResolveInfo, String>>? = null

    /** The TV's apps with their labels. Cached: reading labels for 30 apps is slow on this TV. */
    private fun tvApps(): List<ResolveInfo> = appList().map { it.first }

    private fun appList(): List<Pair<ResolveInfo, String>> = appCache ?: synchronized(this) {
        appCache ?: run {
            val q = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
            packageManager.queryIntentActivities(q, 0)
                .filter { it.activityInfo.packageName != packageName }
                .distinctBy { it.activityInfo.packageName }
                .map { it to it.loadLabel(packageManager).toString() }
                .sortedBy { it.second.lowercase() }
                .also { appCache = it }
        }
    }

    /** Builds the app list and every banner ahead of time, so the page never waits for them. */
    private fun warmApps() {
        appCache = null
        appList().forEach { bannerImage(it.first.activityInfo.packageName) }
    }

    /** The app's TV banner as a JPEG: memory, then disk, then drawn fresh. */
    private fun bannerImage(pkg: String): ByteArray? {
        banners[pkg]?.let { return it }
        val ri = tvApps().firstOrNull { it.activityInfo.packageName == pkg } ?: return null
        val version = try { packageManager.getPackageInfo(pkg, 0).lastUpdateTime } catch (e: Exception) { 0L }
        val file = java.io.File(java.io.File(filesDir, "banners").apply { mkdirs() }, "$pkg-$version-v3.jpg")
        val bytes = if (file.exists()) file.readBytes() else bannerBytes(ri)?.also { file.writeBytes(it) }
        if (bytes != null) banners[pkg] = bytes
        return bytes
    }

    private fun launchPackage(pkg: String): Boolean {
        val i = packageManager.getLeanbackLaunchIntentForPackage(pkg)
            ?: packageManager.getLaunchIntentForPackage(pkg)
            ?: return false
        return start(i)
    }

    private fun start(i: Intent): Boolean = try {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        main.post { startActivity(i) }
        true
    } catch (e: Exception) {
        false
    }

    private fun bannerBytes(ri: ResolveInfo): ByteArray? {
        val banner = ri.activityInfo.loadBanner(packageManager)
            ?: ri.activityInfo.applicationInfo.loadBanner(packageManager)
        val bmp = Bitmap.createBitmap(640, 360, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawColor(FLAP)
        if (banner != null) {
            banner.setBounds(0, 0, 640, 360)
            banner.draw(c)
        } else {
            iconTile(ri.loadIcon(packageManager), c)
        }
        return ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it); bmp.recycle() }.toByteArray()
    }

    /**
     * Apps with no TV banner still get a full-bleed tile, so the grid reads as one design: the
     * icon's own background fills the tile and its logo sits in the middle.
     */
    private fun iconTile(icon: Drawable, c: Canvas) {
        // the icon as a plain square, without the launcher's round mask
        val n = 432
        val sq = Bitmap.createBitmap(n, n, Bitmap.Config.ARGB_8888)
        val sc = Canvas(sq)
        if (icon is android.graphics.drawable.AdaptiveIconDrawable) {
            icon.background?.apply { setBounds(0, 0, n, n); draw(sc) }
            icon.foreground?.apply { setBounds(0, 0, n, n); draw(sc) }
        } else {
            icon.setBounds(0, 0, n, n)
            icon.draw(sc)
        }
        // find the logo: everything that differs from the icon's edge colour
        val edge = sq.getPixel(2, n / 2)
        var l = n; var t = n; var r = 0; var b = 0
        for (y in 0 until n step 2) for (x in 0 until n step 2) {
            val px = sq.getPixel(x, y)
            val d = Math.abs(Color.red(px) - Color.red(edge)) + Math.abs(Color.green(px) - Color.green(edge)) +
                Math.abs(Color.blue(px) - Color.blue(edge))
            if (d > 60 && Color.alpha(px) > 128) { l = minOf(l, x); t = minOf(t, y); r = maxOf(r, x); b = maxOf(b, y) }
        }
        if (r <= l || b <= t) { l = n / 4; t = n / 4; r = n * 3 / 4; b = n * 3 / 4 }
        // every logo about the same size: 150 px tall at most, 440 px wide at most
        val s = minOf(150f / (b - t), 440f / (r - l)).coerceIn(0.5f, 3f)
        val size = (n * s).toInt()
        val left = (320 - (l + r) / 2f * s).toInt()
        val top = (180 - (t + b) / 2f * s).toInt()
        // fill any gap with the icon's own edge colour, stretched, so the tile has no join
        c.drawColor(edge)
        val p = android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG)
        val rect = { a: Int, bb: Int, cc: Int, dd: Int -> android.graphics.Rect(a, bb, cc, dd) }
        if (left > 0) c.drawBitmap(sq, rect(1, 0, 2, n), rect(0, top, left, top + size), p)
        if (left + size < 640) c.drawBitmap(sq, rect(n - 2, 0, n - 1, n), rect(left + size, top, 640, top + size), p)
        if (top > 0) c.drawBitmap(sq, rect(0, 1, n, 2), rect(left, 0, left + size, top), p)
        if (top + size < 360) c.drawBitmap(sq, rect(0, n - 2, n, n - 1), rect(left, top + size, left + size, 360), p)
        c.drawBitmap(sq, null, rect(left, top, left + size, top + size), p)
        sq.recycle()
    }

    /** The app's square icon as a PNG, for the small badge on Keep watching tiles. */
    private fun iconImage(pkg: String): ByteArray? {
        icons[pkg]?.let { return it }
        val ri = tvApps().firstOrNull { it.activityInfo.packageName == pkg }
        val d = ri?.loadIcon(packageManager)
            ?: try { packageManager.getApplicationIcon(pkg) } catch (e: Exception) { return null }
        val bmp = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, 128, 128)
        d.draw(Canvas(bmp))
        val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it); bmp.recycle() }.toByteArray()
        icons[pkg] = bytes
        return bytes
    }

    // ---------------------------------------------------------------- never stuck: the native grid

    private fun showFallback() {
        main.removeCallbacks(retryHome)
        main.postDelayed(retryHome, if (retries++ == 0) QUICK_RETRY_MS else RETRY_MS)
        if (fallback != null) return
        val dp = resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(48), px(28), px(48), px(28))
        }
        column.addView(TextView(this).apply {
            text = "Home"
            setTextColor(CREAM)
            textSize = 34f
            typeface = Typeface.create("sans-serif-condensed", Typeface.BOLD)
        })
        column.addView(TextView(this).apply {
            text = "The home page didn't load. Your apps still work."
            setTextColor(CREAM_2)
            textSize = 17f
            setPadding(0, px(4), 0, px(18))
        })
        val grid = GridLayout(this).apply { columnCount = 5 }
        val tiles = tvApps().map { ri -> ri.activityInfo.packageName to ri } + listOf("settings" to null)
        for ((pkg, ri) in tiles) {
            val tile = FrameLayout(this).apply {
                isFocusable = true
                isClickable = true
                background = GradientDrawable().apply { setColor(FLAP); cornerRadius = px(4).toFloat() }
                foreground = GradientDrawable().apply { cornerRadius = px(6).toFloat() }
                setOnFocusChangeListener { v, has ->
                    v.animate().scaleX(if (has) 1.08f else 1f).scaleY(if (has) 1.08f else 1f).setDuration(150).start()
                    (v.foreground as GradientDrawable).setStroke(if (has) px(3) else 0, AMBER)
                    v.elevation = if (has) px(8).toFloat() else 0f
                }
                setOnClickListener { if (ri == null) start(Intent(Settings.ACTION_SETTINGS)) else launchPackage(pkg) }
            }
            if (ri != null) {
                tile.addView(ImageView(this).apply {
                    val ai = ri.activityInfo
                    val b = ai.loadBanner(packageManager) ?: ai.applicationInfo.loadBanner(packageManager)
                    if (b != null) {
                        setImageDrawable(b); scaleType = ImageView.ScaleType.CENTER_CROP
                    } else {
                        setImageDrawable(ri.loadIcon(packageManager)); scaleType = ImageView.ScaleType.CENTER_INSIDE
                        setPadding(px(30), px(18), px(30), px(30))
                    }
                }, MATCH)
                if (ri.activityInfo.loadBanner(packageManager) == null && ri.activityInfo.applicationInfo.loadBanner(packageManager) == null) {
                    tile.addView(label(ri.loadLabel(packageManager).toString(), px(8)))
                }
            } else {
                tile.addView(label("Settings", px(8)))
            }
            grid.addView(tile, GridLayout.LayoutParams().apply {
                width = px(160); height = px(90)
                setMargins(px(9), px(9), px(9), px(9))
            })
        }
        column.addView(grid)
        val scroll = ScrollView(this).apply { isFillViewport = true; addView(column) }
        fallback = scroll
        root.addView(scroll, MATCH)
        grid.getChildAt(0)?.requestFocus()
    }

    private fun label(text: String, pad: Int) = TextView(this).apply {
        this.text = text
        setTextColor(CREAM)
        textSize = 15f
        gravity = Gravity.BOTTOM or Gravity.START
        setPadding(pad, pad, pad, pad)
        layoutParams = FrameLayout.LayoutParams(MATCH_W, MATCH_W)
    }

    private fun removeFallback() {
        fallback?.let { root.removeView(it) }
        fallback = null
    }

    private fun hideSystemBars() {
        window.decorView.windowInsetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    companion object {
        private val INPUT_ACTIONS = listOf(
            "android.settings.TV_INPUT_SETTINGS",           // some Android TV builds
            "com.android.tv.action.VIEW_INPUTS",            // the Live Channels input picker
            "com.google.android.tv.action.VIEW_INPUTS",
            "android.media.tv.action.SETUP_INPUTS"          // the system list of TV inputs
        )
        private const val RETRY_MS = 15_000L
        private const val QUICK_RETRY_MS = 2_000L
        private const val TAG = "couchtv"
        // Never resolves on any network (.invalid is reserved): only shouldInterceptRequest answers it.
        private const val HOME_HOST = "home.tvos.invalid"
        private val TV_ID = Regex("[a-z-]{1,32}")
        // Home Assistant (home.ha in config.json): a private IPv4 address only, and only files in
        // its www folder, so a bad setting cannot point the TV anywhere else.
        private val HA_URL = Regex("http://((?:10\\.\\d{1,3}|192\\.168|172\\.(?:1[6-9]|2\\d|3[01]))\\.\\d{1,3}\\.\\d{1,3})(?::(\\d{2,5}))?/?")
        private val HA_PATH = Regex("/local/[A-Za-z0-9._-]{1,80}")
        private const val HA_MAX = 3_000_000
        private val HA_HOOK = Regex("/api/webhook/[A-Za-z0-9_-]{16,80}")
        private val HA_ACTION = Regex("[a-z0-9_]{1,40}")
        private const val BUNDLED = "www/tv"   // the built-in copy, in the app's assets
        private const val SLOW_MS = 2_500L
        private const val MATCH_W = ViewGroup.LayoutParams.MATCH_PARENT
        private val MATCH = FrameLayout.LayoutParams(MATCH_W, MATCH_W)
        private val GROUND = Color.parseColor("#0D1E19")
        private val FLAP = Color.parseColor("#131614")
        private val CREAM = Color.parseColor("#F2EAD8")
        private val CREAM_2 = Color.parseColor("#BDB6A7")
        private val AMBER = Color.parseColor("#FFB52E")
    }
}
