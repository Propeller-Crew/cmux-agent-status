// Renders docs/media from scene.html:
//   node render.mjs stills   hero.png, window.png, cards.png, octopus.gif
//   node render.mjs video    demo.mp4 (16:9) and demo.gif for the README
//   node render.mjs social   out/demo-vertical.mp4 (9:16), out/poster.png (4:5)
//   node render.mjs features features/*.gif, one short loop per README feature
//   node render.mjs directions   out/directions/: design directions side by side (?theme=…)
//   node render.mjs pick balloon  out/directions/: one theme's banner and sections loop
//   node render.mjs all
// Needs ffmpeg on PATH and `npm ci` here (Playwright's Chromium).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(HERE, "..");
const OUT = join(HERE, "out");
const SCENE = pathToFileURL(join(HERE, "scene.html")).href;
const FPS = 30;

// The octopus comes straight from the sidebar, so new frames show up here too.
function octopus() {
  const src = readFileSync(join(HERE, "../../../sidebars/agent-status.js"), "utf8");
  const palette = JSON.parse(/const OCTO_PALETTE = (\{.*?\});/s.exec(src)[1]);
  const framesSrc = /const OCTO_FRAMES = (\{.*?\n\});/s.exec(src)[1];
  const frames = new Function("return " + framesSrc)();
  return { palette, frames };
}

const ffmpeg = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
const size = (p) => (statSync(p).size / 1024 / 1024).toFixed(2) + " MB";

async function open(browser, query, dpr) {
  const page = await browser.newPage({ deviceScaleFactor: dpr, viewport: { width: 1920, height: 1920 } });
  await page.addInitScript((o) => { window.__OCTO = o; }, octopus());
  await page.goto(SCENE + "?" + query);
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => document.fonts.ready);
  const box = await page.evaluate(() => {
    const s = document.getElementById("stage");
    return { width: s.offsetWidth, height: s.offsetHeight };
  });
  await page.setViewportSize(box);
  return { page, box };
}

async function still(browser, mode, file, dpr = 2, transparent = false) {
  const { page } = await open(browser, "mode=" + mode, dpr);
  await page.screenshot({ path: file, omitBackground: transparent });
  await page.close();
  console.log(file, size(file));
}

async function frames(browser, query, count, step, dir, dpr = 1, transparent = false) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { page } = await open(browser, query, dpr);
  for (let i = 0; i < count; i += 1) {
    await page.evaluate((t) => window.seek(t), i * step);
    await page.screenshot({ path: join(dir, String(i).padStart(5, "0") + ".png"), omitBackground: transparent });
  }
  await page.close();
}

async function stills(browser) {
  await still(browser, "hero", join(MEDIA, "hero.png"));
  await still(browser, "window", join(MEDIA, "window.png"), 2, true);
  await still(browser, "cards", join(MEDIA, "cards.png"), 2, true);
  // Octopus: four ticks cover every mood's loop (idle has four frames).
  const dir = join(OUT, "octo");
  await frames(browser, "mode=octo", 4, 1, dir, 1, false);
  const gif = join(MEDIA, "octopus.gif");
  ffmpeg("-framerate", "1.6", "-i", join(dir, "%05d.png"), "-vf",
    "scale=iw*2:-1:flags=neighbor,split[a][b];[a]palettegen=reserve_transparent=0:max_colors=64[p];[b][p]paletteuse=dither=none", "-loop", "0", gif);
  console.log(gif, size(gif));
}

async function video(browser) {
  const dur = 28;
  const dir = join(OUT, "frames-16x9");
  await frames(browser, "mode=video&fmt=16x9", dur * FPS, 1 / FPS, dir);
  const mp4 = join(MEDIA, "demo.mp4");
  ffmpeg("-framerate", String(FPS), "-i", join(dir, "%05d.png"), "-c:v", "libx264", "-preset", "slow", "-crf", "20",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4);
  console.log(mp4, size(mp4));
  const gif = join(MEDIA, "demo.gif");
  ffmpeg("-i", mp4, "-vf",
    "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=160[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", "-loop", "0", gif);
  console.log(gif, size(gif));
}

async function social(browser) {
  mkdirSync(OUT, { recursive: true });
  const dur = 28;
  const dir = join(OUT, "frames-9x16");
  await frames(browser, "mode=video&fmt=9x16", dur * FPS, 1 / FPS, dir);
  const mp4 = join(OUT, "demo-vertical.mp4");
  ffmpeg("-framerate", String(FPS), "-i", join(dir, "%05d.png"), "-c:v", "libx264", "-preset", "slow", "-crf", "19",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4);
  console.log(mp4, size(mp4));
  await still(browser, "poster", join(OUT, "poster.png"), 1);
}

// One short GIF loop per README feature, into docs/media/features/<name>.gif.
//   node render.mjs features            every loop
//   node render.mjs features close lang only these
const FEAT_FPS = 15;
async function features(browser, names) {
  const dir = join(MEDIA, "features");
  mkdirSync(dir, { recursive: true });
  const probe = await open(browser, "mode=feat", 1);
  const all = await probe.page.evaluate(() => window.FEATS);
  await probe.page.close();
  for (const name of names.length ? names : all) await loop(browser, "mode=feat&name=" + name, join(dir, name + ".gif"));
}

async function loop(browser, query, gif) {
  const { page } = await open(browser, query, 2);
  const dur = await page.evaluate(() => window.DURATION);
  const fdir = join(OUT, "feat-" + query.replace(/\W+/g, "-"));
  rmSync(fdir, { recursive: true, force: true });
  mkdirSync(fdir, { recursive: true });
  const count = Math.round(dur * FEAT_FPS);
  for (let i = 0; i < count; i += 1) {
    await page.evaluate((t) => window.seek(t), i / FEAT_FPS);
    await page.screenshot({ path: join(fdir, String(i).padStart(5, "0") + ".png") });
  }
  await page.close();
  ffmpeg("-framerate", String(FEAT_FPS), "-i", join(fdir, "%05d.png"), "-vf",
    "split[a][b];[a]palettegen=stats_mode=full:max_colors=96[p];[b][p]paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", gif);
  console.log(gif, size(gif));
}

// A chosen direction, for sign-off before the whole set: its banner and the sections loop.
async function pick(browser, theme) {
  const dir = join(OUT, "directions");
  mkdirSync(dir, { recursive: true });
  const { page } = await open(browser, "mode=hero&theme=" + theme, 2);
  await page.screenshot({ path: join(dir, theme + "-banner.png") });
  await page.close();
  console.log(join(dir, theme + "-banner.png"));
  await loop(browser, "mode=feat&name=sections&theme=" + theme, join(dir, theme + "-sections.gif"));
}

// One frame of a feature loop: node render.mjs fpeek close 1.8 → out/fpeek-close-1.8.png
async function fpeek(browser, name, t) {
  mkdirSync(OUT, { recursive: true });
  const { page } = await open(browser, `mode=feat&name=${name}&t=${t}`, 1);
  const file = join(OUT, `fpeek-${name}-${t}.png`);
  await page.screenshot({ path: file });
  await page.close();
  console.log(file);
}

// Design directions: banner, one feature tile and the poster per theme, plus a page
// that shows them side by side → out/directions/
//   node render.mjs directions [theme…]
async function directions(browser, names) {
  const dir = join(OUT, "directions");
  mkdirSync(dir, { recursive: true });
  const probe = await open(browser, "mode=hero", 1);
  const themes = await probe.page.evaluate(() => window.THEMES);
  await probe.page.close();
  const shot = async (query, file, dpr) => {
    const { page } = await open(browser, query, dpr);
    await page.screenshot({ path: join(dir, file) });
    await page.close();
    console.log(join(dir, file));
  };
  const full = Object.keys(themes).filter((k) => themes[k].poster);
  for (const name of names.length ? names : full) {
    await shot(`mode=hero&theme=${name}`, `${name}-banner.png`, 2);
    await shot(`mode=feat&name=sections&t=2.2&theme=${name}`, `${name}-tile.png`, 2);
    await shot(`mode=poster&theme=${name}`, `${name}-poster.png`, 1);
  }
  const rows = full.map((k) => [k, themes[k]]).map(([k, v], i) => `<section>
    <h2><span>${String.fromCharCode(65 + i)}</span> ${v.label}</h2><p>${v.why}</p>
    <div class="row"><img class="b" src="${k}-banner.png"><img class="t" src="${k}-tile.png"><img class="p" src="${k}-poster.png"></div></section>`).join("");
  writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>Design directions</title>
<style>body{margin:0;padding:40px 48px;background:#f4f4f2;color:#111;font:16px/1.5 -apple-system,system-ui,sans-serif}
h1{font-size:28px;margin:0 0 4px}section{margin:40px 0 0;padding-top:28px;border-top:1px solid #ccc}
h2{font-size:22px;margin:0}h2 span{display:inline-block;width:30px;color:#888}p{margin:6px 0 16px;max-width:900px;color:#444}
.row{display:flex;gap:16px;align-items:flex-start}.row img{display:block;box-shadow:0 0 0 1px #0002}
.b{width:760px}.t{width:340px}.p{width:304px}</style>
<h1>Claude sidebar: four design directions</h1><div style="color:#666">Banner 2:1 · feature tile · poster 4:5. The panel is the product UI and keeps its colours.</div>${rows}`);
  const page = await browser.newPage({ viewport: { width: 1520, height: 900 } });
  await page.goto(pathToFileURL(join(dir, "index.html")).href);
  await page.screenshot({ path: join(dir, "compare.png"), fullPage: true });
  await page.close();
  console.log(join(dir, "compare.png"));
}

// One video frame, for checking a scene without rendering the whole clip:
//   node render.mjs peek 16x9 12.5   → out/peek-16x9-12.5.png
async function peek(browser, fmt, t) {
  mkdirSync(OUT, { recursive: true });
  const { page } = await open(browser, `mode=video&fmt=${fmt}&t=${t}`, 1);
  const file = join(OUT, `peek-${fmt}-${t}.png`);
  await page.screenshot({ path: file });
  await page.close();
  console.log(file);
}

const what = process.argv[2] ?? "all";
const browser = await chromium.launch();
try {
  if (what === "peek") for (const t of process.argv.slice(4)) await peek(browser, process.argv[3], t);
  if (what === "fpeek") for (const t of process.argv.slice(4)) await fpeek(browser, process.argv[3], t);
  if (what === "features") await features(browser, process.argv.slice(3));
  if (what === "directions") await directions(browser, process.argv.slice(3));
  if (what === "pick") await pick(browser, process.argv[3]);
  if (what === "all") await features(browser, []);
  if (what === "stills" || what === "all") await stills(browser);
  if (what === "video" || what === "all") await video(browser);
  if (what === "social" || what === "all") await social(browser);
} finally {
  await browser.close();
}
