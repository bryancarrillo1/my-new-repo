// Browser smoke test: drives the real UI in headless Chromium against a running
// stack (`npm run dev`) and saves screenshots along the way.
//
//   npm run smoke:ui                      # screenshots → ./screenshots
//   npm run smoke:ui -- --out /tmp/shots  # elsewhere
//
// Covers: login, CORS upload straight to S3, live SSE updates on the pipeline
// page, the library view and the phone layout. Fails on any console error.
// (The CI version with assertions arrives in M9.)

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "screenshots" },
    url: { type: "string", default: "http://localhost:5173" },
  },
});
const out = path.resolve(values.out);
await mkdir(out, { recursive: true });

// The placeholder workers don't read the bytes, so any file will do until M5.
const clip = path.join(os.tmpdir(), "vpp-smoke-clip.mp4");
await writeFile(clip, randomBytes(2 * 1024 * 1024));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const shot = (name: string, fullPage = false) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage });

try {
  await page.goto(values.url);
  await shot("1-login");
  await page.fill("#username", `smoke-${Date.now().toString(36)}`);
  await page.click("button:has-text('Continue')");
  await page.waitForSelector("text=Your videos");
  await page.waitForSelector("text=Live");
  await shot("2-library-empty");

  await page.click("text=+ Upload video");
  await page.setInputFiles("input[type=file]", clip);
  await page.fill("#title", "Smoke test video");
  await shot("3-upload");
  await page.click("button:has-text('Upload')");
  await page.waitForURL(/\/videos\//, { timeout: 20_000 });

  // Live updates: a job must show as running without a page reload.
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("running"), null, {
    timeout: 20_000,
  });
  await page.waitForTimeout(1000);
  await shot("4-pipeline-running", true);
  await page.waitForFunction(() => document.querySelector("h1 + span")?.textContent === "ready", null, {
    timeout: 90_000,
  });
  await shot("5-pipeline-ready", true);

  await page.click("text=← Library");
  await page.waitForSelector("text=Your videos");
  await page.waitForTimeout(400);
  await shot("6-library");

  await page.setViewportSize({ width: 400, height: 860 });
  await page.goBack();
  await page.waitForSelector("text=Event timeline");
  await page.waitForTimeout(600);
  await shot("7-mobile", true);
} finally {
  await browser.close();
}

if (errors.length) {
  console.error("Console errors:", errors);
  process.exit(1);
}
console.log(`UI smoke passed. Screenshots in ${out}`);
