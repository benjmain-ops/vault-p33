const ganache = require("ganache");
const { ethers } = require("ethers");

const E = ethers.parseEther;
const art = (n) => require(`../artifacts/${n}.json`);

async function deploy(name, signer, ...args) {
  const a = art(name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

/** Environnement complet : jetons, router, loterie, factory, un vault pour `owner`. */
async function setup({ reinvest = false } = {}) {
  const gp = ganache.provider({
    logging: { quiet: true },
    chain: { hardfork: "shanghai" },
    wallet: { totalAccounts: 5, defaultBalance: 1000 },
  });
  const provider = new ethers.BrowserProvider(gp, undefined, { cacheTimeout: -1 }); // pas de cache : deux appels identiques doivent être réévalués
  const [deployer, owner, keeper, player, stranger] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));

  const wavax = await deploy("MockERC20", deployer, "Wrapped AVAX", "WAVAX");
  const p33 = await deploy("MockP33", deployer);
  const router = await deploy("MockRouter", deployer);
  const lottery = await deploy("MockLottery", deployer, wavax.target, E("0.19"));
  const factory = await deploy("P33LotteryVaultFactory", deployer, p33.target, wavax.target, lottery.target, router.target, 200, keeper.address);

  await (await wavax.mint(router.target, E("1000"))).wait();
  await (await wavax.mint(lottery.target, E("1000"))).wait();
  await (await p33.mint(owner.address, E("10000"))).wait();
  await (await wavax.mint(player.address, E("100"))).wait();

  // plancher 0,015 WAVAX par p33, ticket plafonné à 0,5 WAVAX
  await (await factory.connect(owner).createVault(E("0.015"), E("0.5"), reinvest)).wait();
  const vaultAddr = (await factory.vaultsOf(owner.address))[0];
  const vault = new ethers.Contract(vaultAddr, art("P33LotteryVault").abi, owner);

  const now = async () => BigInt((await provider.getBlock("latest")).timestamp);
  const warp = async (seconds) => {
    await provider.send("evm_increaseTime", [Number(seconds)]);
    await provider.send("evm_mine", []);
  };
  const openDraw = async (inSeconds = 86400n) => {
    await (await lottery.createDraw((await now()) + BigInt(inSeconds))).wait();
    return lottery.currentDrawId();
  };
  const depositP33 = async (amount) => {
    await (await p33.connect(owner).approve(vault.target, amount)).wait();
    await (await vault.deposit(amount)).wait();
  };

  return { provider, deployer, owner, keeper, player, stranger, wavax, p33, router, lottery, factory, vault, now, warp, openDraw, depositP33 };
}

async function expectRevert(promise, match) {
  try {
    const tx = await promise;
    if (tx && tx.wait) await tx.wait();
  } catch (e) {
    const msg = JSON.stringify({ m: e.message, d: e.data, i: e.info, r: e.revert });
    if (match && !msg.includes(match)) throw new Error(`revert attendu "${match}", obtenu: ${msg.slice(0, 1500)}`);
    return;
  }
  throw new Error("la transaction aurait dû échouer" + (match ? ` (${match})` : ""));
}

/** Sélecteur d'une erreur custom, tel qu'il apparaît dans les données de revert. */
const sel = (sig) => ethers.id(sig).slice(2, 10);

module.exports = { setup, deploy, expectRevert, sel, E, art };
