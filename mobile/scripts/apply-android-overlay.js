#!/usr/bin/env node
"use strict";

/**
 * mobile/scripts/apply-android-overlay.js
 *
 * `npx cap add android` generates the Android project, and `cap sync` rewrites
 * parts of it. Anything we hand-write inside android/ is therefore at risk of
 * being clobbered or lost on a regenerate. So the native code we own lives in
 * mobile/native/android/ and this script lays it over the generated project.
 *
 * Idempotent: every edit is fenced with a marker and skipped if already present,
 * so running it repeatedly (it runs after every `npm run build`) is safe.
 *
 * What it does:
 *   1. copies our Kotlin/Java sources into the generated source tree
 *   2. adds the Play Integrity + Mobile Wallet Adapter dependencies
 *   3. adds the buildConfig fields the plugins read
 *   4. adds the <queries> block Android 11+ needs to see wallet apps at all
 *   5. writes gradle.properties values from mobile/.env.android
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OVERLAY = path.join(ROOT, "native", "android");
const ANDROID = path.join(ROOT, "android");

const MARKER = "quiz-game additions";

if (!fs.existsSync(ANDROID)) {
  console.error(
    "❌ mobile/android does not exist yet.\n" +
      "   Run `npm run add:android` (which is `cap add android` + this script)."
  );
  process.exit(1);
}

// ── 1. Source files ───────────────────────────────────────────────────────────

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.endsWith(".additions")) continue; // fragments, not sources
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

const overlaySrc = path.join(OVERLAY, "app", "src");
if (fs.existsSync(overlaySrc)) {
  copyDir(overlaySrc, path.join(ANDROID, "app", "src"));
  console.log("✅ Copied native sources");
}

// ── 2/3. app/build.gradle ─────────────────────────────────────────────────────

const gradlePath = path.join(ANDROID, "app", "build.gradle");
let gradle = fs.readFileSync(gradlePath, "utf8");

if (gradle.includes(MARKER)) {
  console.log("↳ build.gradle already patched, skipping");
} else {
  // buildConfig fields — the plugins read these instead of hardcoding secrets.
  const buildConfigFields = `
        // --- BEGIN ${MARKER} ---
        buildConfigField "long",   "GOOGLE_CLOUD_PROJECT_NUMBER", "\${project.findProperty('GOOGLE_CLOUD_PROJECT_NUMBER') ?: 0}L"
        buildConfigField "String", "APP_IDENTITY_URI",  "\\"\${project.findProperty('APP_IDENTITY_URI')  ?: 'https://localhost'}\\""
        buildConfigField "String", "APP_IDENTITY_NAME", "\\"\${project.findProperty('APP_IDENTITY_NAME') ?: 'Proof of Smart'}\\""
        buildConfigField "String", "SOLANA_CLUSTER",    "\\"\${project.findProperty('SOLANA_CLUSTER')    ?: 'devnet'}\\""
        // --- END ${MARKER} ---
`;

  // Anchor on the generated versionName line, which sits inside defaultConfig.
  const versionNameMatch = gradle.match(/^\s*versionName\s+.*$/m);
  if (!versionNameMatch) {
    console.error("❌ Could not find versionName in build.gradle to anchor on");
    process.exit(1);
  }
  gradle = gradle.replace(
    versionNameMatch[0],
    versionNameMatch[0] + "\n" + buildConfigFields
  );

  // buildConfigField requires the buildConfig feature on AGP 8+.
  if (/buildFeatures\s*\{/.test(gradle)) {
    gradle = gradle.replace(
      /buildFeatures\s*\{/,
      "buildFeatures {\n        buildConfig true"
    );
  } else {
    gradle = gradle.replace(
      /^android\s*\{/m,
      "android {\n    buildFeatures {\n        buildConfig true\n    }"
    );
  }

  // Dependencies.
  const deps = `
    // --- BEGIN ${MARKER} ---
    implementation "com.google.android.play:integrity:1.4.0"
    implementation "com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.3"
    implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3"
    // --- END ${MARKER} ---
`;
  const depsMatch = gradle.match(/^dependencies\s*\{/m);
  if (!depsMatch) {
    console.error("❌ Could not find a dependencies block in build.gradle");
    process.exit(1);
  }
  gradle = gradle.replace(depsMatch[0], depsMatch[0] + deps);

  fs.writeFileSync(gradlePath, gradle);
  console.log("✅ Patched app/build.gradle");
}

// ── 4. AndroidManifest.xml ────────────────────────────────────────────────────
// Android 11+ hides other installed apps unless declared. Without this, Mobile
// Wallet Adapter reports "no wallet found" on a phone that has three installed.

const manifestPath = path.join(
  ANDROID,
  "app",
  "src",
  "main",
  "AndroidManifest.xml"
);
let manifest = fs.readFileSync(manifestPath, "utf8");

if (manifest.includes(MARKER)) {
  console.log("↳ AndroidManifest already patched, skipping");
} else {
  const queries = `
    <!-- BEGIN ${MARKER} -->
    <queries>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="solana-wallet" />
        </intent>
    </queries>
    <!-- END ${MARKER} -->
`;
  manifest = manifest.replace(/<\/manifest>/, queries + "</manifest>");
  fs.writeFileSync(manifestPath, manifest);
  console.log("✅ Patched AndroidManifest.xml");
}

// ── 5. gradle.properties ──────────────────────────────────────────────────────
// Values live in mobile/.env.android (gitignored) so a project number or an
// identity URL is never committed.

const envPath = path.join(ROOT, ".env.android");
if (!fs.existsSync(envPath)) {
  console.warn(
    "⚠️  mobile/.env.android not found — the build will fall back to defaults\n" +
      "   (GOOGLE_CLOUD_PROJECT_NUMBER=0 makes attestation reject every request).\n" +
      "   Copy .env.android.example and fill it in."
  );
} else {
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }

  const propsPath = path.join(ANDROID, "gradle.properties");
  let props = fs.existsSync(propsPath)
    ? fs.readFileSync(propsPath, "utf8")
    : "";
  props = props.replace(
    new RegExp(`\\n?# BEGIN ${MARKER}[\\s\\S]*?# END ${MARKER}\\n?`),
    ""
  );
  const block =
    `\n# BEGIN ${MARKER}\n` +
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") +
    `\n# END ${MARKER}\n`;
  fs.writeFileSync(propsPath, props + block);
  console.log(
    `✅ Wrote ${Object.keys(env).length} values to gradle.properties`
  );
}

console.log("\nOverlay applied.");
