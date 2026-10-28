import groovy.json.JsonOutput
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.couchtv.launcher"
    compileSdk = 34
    defaultConfig {
        applicationId = "app.couchtv.launcher"
        minSdk = 28
        targetSdk = 34
        versionCode = 6
        versionName = "1.3.1-hero"
        // couch-tv-hero has no bridge: the home page is always the copy built into the app.
    }
    buildFeatures { buildConfig = true }
    // Release builds are signed with our own key, never the debug key. The key stays out of the
    // repo: pass its path and passwords as Gradle properties or environment variables
    // (HERO_KEYSTORE, HERO_KEYSTORE_PASSWORD, HERO_KEY_ALIAS, HERO_KEY_PASSWORD).
    fun secret(name: String): String? = (project.findProperty(name) as String?) ?: System.getenv(name)
    val keystore = secret("HERO_KEYSTORE")
    signingConfigs {
        if (keystore != null) create("hero") {
            storeFile = file(keystore)
            storePassword = secret("HERO_KEYSTORE_PASSWORD")
            keyAlias = secret("HERO_KEY_ALIAS") ?: "hero"
            keyPassword = secret("HERO_KEY_PASSWORD") ?: secret("HERO_KEYSTORE_PASSWORD")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Unset when there is no key: Gradle then builds an unsigned APK that no TV will install.
            signingConfig = signingConfigs.findByName("hero")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

/**
 * Copies tv-home/web into the app as assets/www/tv, plus a config.js made from config.json, so the
 * home works with no computer at all (option A). The settings file is -PconfigJson=<path>, else
 * config.json in the repo root, else config.example.json. apply.sh can hand the TV newer settings
 * later without a rebuild. Only the parts the TV home shows are copied: people, weather, the
 * home's look and each TV's quick buttons. Never secrets.
 */
abstract class BundleTvWeb : DefaultTask() {
    @get:InputDirectory
    abstract val web: DirectoryProperty

    @get:InputFile
    abstract val configJson: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun run() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        val dest = File(out, "www/tv")
        val src = web.get().asFile
        src.walkTopDown().filter { it.isFile }.forEach { f ->
            val rel = f.relativeTo(src).path
            // development only, or not part of the page
            if (rel == "mock.js" || rel.endsWith(".md") || f.name.startsWith(".")) return@forEach
            f.copyTo(File(dest, rel), overwrite = true)
        }
        File(dest, "config.js").writeText("window.COUCH_CONFIG = " + JsonOutput.toJson(publicConfig(configJson.get().asFile)) + ";\n")
    }

    private fun slug(s: Any?, fallback: String): String =
        Regex("[^a-z0-9]+").replace(s.toString().lowercase(), "-").trim('-').take(32).ifEmpty { fallback }

    @Suppress("UNCHECKED_CAST")
    private fun publicConfig(file: File): Map<String, Any?> {
        val c = JsonSlurper().parse(file) as Map<String, Any?>
        val people = mutableListOf<Map<String, Any?>>()
        for (p in (c["people"] as? List<Any?>) ?: emptyList<Any?>()) {
            val m: Map<String, Any?> = when (p) {
                is String -> mapOf("name" to p)
                is Map<*, *> -> p as Map<String, Any?>
                else -> continue
            }
            val name = m["name"]?.toString()?.trim().orEmpty()
            if (name.isEmpty() || people.size >= 12) continue
            val item = linkedMapOf<String, Any?>("id" to ((m["id"] as? String) ?: slug(name, "person")), "name" to name)
            (m["colour"] as? String)?.let { item["colour"] = it }
            people.add(item)
        }
        val tvs = (c["tvs"] as? List<Map<String, Any?>> ?: emptyList()).map { t ->
            mapOf("id" to t["id"], "name" to t["name"], "quick" to (t["quick"] as? List<Any?> ?: listOf("sleep")),
                "picture_modes" to emptyList<String>())
        }
        return mapOf(
            "people" to people,
            "weather" to c["weather"],
            "home" to (c["home"] ?: emptyMap<String, Any?>()),
            "tvs" to tvs,
            "default_tv" to (c["default_tv"] ?: tvs.firstOrNull()?.get("id")),
            "ask" to mapOf("enabled" to false),
            "phone_remote" to false,
        )
    }
}

val repoRoot = rootProject.projectDir.resolve("../..")
val configFile: File = (project.findProperty("configJson") as String?)?.let { file(it) }
    ?: repoRoot.resolve("config.json").takeIf { it.isFile }
    ?: repoRoot.resolve("config.example.json")

val bundleTvWeb = tasks.register<BundleTvWeb>("bundleTvWeb") {
    web.set(rootProject.layout.projectDirectory.dir("../web"))
    configJson.set(configFile)
    outputDir.set(layout.buildDirectory.dir("generated/tvweb"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(bundleTvWeb, BundleTvWeb::outputDir)
    }
}
