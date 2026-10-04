#!/usr/bin/env node
/**
 * Keeper for the p33 vaults -> BCM lottery.
 *
 *   node keeper/index.js run      one full cycle (harvest, purchase, claim) on each vault
 *   node keeper/index.js status   state of each vault, without sending anything
 *
 * Run it from cron once or twice a day. The keeper has no withdrawal rights:
 * it only triggers functions bounded by each vault's guards.
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
    slippageBps: 100n, // tolerance between the swap simulation and its execution
    minHarvest: ethers.parseEther("1"), // p33: below this, let it accumulate
    buyChunk: 20n, // tickets per transaction (50 max on the lottery side)
    buyCutoff: 300n, // seconds before the draw after which we stop buying
    lookbackTickets: 2000, // recent vault tickets to scan for winnings
    dryRun: false,
    log: console.log,
    ...cfg,
  };
}

/**
 * Yield to sell now: { amount, minOut }, or zeros if we have to wait.
 *
 * When the sale is refused because the price is too far below the vault's reference, a pass is
 * still sent, with nothing offered for sale ({ amount: 0, postponed: true }): it moves the
 * vault's reference one notch towards the market. Without that pass the reference would never
 * follow a lasting price move and the sale would stay blocked.
 */
async function planHarvest(ctx, vault) {
  const { cfg, now } = ctx;
  const none = { amount: 0n, minOut: 0n };
  const harvestable = await vault.harvestable();
  if (harvestable < cfg.minHarvest) return none;
  if (!inHarvestWindow(now)) return cfg.log(`  harvest: outside the window (yield still compounding until Saturday 00:00 UTC, or flip approaching)`), none;
  const [refTime, minAge] = await Promise.all([vault.refTime(), vault.MIN_REF_AGE()]);
  if (now - refTime < minAge) return cfg.log(`  harvest: the vault's reference price is too recent, next pass`), none;
  let quoted;
  try {
    quoted = await vault.harvest.staticCall(harvestable, 0n);
  } catch (e) {
    cfg.log(`  harvest: postponed, price too far below the vault's reference; this pass moves the reference (${e.shortMessage || e.message})`);
    return { amount: 0n, minOut: 0n, postponed: true };
  }
  cfg.log(`  harvest: ${fmt(harvestable)} p33 -> ~${fmt(quoted)} WAVAX`);
  return { amount: harvestable, minOut: (quoted * (10000n - cfg.slippageBps)) / 10000n };
}

/** Winning tickets of the vault to claim (computation shared with the web page, see lib.js). */
async function planClaims(ctx, addr) {
  const { cfg, lottery, now, state, trees } = ctx;
  const st = (state[addr.toLowerCase()] ||= { doneDraws: [] });
  return lib.planClaims({ lottery, owner: addr, now, done: new Set(st.doneDraws), trees, lookback: cfg.lookbackTickets, log: cfg.log });
}

/** Is the current draw still accepting purchases? */
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
 * One pass over a vault: everything goes into a single `cycle` transaction (collecting
 * winnings, selling the yield, buying tickets). Extra transactions only follow if there
 * are more than 50 prizes left to claim or more tickets to buy than one batch.
 */
async function runVault(ctx, addr) {
  const { cfg, signer, lottery, state } = ctx;
  const vault = new ethers.Contract(addr, VAULT_ABI, signer);
  cfg.log(`Vault ${addr}`);
  try {
    if ((await vault.keeper()).toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
      return cfg.log(`  skipped: this keeper is not the vault's keeper`);
    }
    const harvest = await planHarvest(ctx, vault);
    const { claims, resolved } = await planClaims(ctx, addr);
    const price = await lottery.ticketPrice();
    const open = (await drawIsOpen(ctx)) && price <= (await vault.maxTicketPrice());
    const budget = await vault.ticketBudget();
    const pending = await lottery.claimable(addr);
    const willBuy = open && (budget >= price || harvest.amount > 0n);
    if (!open && budget >= price) cfg.log(`  purchase: no open draw, or ticket price above the vault's cap`);

    if (harvest.amount === 0n && !harvest.postponed && !claims.length && pending === 0n && !willBuy) return cfg.log(`  nothing to do`);
    if (cfg.dryRun) return cfg.log(`  (dry run) cycle not sent`);

    // Gas: a step skipped in the simulation can become possible before the transaction is mined.
    const args = [harvest.amount, harvest.minOut, cfg.buyChunk, ...split(claims.slice(0, 50))];
    const gasLimit = ((await vault.cycle.estimateGas(...args)) * 3n) / 2n;
    await (await vault.cycle(...args, { gasLimit })).wait();
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
    cfg.log(`  cycle done — vault tickets: ${(await lottery.getOwnerTickets(addr)).length}, remaining budget ${fmt(await vault.ticketBudget())} WAVAX`);
  } catch (e) {
    cfg.log(`  error — ${e.shortMessage || e.message}`);
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
    `Vault ${addr}\n  owner ${owner}\n  principal ${fmt(principal)} xPHAR | sellable yield ${fmt(harvestable)} p33\n` +
      `  ticket budget ${fmt(budget)} WAVAX | winnings in the vault ${fmt(winnings)} WAVAX | to collect ${fmt(claimable)} WAVAX`
  );
}

/**
 * One pass over all the vaults. Used by the command line and by server.js.
 * @returns { keeper, gasAvax, lowGas, vaults }
 */
async function runAll(env, cmd = "run", log = console.log) {
  const { RPC_URL, KEEPER_PRIVATE_KEY, FACTORY, VAULTS, DRY_RUN } = env;
  if (!RPC_URL || !KEEPER_PRIVATE_KEY) throw new Error("RPC_URL and KEEPER_PRIVATE_KEY are required (.env)");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(KEEPER_PRIVATE_KEY, provider);
  const signer = new ethers.NonceManager(wallet);

  // Without gas the keeper cannot send anything: say so clearly rather than failing step by step.
  const minGas = ethers.parseEther(env.MIN_GAS_AVAX || "0.05");
  const gas = await provider.getBalance(wallet.address);
  const lowGas = gas < minGas;
  log(`Keeper ${wallet.address} — gas: ${fmt(gas)} AVAX${lowGas ? `  ⚠ BELOW THE ${fmt(minGas)} AVAX THRESHOLD: top up this wallet` : ""}`);

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
    throw new Error("Set FACTORY or VAULTS (.env)");
  }
  const result = { keeper: wallet.address, gasAvax: fmt(gas), lowGas, vaults: vaults.length };
  if (!vaults.length) {
    log("No vault created yet.");
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

module.exports = { runAll, runVault, makeContext, planHarvest, loadDrawTree, status, VAULT_ABI, LOTTERY_ABI };
