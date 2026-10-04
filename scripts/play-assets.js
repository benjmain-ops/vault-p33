// Renders the play page's icons and its link-preview image with Chromium.
// Usage: node scripts/play-assets.js   (CHROMIUM = path of the binary)
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const OUT = path.join(__dirname, "..", "docs", "play");
const FONT = "data:font/woff2;base64," + fs.readFileSync(path.join(OUT, "fonts", "archivo.woff2")).toString("base64");
const CROSS = '<path d="M8 9c7 6 15 15 24 23"/><path d="M32 8C24 16 15 24 9 33"/>';

const icon = (size) => `<!doctype html><html><body style="margin:0">
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#DC2F33"/>
  <rect x="24" y="24" width="52" height="52" rx="11" fill="#fff"/>
  <g transform="translate(30 30)" fill="none" stroke="#1B3FA8" stroke-width="4.6" stroke-linecap="round">${CROSS}</g>
</svg></body></html>`;

const picked = new Set([3, 9, 14, 17, 21, 24]);
const boxes = [...Array(24).keys()].map((i) => i + 1).map((n) => `<div class="box">${n}${picked.has(n) ? `<svg viewBox="0 0 40 40" style="transform:rotate(${((n * 37) % 13) - 6}deg)">${CROSS}</svg>` : ""}</div>`).join("");
const og = `<!doctype html><html><head><style>
  @font-face { font-family: "Archivo"; src: url("${FONT}") format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }
  body { margin: 0; width: 1200px; height: 630px; background: #EDF0F3; color: #15181D; font-family: "Archivo"; display: flex; align-items: center; gap: 64px; padding: 0 76px; box-sizing: border-box; overflow: hidden; }
  .text { flex: 1; }
  h1 { margin: 0; font-weight: 800; font-stretch: 64%; font-size: 168px; line-height: 0.9; }
  p { margin: 26px 0 0; font-size: 40px; line-height: 1.22; color: #3E4652; max-width: 12.5em; }
  .balls { display: flex; gap: 10px; margin-top: 38px; align-items: center; }
  .ball { width: 58px; height: 58px; border-radius: 50%; background: #DC2F33; color: #fff; display: grid; place-items: center; font-weight: 800; font-stretch: 64%; font-size: 30px; box-shadow: inset 0 -5px 0 rgba(0,0,0,.16); }
  .ball.extra { background: #fff; color: #DC2F33; box-shadow: inset 0 0 0 4px #DC2F33; }
  .plus { font-size: 30px; font-weight: 700; color: #5B6472; }
  .slip { width: 470px; box-sizing: border-box; background: #fff; border-radius: 14px; box-shadow: 0 0 0 1.5px #D3D9E0, 0 30px 44px -30px rgba(21,24,29,.6); padding: 0 26px 30px; transform: rotate(3deg); flex: none; }
  .slip::before { content: ""; display: block; height: 13px; background: repeating-linear-gradient(90deg, #15181D 0 7px, transparent 7px 21px); transform: translateY(16px); margin-bottom: 44px; }
  .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
  .box { position: relative; aspect-ratio: 1; border: 2.2px solid #DC2F33; border-radius: 10px; color: #DC2F33; font-weight: 750; font-stretch: 64%; font-size: 30px; display: grid; place-items: center; }
  .box svg { position: absolute; inset: 9%; width: 82%; height: 82%; mix-blend-mode: multiply; }
  .box svg path { fill: none; stroke: #1B3FA8; stroke-width: 3.3; stroke-linecap: round; }
</style></head><body>
  <div class="text">
    <h1>Sixte</h1>
    <p>Loterie AVAX. 6 numéros sur 24, deux tirages par jour.</p>
    <div class="balls">${[3, 9, 14, 17, 21, 24, 7].map((n) => `<span class="ball">${n}</span>`).join("")}<span class="plus">+</span><span class="ball extra">2</span><span class="ball extra">5</span></div>
  </div>
  <div class="slip"><div class="grid">${boxes}</div></div>
</body></html>`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  for (const [name, size] of [["icon-180", 180], ["icon-192", 192], ["icon-512", 512]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(icon(size));
    await page.screenshot({ path: path.join(OUT, name + ".png") });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(og);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, "og.png") });
  await browser.close();
  console.log("play assets written to", OUT);
})().catch((e) => { console.error(e); process.exit(1); });
