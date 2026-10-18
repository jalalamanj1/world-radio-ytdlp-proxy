#!/usr/bin/env node
/**
 * Keep the proxy's YouTube cookies fresh, forever, with no human in the loop.
 *
 * A real Chromium profile is kept on the box and stays signed in to a throwaway
 * Google account. Google rotates its own session tokens whenever the profile
 * touches youtube.com, so this script mostly just has to *visit the site* on a
 * schedule: that is what keeps the cookies alive indefinitely.
 *
 * If the session is ever dropped it tries to sign back in with the throwaway
 * credentials, and if that fails it exits non-zero so the health monitor alerts
 * instead of the app quietly degrading.
 *
 * Runs as a systemd timer (wr-refresh.timer), not in the foreground.
 *
 * Env:
 *   YT_EMAIL / YT_PASSWORD   throwaway account (only needed for a re-login)
 *   WR_PROFILE               Chromium profile dir (default /opt/wr/profile)
 *   WR_COOKIE_DEST           cookies.txt to write   (default /opt/wr/cookies.txt)
 *   ADMIN_TOKEN              token for /admin/reload-cookies
 *   WR_HEADLESS=0            run headed (needs a display; handy for debugging)
 *   WR_CHROME_ARGS           extra Chromium flags, space separated
 */
import { chromium } from "playwright";
import { writeFileSync, renameSync, readFileSync } from "node:fs";
import path from "node:path";

const PROFILE = process.env.WR_PROFILE || "/opt/wr/profile";
const DEST = process.env.WR_COOKIE_DEST || "/opt/wr/cookies.txt";
const EMAIL = process.env.YT_EMAIL || "";
const PASSWORD = process.env.YT_PASSWORD || "";
const HEADLESS = process.env.WR_HEADLESS !== "0";
const CHROME_ARGS = (process.env.WR_CHROME_ARGS || "").split(" ").filter(Boolean);
const RELOAD_URL = process.env.WR_RELOAD_URL || "http://127.0.0.1:8080/admin/reload-cookies";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// The set yt-dlp needs to prove "this is a signed-in human browser".
const AUTH = new Set([
  "SID", "HSID", "SSID", "APISID", "SAPISID", "LOGIN_INFO",
  "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS",
]);
// Below this many auth cookies we do not consider the session usable.
const MIN_AUTH = 5;

const log = (...a) => console.log(new Date().toISOString(), ...a);

function netscape(cookies) {
  const keep = (domain) => {
    const d = (domain || "").replace(/^\./, "").toLowerCase();
    return (
      d === "youtube.com" || d.endsWith(".youtube.com") ||
      d === "google.com" || d.endsWith(".google.com")
    );
  };
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Written by refresh-cookies.mjs - only youtube.com / google.com cookies.",
    "",
  ];
  for (const c of cookies) {
    if (!keep(c.domain)) continue;
    const domain = (c.httpOnly ? "#HttpOnly_" : "") + c.domain;
    const flag = c.domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expires = Math.floor(c.expires && c.expires > 0 ? c.expires : 0);
    lines.push(
      [domain, flag, c.path || "/", secure, String(expires), c.name, c.value ?? ""].join("\t"),
    );
  }
  return lines.join("\n") + "\n";
}

async function authNames(ctx) {
  const cookies = await ctx.cookies("https://www.youtube.com");
  const have = new Set(cookies.map((c) => c.name));
  return [...AUTH].filter((n) => have.has(n));
}

async function signIn(page) {
  log("session missing -> signing in as", EMAIL);
  await page.goto("https://accounts.google.com/ServiceLogin?service=youtube", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector('input[type="email"]', { timeout: 45000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.click("#identifierNext");
  await page.waitForSelector('input[type="password"], input[name="Passwd"]', { timeout: 45000 });
  await page.waitForTimeout(1500);
  await page.fill('input[type="password"], input[name="Passwd"]', PASSWORD);
  await page.click("#passwordNext");
  await page.waitForTimeout(6000);
  const url = page.url();
  if (!/youtube\.com|myaccount\.google\.com/.test(url)) {
    log("still on", url, "(a CAPTCHA or 2FA prompt would need a human - see README)");
  }
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: HEADLESS,
  args: CHROME_ARGS,
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
});

let exitCode = 0;
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // Visiting youtube.com is what rotates __Secure-*PSIDTS, so do it every run
  // even when the session is healthy.
  await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);

  let names = await authNames(ctx);
  log("auth cookies after visit:", names.length, names.join(",") || "(none)");

  if (names.length < MIN_AUTH && EMAIL && PASSWORD) {
    try {
      await signIn(page);
      await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(4000);
    } catch (e) {
      log("sign-in attempt failed:", e.message);
    }
    names = await authNames(ctx);
    log("auth cookies after sign-in:", names.length);
  }

  if (names.length < MIN_AUTH) {
    log("NOT SIGNED IN - refusing to overwrite cookies with an anonymous set");
    exitCode = 2;
  } else {
    const tmp = `${DEST}.tmp`;
    writeFileSync(tmp, netscape(await ctx.cookies()), "utf8");
    renameSync(tmp, DEST); // atomic: the proxy never reads a half-written file
    const size = readFileSync(DEST, "utf8").length;
    log(`wrote ${DEST} (${size} bytes, ${names.length} auth cookies)`);

    // Hot-reload so a rotation never interrupts a playing stream.
    try {
      const r = await fetch(RELOAD_URL, {
        method: "POST",
        headers: { "x-admin-token": ADMIN_TOKEN },
        signal: AbortSignal.timeout(15000),
      });
      log("proxy reload ->", r.status, (await r.text()).slice(0, 200));
    } catch (e) {
      log("proxy reload failed (proxy down?):", e.message);
      exitCode = 0; // cookies are still written; next run retries the reload
    }
  }
} catch (e) {
  log("ERROR:", e.stack || e.message);
  exitCode = 3;
} finally {
  await ctx.close().catch(() => {});
}

process.exit(exitCode);
