#!/usr/bin/env node
/**
 * Keeper des vaults p33 -> loterie BCM.
 *
 *   node keeper/index.js run      un cycle complet (harvest, achat, réclamation) sur chaque vault
 *   node keeper/index.js status   état de chaque vault, sans rien envoyer
 *
 * À lancer par cron une à deux fois par jour. Le keeper n'a aucun droit de retrait :
 * il ne fait que déclencher des fonctions bornées par les garde-fous de chaque vault.
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const lib = require("./lib");
const { inHarvestWindow, loadDrawTree } = lib;

const VAULT_ABI = require("../artifacts/P33LotteryVault.json").abi;
const FACTORY_ABI = require("../artifacts/P33LotteryVaultFactory.json").abi;
const LOTTERY_ABI = [
  "function ticketPrice() view returns (uint256)",
  "function currentDrawId() view returns (uint256)",
  "function paused() view returns (bool)",
  "function claimable(address) view returns (uint256)",
  "function rootPoseA(uint256) view returns (uint256)",
  "function ticketPrizeClaimed(uint256) view returns (bool)",
  "function getOwnerTickets(address) view returns (uint256[])",
  "function getDrawTickets(uint256) view returns (uint256[])",
  "function getDraw(uint256) view returns (tuple(uint256 id,uint256 scheduledTime,uint256 drawnAt,uint8[7] winningMain,uint8[2] winningComp,uint256 prizePool,uint256[12] rankPools,uint256 drawVolume,bool isRun2,bool finalized,bool hasRank1Winner,bytes32 merkleRoot))",
  "function getTicket(uint256) view returns (tuple(uint256 id,uint256 drawId,address owner,uint8[9] mainNumbers,uint8[3] compNumbers,bool isSystemPlay,uint8 systemMainCount,uint8 systemCompCount,uint8 rank,bool claimed,uint256 grossWinAmount))",
];


const fmt = (x) => ethers.formatEther(x);

function defaults(cfg = {}) {
  return {
    slippageBps: 100n, // tolérance entre simulation et exécution du swap
    minHarvest: ethers.parseEther("1"), // p33 : en dessous, on laisse s'accumuler
    buyChunk: 20n, // tickets par transaction (50 max côté loterie)
    buyCutoff: 300n, // secondes avant le tirage où l'on n'achète plus
    lookbackTickets: 2000, // tickets récents du vault à examiner pour les gains
    dryRun: false,
    log: console.log,
    ...cfg,
  };
}

/** Rendement à vendre maintenant : { amount, minOut }, ou des zéros s'il faut attendre. */
async function planHarvest(ctx, vault) {
  const { cfg, now } = ctx;
  const none = { amount: 0n, minOut: 0n };
  const harvestable = await vault.harvestable();
  if (harvestable < cfg.minHarvest) return none;
  if (!inHarvestWindow(now)) return cfg.log(`  vente: hors fenêtre (rachat TWAP en cours ou flip proche)`), none;
  if ((await vault.minWavaxPerP33()) === 0n) return cfg.log(`  vente: prix plancher non réglé par le propriétaire`), none;
  let quoted;
  try {
    quoted = await vault.harvest.staticCall(harvestable, 0n);
  } catch (e) {
    return cfg.log(`  vente: refusée en simulation, cours sous le plancher ? (${e.shortMessage || e.message})`), none;
  }
  cfg.log(`  vente: ${fmt(harvestable)} p33 -> ~${fmt(quoted)} WAVAX`);
  return { amount: harvestable, minOut: (quoted * (10000n - cfg.slippageBps)) / 10000n };
}

/** Tickets gagnants du vault à réclamer (calcul partagé avec la page web, voir lib.js). */
async function planClaims(ctx, addr) {
  const { cfg, lottery, now, state, trees } = ctx;
  const st = (state[addr.toLowerCase()] ||= { doneDraws: [] });
  return lib.planClaims({ lottery, owner: addr, now, done: new Set(st.doneDraws), trees, lookback: cfg.lookbackTickets, log: cfg.log });
}

/** Le tirage en cours accepte-t-il encore des achats ? */
async function drawIsOpen(ctx) {
  const { cfg, lottery, now } = ctx;
  if (await lottery.paused()) return false;
  const drawId = await lottery.currentDrawId();
  if (drawId === 0n) return false;
  const draw = await lottery.getDraw(drawId);
  return draw.drawnAt === 0n && now + cfg.buyCutoff < draw.scheduledTime;
}

const split = (c) => [c.map((p) => p.id), c.map((p) => p.rank), c.map((p) => p.amount), c.map((p) => p.proof)];

/**
 * Un passage sur un vault : tout part dans une seule transaction `cycle` (encaissement,
 * vente du rendement, achat de tickets). Des transactions supplémentaires ne suivent que
 * s'il reste plus de 50 gains à réclamer ou plus de tickets à acheter qu'un lot.
 */
async function runVault(ctx, addr) {
  const { cfg, signer, lottery, state } = ctx;
  const vault = new ethers.Contract(addr, VAULT_ABI, signer);
  cfg.log(`Vault ${addr}`);
  try {
    if ((await vault.keeper()).toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
      return cfg.log(`  ignoré: ce robot n'est pas celui du vault`);
    }
    const harvest = await planHarvest(ctx, vault);
    const { claims, resolved } = await planClaims(ctx, addr);
    const price = await lottery.ticketPrice();
    const open = (await drawIsOpen(ctx)) && price <= (await vault.maxTicketPrice());
    const budget = await vault.ticketBudget();
    const pending = await lottery.claimable(addr);
    const willBuy = open && (budget >= price || harvest.amount > 0n);
    if (!open && budget >= price) cfg.log(`  achat: pas de tirage ouvert, ou ticket au-dessus du plafond du vault`);

    if (harvest.amount === 0n && !claims.length && pending === 0n && !willBuy) return cfg.log(`  rien à faire`);
    if (cfg.dryRun) return cfg.log(`  (simulation) cycle non envoyé`);

    await (await vault.cycle(harvest.amount, harvest.minOut, cfg.buyChunk, ...split(claims.slice(0, 50)))).wait();
    for (let i = 50; i < claims.length; i += 50) {
      await (await vault.claimPrizes(...split(claims.slice(i, i + 50)))).wait();
    }
    const st = state[addr.toLowerCase()];
    st.doneDraws = [...new Set([...st.doneDraws, ...resolved])];

    if (open) {
      for (let guard = 0; guard < 200 && (await vault.ticketBudget()) >= price; guard++) {
        await (await vault.buyTickets(cfg.buyChunk)).wait();
      }
    }
    cfg.log(`  cycle fait — tickets du vault : ${(await lottery.getOwnerTickets(addr)).length}, budget restant ${fmt(await vault.ticketBudget())} WAVAX`);
  } catch (e) {
    cfg.log(`  erreur — ${e.shortMessage || e.message}`);
  }
}

async function makeContext({ signer, lotteryAddress, cfg, state }) {
  const provider = signer.provider;
  const block = await provider.getBlock("latest");
  return {
    signer,
    cfg: defaults(cfg),
    lottery: new ethers.Contract(lotteryAddress, LOTTERY_ABI, provider),
    now: BigInt(block.timestamp),
    state: state || {},
    trees: new Map(),
  };
}

async function status(ctx, addr) {
  const v = new ethers.Contract(addr, VAULT_ABI, ctx.signer.provider);
  const [owner, principal, harvestable, budget, winnings, claimable] = await Promise.all([
    v.owner(), v.principalAssets(), v.harvestable(), v.ticketBudget(), v.winnings(), ctx.lottery.claimable(addr),
  ]);
  ctx.cfg.log(
    `Vault ${addr}\n  propriétaire ${owner}\n  principal ${fmt(principal)} xPHAR | rendement vendable ${fmt(harvestable)} p33\n` +
      `  budget tickets ${fmt(budget)} WAVAX | gains au vault ${fmt(winnings)} WAVAX | à encaisser ${fmt(claimable)} WAVAX`
  );
}

/**
 * Un passage sur tous les vaults. Utilisé par la ligne de commande et par server.js.
 * @returns { keeper, gasAvax, lowGas, vaults }
 */
async function runAll(env, cmd = "run", log = console.log) {
  const { RPC_URL, KEEPER_PRIVATE_KEY, FACTORY, VAULTS, DRY_RUN } = env;
  if (!RPC_URL || !KEEPER_PRIVATE_KEY) throw new Error("RPC_URL et KEEPER_PRIVATE_KEY sont requis (.env)");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(KEEPER_PRIVATE_KEY, provider);
  const signer = new ethers.NonceManager(wallet);

  // Sans gas, le robot ne peut rien envoyer : on le dit clairement plutôt que d'échouer étape par étape.
  const minGas = ethers.parseEther(env.MIN_GAS_AVAX || "0.05");
  const gas = await provider.getBalance(wallet.address);
  const lowGas = gas < minGas;
  log(`Robot ${wallet.address} — gas : ${fmt(gas)} AVAX${lowGas ? `  ⚠ SOUS LE SEUIL de ${fmt(minGas)} AVAX : recharger ce wallet` : ""}`);

  let vaults = (VAULTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  let lotteryAddress = env.LOTTERY;
  if (FACTORY) {
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
    lotteryAddress ||= await factory.lottery();
    if (!vaults.length) {
      const n = await factory.vaultCount();
      for (let i = 0n; i < n; i++) vaults.push(await factory.allVaults(i));
    }
  } else if (!vaults.length) {
    throw new Error("Renseigner FACTORY ou VAULTS (.env)");
  }
  const result = { keeper: wallet.address, gasAvax: fmt(gas), lowGas, vaults: vaults.length };
  if (!vaults.length) {
    log("Aucun vault créé pour l'instant.");
    return result;
  }
  if (!lotteryAddress) lotteryAddress = await new ethers.Contract(vaults[0], VAULT_ABI, provider).lottery();

  const statePath = env.STATE_FILE || path.join(__dirname, "state.json");
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
  const ctx = await makeContext({ signer, lotteryAddress, state, cfg: { dryRun: DRY_RUN === "1", log } });

  for (const addr of vaults) {
    if (cmd === "status") await status(ctx, addr);
    else await runVault(ctx, addr);
  }
  if (cmd !== "status" && DRY_RUN !== "1") {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  return result;
}

async function main() {
  require("dotenv").config();
  await runAll(process.env, process.argv[2] || "run");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { runAll, runVault, makeContext, loadDrawTree, status };
