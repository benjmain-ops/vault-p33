// Renders the bingo page's icons and link-preview image with Chromium.
// Usage: node scripts/bingo-assets.js   (CHROMIUM = path of the binary)
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const OUT = path.join(__dirname, "..", "docs", "bingo");
const FONT = "data:font/woff2;base64," + fs.readFileSync(path.join(__dirname, "..", "docs", "play", "fonts", "archivo.woff2")).toString("base64");
const hits = new Set([2, 7, 8, 13, 14, 15, 20, 25, 26]);
const cells = [...Array(30).keys()].map((i) => `<rect x="${12 + (i % 6) * 13}" y="${15 + Math.floor(i / 6) * 14}" width="11" height="12" rx="2.5" fill="${hits.has(i) ? "#F2C230" : "#2A3140"}"/>`).join("");
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100"><rect width="100" height="100" rx="0" fill="#0B0D12"/>${cells}</svg>`;
const icon = (size) => `<!doctype html><html><body style="margin:0">${svg(size)}</body></html>`;

const og = `<!doctype html><html><head><style>
  @font-face { font-family: "Archivo"; src: url("${FONT}") format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }
  body { margin: 0; width: 1200px; height: 630px; background: radial-gradient(900px 520px at 78% -10%, rgba(220,47,51,.38), transparent 70%), #0B0D12; color: #F4F5F7; font-family: "Archivo"; display: flex; align-items: center; gap: 60px; padding: 0 80px; box-sizing: border-box; }
  .text { flex: 1; }
  h1 { margin: 0; font-weight: 800; font-stretch: 64%; font-size: 168px; line-height: .9; }
  p { margin: 24px 0 0; font-size: 38px; line-height: 1.22; color: #AAB1BD; max-width: 13em; }
  .balls { display: flex; gap: 10px; margin-top: 36px; }
  .ball { width: 60px; height: 60px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-stretch: 66%; font-size: 30px; color: #fff; background: radial-gradient(circle at 32% 28%, #FF7A70, #DC2F33 58%, #A51B1F); box-shadow: 0 0 24px rgba(220,47,51,.5); }
  .g { display: grid; grid-template-columns: repeat(6, 56px); gap: 8px; background: #151922; padding: 20px; border-radius: 18px; box-shadow: 0 0 0 1.5px #2A3140; }
  .g span { height: 56px; display: grid; place-items: center; border-radius: 9px; background: #0B0D12; color: #AAB1BD; font-weight: 700; font-stretch: 66%; font-size: 26px; box-shadow: inset 0 0 0 1px #2A3140; }
  .g span.hit { background: #F2C230; color: #15181D; box-shadow: none; }
</style></head><body>
  <div class="text"><h1>Trente</h1><p>The BCM DAO bingo on Avalanche, as it happens.</p>
    <div class="balls">${[42, 17, 88, 5, 61].map((n) => `<span class="ball">${n}</span>`).join("")}</div></div>
  <div class="g">${[...Array(30).keys()].map((i) => `<span class="${hits.has(i) ? "hit" : ""}">${[3, 42, 17, 55, 88, 9, 61, 5, 23, 77, 14, 30, 48, 91, 2, 66, 19, 84, 37, 72, 11, 58, 95, 26, 40, 69, 8, 53, 33, 99][i]}</span>`).join("")}</div>
</body></html>`;

(async () => {
  fs.writeFileSync(path.join(OUT, "icon.svg"), svg(100));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  for (const size of [180, 192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(icon(size));
    await page.screenshot({ path: path.join(OUT, `icon-${size}.png`), omitBackground: true });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(og);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, "og.png") });
  await browser.close();
  console.log("bingo assets written to " + OUT);
})();
