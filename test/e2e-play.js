// End-to-end test of the play page: real browser, local chain, simulated wallet.
// Usage: node scripts/build.js && node test/e2e-play.js   (Chromium required; SHOTS_DIR to keep screenshots)
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { chromium } = require("playwright-core");
const { deploy, E } = require("./helpers");
const lib = require("../keeper/lib");

const WEB = path.join(__dirname, "..", "docs");
const SHOTS = process.env.SHOTS_DIR;
const VIDEO = process.env.VIDEO_DIR; // records the phone-sized run, with pauses that make it watchable
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

(async () => {
  const gp = ganache.provider({ logging: { quiet: true }, chain: { chainId: 43114, hardfork: "shanghai" }, wallet: { totalAccounts: 3, defaultBalance: 1000 } });
  const provider = new ethers.BrowserProvider(gp, undefined, { cacheTimeout: -1 });
  const [deployer, user, other] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const now = async () => BigInt((await provider.getBlock("latest")).timestamp);
  const warp = async (s) => { await provider.send("evm_increaseTime", [Number(s)]); await provider.send("evm_mine", []); };

  const wavax = await deploy("MockWAVAX", deployer);
  const lottery = await deploy("MockLottery", deployer, wavax.target, E("0.1821"));
  await (await wavax.mint(lottery.target, E("500"))).wait();
  await (await wavax.mint(other.address, E("50"))).wait();
  await (await wavax.connect(other).approve(lottery.target, E("50"))).wait();
  await (await wavax.mint("0x000000000000000000000000000000000000FA11", E("12.5"))).wait(); // jackpot reserve
  await (await lottery.setRankRollover(1, E("2"))).wait();

  // a finished draw with somebody else's tickets
  await (await lottery.createDraw((await now()) + 3600n)).wait();
  await (await lottery.connect(other).buyMultipleTickets(1, [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]], [[1, 2], [3, 4]], [false, false])).wait();
  await warp(3700);
  await (await lottery.setResult(1, [9, 4, 7, 18, 15, 23, 16], [1, 3], Array(12).fill(0n))).wait();
  await (await lottery.setMerkleRoot(1, "0x" + "0".repeat(63) + "1")).wait();
  // the open draw
  await (await lottery.createDraw((await now()) + 7n * 3600n + 1234n)).wait();
  await (await lottery.connect(other).buyMultipleTickets(2, [[2, 4, 6, 8, 10, 12]], [[2, 5]], [false])).wait();

  const CONFIG = "window.VAULT_CONFIG = " + JSON.stringify({
    factory: "", chainId: 43114, chainName: "Avalanche C-Chain", rpcUrl: "/rpc", explorer: "https://snowscan.xyz", walletConnectProjectId: "",
    addresses: { p33: ethers.ZeroAddress, wavax: wavax.target, lottery: lottery.target, pool: ethers.ZeroAddress },
  }) + ";";
  const one = async ({ id, method, params }) => {
    try {
      return { jsonrpc: "2.0", id, result: await gp.request({ method, params }) };
    } catch (e) {
      return { jsonrpc: "2.0", id, error: { code: e.code || -32000, message: e.message, data: e.data && e.data.result ? e.data.result : undefined } };
    }
  };
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
    const file = path.join(WEB, url.endsWith("/") ? url + "index.html" : url);
    if (!file.startsWith(WEB) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/play/`;

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const INIT = (acct) => {
    window.ethereum = {
      on() {},
      async request({ method, params }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [acct];
        if (method === "wallet_switchEthereumChain") return null;
        const r = await fetch("/rpc", { method: "POST", body: JSON.stringify({ id: 1, method, params: params || [] }) });
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
        return j.result;
      },
    };
  };
  // the page is in English unless French was chosen: most of this walk is written against the French texts
  const FRENCH = () => { try { localStorage.setItem("sixte.lang", "fr"); } catch (_) {} };
  const errors = [];
  const open = async (opts) => {
    const page = await browser.newPage(opts);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(INIT, user.address.toLowerCase());
    await page.addInitScript(FRENCH);
    return page;
  };
  const page = await open({ viewport: { width: 390, height: 844 }, locale: "fr-FR", deviceScaleFactor: 2, ...(VIDEO ? { recordVideo: { dir: VIDEO, size: { width: 390, height: 844 } } } : {}) });
  const pause = (ms) => (VIDEO ? page.waitForTimeout(ms) : null);
  const shot = async (p, name, full = true) => SHOTS && !VIDEO && p.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: full });
  const text = (id) => page.textContent("#" + id);
  const toastIs = (t) => page.waitForFunction((x) => document.getElementById("toast").textContent.includes(x), t, { timeout: 60000 });
  const step = (m) => console.log("✔ " + m);
  const connect = async (p = page) => { await p.click("#connectBtn"); await p.click("#walletList button"); await p.waitForFunction(() => document.getElementById("connectBtn").textContent.includes("…")); };

  // 1. without a wallet: the draw, the pool and the results are already there
  await page.goto(url);
  await page.waitForFunction(() => /dans \d+ h \d\d min \d\d s/.test(document.getElementById("headline").textContent));
  assert.match(await text("headline"), /^Tirage du (matin|soir) dans \d+ h \d\d min \d\d s$/);
  assert.match(await text("leadSub"), /Tirage n° 2\. 1 ticket joué, \d+,\d+ WAVAX à gagner/);
  await page.waitForFunction(() => document.getElementById("facts").textContent.includes("12,5"));
  await page.waitForSelector("#lastBalls .ball");
  assert.equal(await text("lastBalls"), "94718152316+13", "the last draw, as balls under the headline");
  await pause(2200);
  assert.match(await text("facts"), /À gagner, reports compris2,14 WAVAX.*Dont ventes de ce tirage0,1456 WAVAX.*Tickets joués1.*Prix du ticket0,1821 WAVAX.*Réserve du jackpot12,5 WAVAX/);
  const rows = await page.$$eval("#ranks tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[0], ["6 + 2", "2,052 WAVAX", "1 sur 192 280"], "rank 1: 36% of the pool plus the rollover, odds of 6+2");
  assert.deepEqual(rows[11].slice(0, 1), ["3 + 0"]);
  await page.click("#tabResults");
  assert.match(await text("results"), /Tirage n° 1.*Numéros sortis94718152316\+13.*2 tickets, 0,29 WAVAX en jeu/s);
  await page.click("#tabMine");
  assert.match(await text("mine"), /Connecte ton wallet/);
  step("sans wallet : tirage, cagnotte, rangs et résultats visibles");

  // 2. marking a line: 6 numbers and 2 extras, no more
  for (const n of [3, 9, 14, 17, 21, 24]) { await page.click(`#mainGrid .box:nth-child(${n})`); await pause(260); }
  assert.equal(await text("mainCount"), "6 sur 6");
  assert.equal(await page.isDisabled("#mainGrid .box:nth-child(1)"), true, "a 7th number cannot be marked");
  await page.click("#mainGrid .box:nth-child(24)"); // unmark, then mark another
  await page.click("#mainGrid .box:nth-child(1)");
  for (const n of [2, 5]) { await page.click(`#compGrid .box:nth-child(${n})`); await pause(260); }
  await pause(900);
  assert.equal(await text("stubLines"), "1 grille complète");
  assert.equal(await text("stubTotal"), "0,1821 WAVAX");
  assert.equal(await text("buyBtn"), "Connecter un wallet");
  await shot(page, "play-1-grille");
  step("grille cochée : 6 numéros, 2 compléments, total affiché");

  // 3. connect and buy: the missing WAVAX is wrapped from AVAX, exact approval, purchase
  await page.click("#buyBtn");
  await page.click("#walletList button");
  await page.waitForFunction(() => document.getElementById("buyBtn").textContent === "Acheter 1 ticket" && !document.getElementById("buyBtn").disabled);
  assert.match(await text("stubNote"), /Il te manque 0,1821 WAVAX : ils seront convertis depuis tes AVAX/);
  await page.click("#buyBtn");
  await toastIs("1 ticket acheté");
  await pause(2500);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await pause(900);
  let mine = await lottery.getOwnerTickets(user.address);
  assert.equal(mine.length, 1);
  const t1 = await lottery.getTicket(mine[0]);
  assert.deepEqual(t1.mainNumbers.slice(0, 6).map(Number), [1, 3, 9, 14, 17, 21]);
  assert.deepEqual(t1.compNumbers.slice(0, 2).map(Number), [2, 5]);
  assert.equal(await wavax.allowance(user.address, lottery.target), 0n, "exact approval, nothing left");
  assert.equal(await wavax.balanceOf(user.address), 0n, "only the missing amount was wrapped");
  await page.waitForFunction(() => document.getElementById("mine").textContent.includes("en jeu"));
  step("achat : conversion AVAX → WAVAX, autorisation exacte, ticket au nom du wallet");

  // 4. five quick-pick lines in one transaction
  await page.click("#flash5Btn");
  assert.equal(await text("stubLines"), "5 grilles complètes");
  await pause(1800);
  await page.click("#buyBtn");
  await toastIs("5 tickets achetés");
  await pause(2500);
  mine = await lottery.getOwnerTickets(user.address);
  assert.equal(mine.length, 6);
  await page.waitForFunction(() => document.querySelectorAll("#mine .ticket").length === 6);
  assert.match(await text("facts"), /Tickets joués7.*Tes tickets pour ce tirage6/);
  await shot(page, "play-2-tickets");
  step("5 grilles flash achetées en une transaction");

  // 5. the draw: the first ticket wins rank 1; the official root is built with the same library
  const seventh = [...Array(24).keys()].map((i) => i + 1).find((n) => ![1, 3, 9, 14, 17, 21].includes(n));
  const pools = [E("3"), ...Array(11).fill(E("0.05"))];
  await warp(8 * 3600);
  const winMain = [1, 3, 9, 14, 17, 21, seventh], winComp = [2, 5];
  await (await lottery.setResult(2, winMain, winComp, pools)).wait();
  const all = await Promise.all((await lottery.getDrawTickets(2)).map((id) => lottery.getTicket(id)));
  const winners = lib.computeWinners({ winningMain: winMain, winningComp: winComp, rankPools: pools, isRun2: false },
    all.map((x) => ({ id: x.id, owner: x.owner, mainNumbers: x.mainNumbers.map(Number), compNumbers: x.compNumbers.map(Number), isSystemPlay: x.isSystemPlay, systemMainCount: x.systemMainCount, systemCompCount: x.systemCompCount })));
  await (await lottery.setMerkleRoot(2, lib.buildTree(winners).root)).wait();
  await warp(16 * 60);
  await (await lottery.createDraw((await now()) + 12n * 3600n)).wait();
  const myWins = winners.filter((w) => w.owner === user.address);
  const gross = myWins.reduce((a, w) => a + w.amount, 0n);

  await page.goto(url);
  await connect();
  await page.waitForSelector("#claimBtn", { timeout: 60000 });
  await pause(600);
  if (VIDEO) await page.evaluate(() => document.getElementById("claimBtn").scrollIntoView({ behavior: "smooth", block: "center" }));
  await pause(2500);
  assert.match(await text("mine"), new RegExp(`${myWins.length} ticket${myWins.length > 1 ? "s" : ""} gagnant`));
  assert.match(await text("mine"), /gagné, rang 1 : 3 WAVAX/);
  assert.ok((await page.$$("#mine .chip.hit")).length >= 8, "matched numbers are highlighted");
  await shot(page, "play-3-gain");
  await page.click("#claimBtn");
  await toastIs("Gains réclamés");
  await page.waitForSelector("#cashBtn", { timeout: 60000 });
  await page.click("#cashBtn");
  await toastIs("WAVAX encaissés");
  await pause(2200);
  await page.click("#tabResults");
  assert.ok(await page.$("#results .balls.roll"), "the latest draw rolls in when the results open");
  await pause(2500);
  await page.click("#tabMine");
  assert.equal(await wavax.balanceOf(user.address), (gross * 97n) / 100n, "97% after the lottery's fee");
  await page.waitForFunction(() => !document.getElementById("cashBtn") && !document.getElementById("claimBtn"));
  assert.match(await text("mine"), /gagné, rang 1 : 3 WAVAX, réclamé/);
  step("gain trouvé, numéros surlignés, réclamé puis encaissé");

  // 6. English, and a wide screen
  await page.click("#langBtn");
  assert.match(await text("headline"), /^(Morning|Evening) draw in \d+ h/);
  assert.equal(await text("tabMine"), "My tickets");
  const wide = await open({ viewport: { width: 1280, height: 900 }, locale: "fr-FR" });
  await wide.goto(url);
  await wide.waitForFunction(() => /dans/.test(document.getElementById("headline").textContent));
  await connect(wide);
  await wide.click("#flashBtn");
  await wide.waitForFunction(() => document.querySelectorAll("#mine .ticket").length === 6);
  await shot(wide, "play-4-large");
  const over = await wide.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(over, false, "no horizontal scroll");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "no horizontal scroll on a phone");
  step("anglais, et mise en page large");

  // 7. no wallet in the browser: the dialog offers to reopen the page in Trust Wallet
  // a first visit, in a French-speaking browser: English all the same, and the three steps
  const first = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR" });
  first.on("pageerror", (e) => errors.push(e.message));
  await first.goto(url);
  await first.waitForFunction(() => /^(Morning|Evening) draw in/.test(document.getElementById("headline").textContent));
  assert.equal(await first.getAttribute("html", "lang"), "en");
  assert.match(await first.textContent("#start"), /New here\? Three steps.*A wallet.*Trust Wallet is free.*Some AVAX.*Your line.*only what you can afford to lose/s);
  assert.equal(await first.getAttribute("#startTrust", "href"), "https://trustwallet.com/download");
  assert.equal(await first.$$eval("#startSteps li.now", (x) => x.length), 1);
  await shot(first, "play-5-first-visit", false);
  let sent = null;
  await first.route("https://link.trustwallet.com/**", (route) => { sent = route.request().url(); route.abort(); });
  await first.click("#startOpenTrust").catch(() => {});
  await first.waitForTimeout(400);
  assert.match(sent, /^https:\/\/link\.trustwallet\.com\/open_url\?coin_id=10009000&url=/);
  await first.goto(url);
  await first.waitForSelector("#startHide");
  await first.click("#startHide");
  assert.equal(await first.isHidden("#start"), true);
  await first.reload();
  await first.waitForFunction(() => /draw in/.test(document.getElementById("headline").textContent));
  assert.equal(await first.isHidden("#start"), true, "stays hidden once dismissed");
  await first.close();
  // a wallet that cannot pay a ticket: step 2, with its address to copy and the link to buy AVAX
  // inside a wallet's phone browser a link cannot open a second window: it opens in place
  const inApp = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 Trust/Android" });
  await inApp.addInitScript(INIT, "0x00000000000000000000000000000000000000ab");
  await inApp.goto(url);
  await inApp.waitForSelector("#startConnect");
  await inApp.click("#startConnect"); await inApp.click("#walletList button");
  await inApp.waitForSelector("#startBuy");
  assert.equal(await inApp.getAttribute("#startBuy", "target"), null);
  await inApp.close();
  const poor = await browser.newPage({ viewport: { width: 390, height: 844 } });
  poor.on("pageerror", (e) => errors.push(e.message));
  await poor.addInitScript(INIT, "0x00000000000000000000000000000000000000aa");
  await poor.goto(url);
  await poor.waitForFunction(() => /draw in/.test(document.getElementById("headline").textContent));
  assert.ok(await poor.isVisible("#startConnect"), "a wallet is there: step 1 offers to connect it");
  await poor.click("#startConnect"); await poor.click("#walletList button");
  await poor.waitForSelector("#startBuy");
  assert.equal(await poor.getAttribute("#startBuy", "href"), "https://link.trustwallet.com/buy?asset=c10009000&fiat_currency=EUR&fiat_quantity=20");
  assert.equal(await poor.getAttribute("#startBuy", "target"), "_blank", "a new tab where the browser has tabs");
  assert.match(await poor.textContent("#startSteps li.now"), /Some AVAX.*A ticket costs 0\.1821 WAVAX.*about 0\.2 AVAX is enough.*Buy €20 of AVAX in Trust Wallet.*Avalanche C-Chain/s);
  assert.equal(await poor.$$eval("#startSteps li.done", (x) => x.length), 1);
  await shot(poor, "play-6-needs-avax", false);
  await poor.close();
  step("première visite : anglais par défaut, trois étapes, Trust Wallet pour le wallet et pour l'achat");

  const bare = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR" });
  await bare.addInitScript(FRENCH);
  await bare.goto(url);
  assert.equal(await bare.isHidden("#install"), true, "no install banner until the browser offers it");
  await bare.evaluate(() => { const e = new Event("beforeinstallprompt"); e.prompt = () => (window.prompted = true); e.userChoice = Promise.resolve({ outcome: "accepted" }); window.dispatchEvent(e); });
  assert.match(await bare.textContent("#install"), /Installe Sixte sur ton écran d'accueil.*Installer.*Plus tard/s);
  await bare.click("#installBtn");
  assert.equal(await bare.evaluate(() => window.prompted), true);
  assert.equal(await bare.isHidden("#install"), true);
  await bare.click("#flashBtn");
  const line = await bare.evaluate(() => [...document.querySelectorAll("#mainGrid .box[aria-pressed=true] span")].map((x) => x.textContent).join(".") + "-" + [...document.querySelectorAll("#compGrid .box[aria-pressed=true] span")].map((x) => x.textContent).join("."));
  await bare.click("#connectBtn");
  assert.ok(await bare.isVisible("#openInTrust"));
  assert.ok(await bare.isVisible("#openInMetaMask"));
  let forwarded = null;
  await bare.route("https://link.trustwallet.com/**", (route) => { forwarded = route.request().url(); route.abort(); });
  await bare.click("#openInTrust").catch(() => {});
  await bare.waitForTimeout(500);
  assert.equal(forwarded, "https://link.trustwallet.com/open_url?coin_id=10009000&url=" + encodeURIComponent(url + "?g=" + line), "the line travels to the wallet's browser");
  // ... and arrives filled in
  await bare.goto(url + "?g=" + line + "_1.2.3.4.5.6-1.2_9.9.9.9.9.9-1.2_1.2.3.4.5.25-1.2");
  await bare.waitForFunction(() => document.getElementById("stubLines").textContent === "2 grilles complètes");
  assert.equal(await bare.$$eval("#lineTabs .line-tab.full", (x) => x.length), 2, "invalid lines are dropped");
  const manifest = JSON.parse(fs.readFileSync(path.join(WEB, "play", "manifest.webmanifest"), "utf8"));
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(WEB, "play", icon.src)), icon.src);
  assert.match(await bare.getAttribute('meta[property="og:image"]', "content"), /\/play\/og\.png$/);
  assert.ok(fs.existsSync(path.join(WEB, "play", "og.png")));
  await bare.close();
  step("sans wallet : installation, renvoi vers le wallet avec la grille, aperçu de lien");

  assert.deepEqual(errors, []);
  const video = VIDEO ? await page.video().path() : null;
  await browser.close();
  if (video) console.log("video: " + video);
  server.close();
  console.log("Page de jeu : parcours complet OK");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
