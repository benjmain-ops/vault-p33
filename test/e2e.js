// Test de bout en bout de la page web : vrai navigateur, chaîne locale, wallet simulé.
// Usage : node scripts/build.js && node test/e2e.js   (Chromium requis)
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { chromium } = require("playwright-core");
const { deploy, E, art } = require("./helpers");

const WEB = path.join(__dirname, "..", "docs");
const SHOTS = process.env.SHOTS_DIR;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

(async () => {
  const gp = ganache.provider({ logging: { quiet: true }, chain: { chainId: 43114, hardfork: "shanghai" }, wallet: { totalAccounts: 4, defaultBalance: 1000 } });
  const provider = new ethers.BrowserProvider(gp, undefined, { cacheTimeout: -1 });
  const [deployer, user, keeper, stranger] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));

  const wavax = await deploy("MockERC20", deployer, "Wrapped AVAX", "WAVAX");
  const p33 = await deploy("MockP33", deployer);
  const pool = await deploy("MockDlmmPool", deployer, p33.target, wavax.target);
  const lottery = await deploy("MockLottery", deployer, wavax.target, E("0.19"));
  await (await wavax.mint(pool.target, E("1000"))).wait();
  await (await pool.sync()).wait();
  await (await wavax.mint(lottery.target, E("100"))).wait();
  // comme sur Avalanche : le contrat de déploiement déterministe existe, et un pool p33/WAVAX aussi
  await provider.send("evm_setAccountCode", ["0x4e59b44847b379578588920cA78FbF26c0B4956C", "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"]);
  await (await p33.mint(user.address, E("2500"))).wait();
  const CONFIG = "window.VAULT_CONFIG = " + JSON.stringify({
    factory: "", chainId: 43114, chainName: "Avalanche C-Chain", rpcUrl: "/rpc", explorer: "https://snowscan.xyz", walletConnectProjectId: "",
    addresses: { p33: p33.target, wavax: wavax.target, lottery: lottery.target, pool: pool.target },
  }) + ";";

  // page + passerelle RPC sur la même origine
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/rpc") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const { id, method, params } = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        try {
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: await gp.request({ method, params }) }, (k, v) => (typeof v === "bigint" ? "0x" + v.toString(16) : v)));
        } catch (e) {
          // comme un vrai nœud : les données de revert sont une chaîne hexadécimale dans error.data
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: e.code || -32000, message: e.message, data: e.data && e.data.result ? e.data.result : undefined } }));
        }
      });
      return;
    }
    if (req.url.split("?")[0] === "/config.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(CONFIG);
    const file = path.join(WEB, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
    if (!file.startsWith(WEB) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR" });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
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
  await page.addInitScript(INIT, user.address.toLowerCase());

  const url = `${base}/`;
  const statusIs = (text) => page.waitForFunction((t) => document.getElementById("status").textContent.includes(t), text, { timeout: 60000 });
  const text = (id) => page.textContent("#" + id);
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: true });
  const connect = async () => {
    await page.goto(url);
    await page.click("#walletList button");
    await statusIs("Connecté");
  };
  const step = (m) => console.log("✔ " + m);

  // navigateur sans wallet : la page propose le renvoi vers Trust Wallet, avec sa propre adresse
  const bare = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await bare.goto(url + "?factory=0x0000000000000000000000000000000000000001");
  assert.equal(await bare.textContent("#openInTrust"), "Ouvrir dans Trust Wallet");
  let forwarded = null;
  await bare.route("https://link.trustwallet.com/**", (route) => { forwarded = route.request().url(); route.abort(); });
  await bare.click("#openInTrust").catch(() => {});
  await bare.waitForTimeout(500);
  assert.equal(forwarded, "https://link.trustwallet.com/open_url?coin_id=10009000&url=" + encodeURIComponent(url + "?factory=0x0000000000000000000000000000000000000001"));
  await bare.close();
  step("sans wallet : renvoi vers Trust Wallet");

  // 0. première installation : la page déploie la factory depuis le wallet
  await page.goto(url);
  await shot("1-connexion");
  await page.click("#walletList button");
  await page.waitForSelector("#setupCard:not([hidden])");
  await page.waitForFunction(() => document.getElementById("iPoolHint").textContent.includes("Pool vérifié"));
  assert.match(await page.textContent("#iPoolHint"), /bin step 25/);
  await shot("1b-installation");
  assert.equal(await page.inputValue("#iPool"), pool.target, "pool pré-rempli et vérifié");

  // essai à blanc : tout le parcours simulé par un appel en lecture, sans transaction
  const blockBefore = await provider.getBlockNumber();
  await page.click("#dryBtn");
  await statusIs("Simulation terminée"); // aucun tirage ouvert : l'achat échoue, le reste passe
  assert.match(await page.textContent("#dryOut"), /Vente sur le pool24,9999 p33 → 0,424999 WAVAX/);
  assert.match(await page.textContent("#dryOut"), /Achat de ticketséchec.*Causeaucun tirage ouvert/);
  assert.match(await page.textContent("#dryOut"), /Retrait total2\s250 p33 récupérés/);
  await (await lottery.createDraw(BigInt((await provider.getBlock("latest")).timestamp) + 86400n)).wait();
  const blockMid = await provider.getBlockNumber();
  await page.click("#dryBtn");
  await statusIs("Simulation réussie");
  const dry = await page.textContent("#dryOut");
  assert.match(dry, /Cours obtenu0,016999 WAVAX par p33/);
  assert.match(dry, /Achat de tickets2 ticket\(s\) à 0,19 WAVAX/);
  assert.equal(await provider.getBlockNumber(), blockMid, "la simulation n'envoie aucune transaction");
  assert.equal(await p33.balanceOf(user.address), E("2500"), "solde intact");
  assert.equal(await page.inputValue("#cFloor"), "0.012749", "prix plancher pré-rempli à partir du cours simulé");
  await shot("1c-simulation");
  step("essai à blanc contre la chaîne, sans transaction");
  await page.click("#installBtn");
  await page.waitForSelector("#createCard:not([hidden])", { timeout: 60000 });
  const factoryAddr = await page.evaluate(() => localStorage.getItem("p33vault.factory"));
  const factory = new ethers.Contract(factoryAddr, art("P33LotteryVaultFactory").abi, provider);
  assert.equal(await factory.p33(), p33.target);
  assert.equal(await factory.lottery(), lottery.target);
  assert.equal(await factory.pool(), pool.target);
  assert.equal(await factory.defaultKeeper(), ethers.ZeroAddress);
  const initcode = (await new ethers.ContractFactory(art("P33LotteryVaultFactory").abi, art("P33LotteryVaultFactory").bytecode).getDeployTransaction(p33.target, wavax.target, lottery.target, pool.target, ethers.ZeroAddress)).data;
  assert.equal(factoryAddr, ethers.getCreate2Address("0x4e59b44847b379578588920cA78FbF26c0B4956C", ethers.id("p33-lottery-vault/v1"), ethers.keccak256(initcode)), "adresse déterministe");
  step("factory déployée depuis la page par un appel classique, sans robot");

  // 1. pas encore de vault -> formulaire de création pré-rempli
  assert.equal(await page.inputValue("#cMaxPrice"), "0.38");
  await shot("2-creation");
  step("formulaire de création");

  // 2. création : le vault appartient au wallet connecté
  await page.fill("#cFloor", "0,015");
  await page.click("#createBtn");
  await page.waitForSelector("#dash:not([hidden])", { timeout: 60000 });
  const vaultAddr = (await factory.vaultsOf(user.address))[0];
  assert.equal(await text("vAddr"), vaultAddr);
  const vault = new ethers.Contract(vaultAddr, art("P33LotteryVault").abi, provider);
  assert.equal(await vault.owner(), user.address);
  assert.equal(await vault.minWavaxPerP33(), E("0.015"));
  step("vault créé au nom de l'utilisateur");

  // 3. dépôt (approve + deposit)
  await page.fill("#amtP33", "1000");
  await page.click("#depositBtn");
  await statusIs("Dépôt : fait.");
  assert.equal(await vault.principalAssets(), E("1000"));
  assert.match(await text("vP33"), /^1\s000$/);
  assert.match(await text("wP33"), /^1\s500$/);
  step("dépôt de 1000 p33");

  // 4. le ratio monte de 2 % : vente du rendement depuis la page, puis achat d'un ticket
  await (await p33.setRatio(E("1.02"))).wait();
  await (await lottery.createDraw(BigInt((await provider.getBlock("latest")).timestamp) + 86400n)).wait();
  await connect();
  assert.equal(await text("vHarvestable"), "19,6078");
  await page.click("#cycleBtn");
  await statusIs("Cycle : fait.");
  assert.equal(await text("vHarvestable"), "0");
  assert.equal(await text("vBudget"), "0,1433"); // 0,3333 vendus - 0,19 pour un ticket
  assert.equal(await text("vTickets"), "1");
  assert.equal((await lottery.getOwnerTickets(vaultAddr)).length, 1);
  await shot("3-tableau-de-bord");
  step("cycle en une transaction : vente du rendement et achat d'un ticket");

  // 5. plus rien à faire : message clair, aucune transaction envoyée
  await page.click("#cycleBtn");
  await statusIs("Rien à faire pour l'instant");
  step("message clair quand il n'y a rien à faire");

  // 5 bis. un autre wallet ouvre ce vault : lecture seule, retrait refusé par le contrat
  const other = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR" });
  await other.addInitScript(INIT, stranger.address.toLowerCase());
  assert.equal(await page.inputValue("#shareLink"), `${base}/?factory=${factoryAddr}`);
  await other.goto(`${base}/?vault=${vaultAddr}`); // sans ?factory= : la page retrouve la factory par son adresse déterministe
  await other.click("#walletList button");
  await other.waitForSelector("#notOwner:not([hidden])");
  await other.click("#withdrawAllBtn");
  await other.waitForFunction(() => document.getElementById("status").textContent.includes("Seul le propriétaire du vault peut faire ça."), null, { timeout: 60000 });
  assert.equal(await p33.balanceOf(vaultAddr) > 0n, true);
  await other.close();
  step("un autre wallet ne peut rien retirer");

  // 5 ter. le ticket du vault gagne : la page trouve le gain, le prouve et l'encaisse dans le cycle
  const [tid] = await lottery.getOwnerTickets(vaultAddr);
  const tk = await lottery.getTicket(tid);
  const main6 = tk.mainNumbers.slice(0, 6).map(Number);
  const seventh = [...Array(24).keys()].map((i) => i + 1).find((n) => !main6.includes(n));
  const pools = Array(12).fill(0n);
  pools[0] = E("2");
  await (await lottery.setResult(tk.drawId, [...main6, seventh], tk.compNumbers.slice(0, 2).map(Number), pools)).wait();
  const tree = require("../keeper/lib").buildTree([{ id: tid, owner: vaultAddr, rank: 1, amount: E("2") }]);
  await (await lottery.setMerkleRoot(tk.drawId, tree.root)).wait();
  await provider.send("evm_increaseTime", [16 * 60]);
  await provider.send("evm_mine", []);
  await page.click("#cycleBtn");
  await statusIs("Cycle : fait.");
  assert.equal(await text("vWinnings"), "1,94"); // 2 WAVAX moins 3 % de frais
  assert.equal(await lottery.ticketPrizeClaimed(tid), true);
  assert.equal(await page.isHidden("#claimNote"), true);
  await page.click("#withdrawWavaxBtn");
  await statusIs("Retrait des gains : fait.");
  assert.equal(await wavax.balanceOf(user.address), E("1.94"));
  step("gain trouvé, prouvé, encaissé et retiré depuis la page");

  // 6. réglages : garde-fous et rejouer les gains
  await page.click("summary");
  await page.fill("#sFloor", "0.012");
  await page.click("#guardsBtn");
  await statusIs("Garde-fous : fait.");
  assert.equal(await vault.minWavaxPerP33(), E("0.012"));
  await page.check("#sReinvest");
  await statusIs("Réglage des gains : fait.");
  assert.equal(await vault.reinvestWinnings(), true);
  step("réglages");

  // 7. retrait total : le p33 revient au wallet, principal intact malgré la vente du rendement
  await page.click("#withdrawAllBtn");
  await statusIs("Retrait total : fait.");
  const back = await p33.balanceOf(user.address);
  assert.equal(await p33.balanceOf(vaultAddr), 0n);
  assert.ok((await p33.convertToAssets(back - E("1500"))) >= E("1000"), "le principal retiré vaut au moins 1000 xPHAR");
  step("retrait total");

  assert.deepEqual(pageErrors, []);
  await browser.close();
  server.close();
  console.log("Page web : parcours complet OK");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
