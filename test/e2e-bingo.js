// End-to-end test of the bingo page: real browser, local chain, a draw replayed on the clock.
// Usage: node scripts/build.js && node test/e2e-bingo.js   (Chromium required; SHOTS_DIR to keep screenshots)
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { chromium } = require("playwright-core");
const { deploy } = require("./helpers");

const WEB = path.join(__dirname, "..", "docs");
const SHOTS = process.env.SHOTS_DIR;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

(async () => {
  const gp = ganache.provider({ logging: { quiet: true }, chain: { chainId: 43114, hardfork: "shanghai" }, wallet: { totalAccounts: 3, defaultBalance: 1000 } });
  const provider = new ethers.BrowserProvider(gp, undefined, { cacheTimeout: -1 });
  const [deployer, user, other] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const bingo = await deploy("MockBingo", deployer);

  // round 1: on sale, with three grids
  await (await bingo.createRound()).wait();
  const pool = [...Array(100).keys()].map((i) => 101 + i * 7); // NFT ids
  await (await bingo.setPool(1, pool)).wait();
  const mine = [...Array(30).keys()].map((i) => i + 1); // 1..30
  const theirs = [...Array(30).keys()].map((i) => 71 + i); // 71..100
  const far = [...Array(30).keys()].map((i) => 40 + i); // 40..69
  await (await bingo.addGrid(1, user.address, mine)).wait();
  await (await bingo.addGrid(1, other.address, theirs)).wait();
  await (await bingo.addGrid(1, other.address, far)).wait();

  const CONFIG = "window.VAULT_CONFIG = " + JSON.stringify({
    factory: "", chainId: 43114, chainName: "Avalanche C-Chain", rpcUrl: "/rpc", explorer: "https://snowscan.xyz", walletConnectProjectId: "",
    addresses: { p33: ethers.ZeroAddress, wavax: ethers.ZeroAddress, lottery: ethers.ZeroAddress, pool: ethers.ZeroAddress, bingo: bingo.target },
    ipfsGateway: "/ipfs/", bingoSecondsPerNumber: 0.2,
  }) + ";";
  const one = async ({ id, method, params }) => {
    try { return { jsonrpc: "2.0", id, result: await gp.request({ method, params }) }; }
    catch (e) { return { jsonrpc: "2.0", id, error: { code: e.code || -32000, message: e.message } }; }
  };
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/rpc") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const j = JSON.parse(body);
        const out = Array.isArray(j) ? await Promise.all(j.map(one)) : await one(j);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out, (k, v) => (typeof v === "bigint" ? "0x" + v.toString(16) : v)));
      });
      return;
    }
    const url = req.url.split("?")[0];
    if (url === "/config.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(CONFIG);
    if (url.startsWith("/ipfs/")) return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    const file = path.join(WEB, url.endsWith("/") ? url + "index.html" : url);
    if (!file.startsWith(WEB) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/bingo/`;

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "warning" || m.type() === "error") console.log("console:", m.text()); });
  await page.addInitScript((acct) => { window.ethereum = { on() {}, async request({ method }) { if (method === "eth_requestAccounts" || method === "eth_accounts") return [acct]; throw new Error("not needed"); } }; }, user.address.toLowerCase());
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true });
  const text = (id) => page.textContent("#" + id);
  const step = (s) => console.log("✔ " + s);

  // 1. on sale: the round, the price, the leaderboard with the three grids, no draw
  await page.goto(url);
  await page.waitForFunction(() => /Round no\. 1 · Draw in about (5[01]|49) min/.test(document.getElementById("headline").textContent), null, { timeout: 20000 });
  assert.match(await text("leadSub"), /^0\.08 AVAX a grid · 3 grids sold so far/);
  await page.waitForFunction(() => document.querySelectorAll("#rank tbody tr").length === 3);
  assert.match(await text("nftIdle"), /The draw has not started/);
  assert.equal(await page.$$eval("#board span.out", (x) => x.length), 0);
  assert.match(await text("mine"), /Connect your wallet/);
  await shot("bingo-1-sale");
  step("on sale: round, price, leaderboard");

  // 2. connected: my grid is shown, with everything still missing
  await page.click("#connectBtn"); await page.click("#walletList button");
  await page.waitForSelector("#mine .card");
  assert.match(await text("mine"), /Grid #1.*0\/30.*line 6 left.*column 5 left.*corners 4 left.*2 lines 12 left.*bingo 30 left/s);
  assert.equal(await page.$$eval("#board span.mine", (x) => x.length), 30);
  assert.equal(await page.$$eval("#rank tr.mine", (x) => x.length), 1);
  step("my grid found, nothing out yet");

  // 3. the draw: the order is published; numbers come out on the clock (0.2 s each here)
  const order = [...Array(100).keys()]; // 0-based indices: position 1, 2, 3, ... in that order
  await (await bingo.setPhase(1, 2)).wait();
  await (await bingo.revealOrder(1, order)).wait();
  await page.waitForFunction(() => /Drawing/.test(document.getElementById("headline").textContent), null, { timeout: 40000 });
  await page.waitForFunction(() => document.querySelectorAll("#board span.out").length >= 8, null, { timeout: 20000 });
  const outNow = await page.$$eval("#board span.out", (x) => x.map((s) => s.textContent));
  assert.deepEqual(outNow.slice(0, 5), ["1", "2", "3", "4", "5"], "positions 1.. out first");
  assert.match(await page.getAttribute("#nft img", "src"), /\/ipfs\/bafy[^/]+\/\d+\.jpg$/);
  await page.waitForFunction(() => document.querySelectorAll("#mine .g span.hit").length >= 6, null, { timeout: 20000 });
  await shot("bingo-2-drawing");
  step("drawing: numbers out one by one, NFT shown, my grid lights up");

  // 4. the end: my grid is a bingo (1..30 were the first 30 out), it leads the board; replay available
  await page.waitForFunction(() => /Draw over/.test(document.getElementById("headline").textContent), null, { timeout: 40000 });
  assert.match(await text("mine"), /30\/30.*line done.*column done.*corners done.*2 lines done.*bingo done/s);
  const first = await page.$eval("#rank tbody tr", (tr) => tr.textContent);
  assert.match(first, /^1#1/);
  await page.waitForSelector("#replayBtn");
  await page.click("#replayBtn");
  await page.waitForFunction(() => document.querySelectorAll("#board span.out").length < 100 && document.querySelectorAll("#board span.out").length > 0, null, { timeout: 20000 });
  await page.click("#pauseBtn");
  const frozen = await page.$$eval("#board span.out", (x) => x.length);
  await page.waitForTimeout(600);
  assert.equal(await page.$$eval("#board span.out", (x) => x.length), frozen, "paused");
  await page.click("#skipBtn");
  await page.waitForFunction(() => document.querySelectorAll("#board span.out").length === 100);
  await shot("bingo-3-end");
  step("end of the draw: bingo, leaderboard, replay with pause and skip");

  // 5. French, and read-only follow of an address
  await page.click("#langBtn");
  assert.match(await text("headline"), /Manche n° 1 · Tirage terminé/);
  const ro = await browser.newPage({ viewport: { width: 390, height: 844 } });
  ro.on("pageerror", (e) => errors.push(e.message));
  await ro.goto(url + "?a=" + other.address);
  await ro.waitForFunction(() => document.querySelectorAll("#mine .card").length === 2, null, { timeout: 20000 });
  await ro.close();
  step("français, et suivi d'une adresse sans wallet");

  // 6. a new round opens: the countdown restarts from its opening on chain
  await (await bingo.createRound()).wait();
  await page.waitForFunction(() => /Manche n° 2 · Tirage dans environ (5[01]|49) min/.test(document.getElementById("headline").textContent), null, { timeout: 30000 });
  step("nouvelle manche : compte à rebours depuis l'ouverture");

  assert.deepEqual(errors, []);
  await browser.close(); server.close();
  console.log("Page bingo : parcours complet OK");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
