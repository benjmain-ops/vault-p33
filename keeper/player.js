#!/usr/bin/env node
/**
 * Player bot: plays the BCM lottery from an ordinary wallet, funded by a p33 vault.
 *
 *   node keeper/player.js             one pass
 *   DRY_RUN=1 node keeper/player.js   prints what would be done, sends nothing
 *
 * It runs with the key of the "player" wallet set on the vault. One pass:
 *   1. asks the vault to sell its yield and pay the WAVAX out to the player wallet;
 *   2. claims and collects the prizes of the player's winning tickets;
 *   3. sends prize money above a small working balance to the vault, where only the vault's
 *      owner can withdraw it;
 *   4. keeps a little AVAX for gas, taken from the WAVAX received;
 *   5. buys the tickets of the current draw, in the player's own name.
 *
 * Every step is idempotent: running the bot several times before the same draw buys the
 * tickets once. Nothing is stored between runs.
 *
 * Every transaction goes to the vault given in the configuration, or to the lottery and
 * WAVAX contracts pinned below: nothing read from the RPC can redirect funds elsewhere.
 * The logs never contain an address or a transaction hash, so they can be public.
 * A private recap (with amounts) is written to RECAP_FILE when something happened; the
 * scheduled workflow sends it to a Telegram chat from a step that never sees the wallet key.
 */
const fs = require("fs");
const { ethers } = require("ethers");
const lib = require("./lib");

const VAULT_ABI = [
  "function owner() view returns (address)",
  "function keeper() view returns (address)",
  "function player() view returns (address)",
  "function lottery() view returns (address)",
  "function wavax() view returns (address)",
  "function harvestable() view returns (uint256)",
  "function ticketBudget() view returns (uint256)",
  "function maxTicketPrice() view returns (uint256)",
  "function refTime() view returns (uint40)",
  "function MIN_REF_AGE() view returns (uint256)",
  "function cycle(uint256 harvestAmount, uint256 minOut, uint256 maxTickets, uint256[] ticketIds, uint8[] ranks, uint256[] amounts, bytes32[][] proofs) returns (uint256 harvested, uint256 ticketsBought, uint256 collected)",
];
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
  "function buyMultipleTickets(uint256 drawId, uint8[6][] mains, uint8[2][] comps, bool[] flash)",
  "function batchClaimTicketPrizes(uint256[] ticketIds, uint8[] ranks, uint256[] amounts, bytes32[][] proofs)",
  "function claimWinnings()",
];
const WAVAX_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function withdraw(uint256)",
];

// Known contracts on Avalanche C-Chain. The bot refuses to run against anything else there, so
// that a faulty RPC cannot point it at another lottery or another token.
const MAINNET = {
  chainId: 43114n,
  lottery: "0xB49a551aecD96b60a121Fc9996C2812e9BF95186",
  wavax: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
};
const RPC_URLS = ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"];

const WEEK = 604800n;
const HALF_DAY = 43200n;
const MAX_PER_TX = 50n;
const GWEI = 1000000000n;

function defaults(cfg = {}) {
  return {
    ticketsPerDraw: 0n, // 0 = spread what the wallet holds over the draws left until the next sale
    slippageBps: 100n, // tolerance between the simulation of the sale and its execution
    minHarvest: ethers.parseEther("1"), // p33: below this, let the yield accumulate
    buyCutoff: 300n, // seconds before the draw after which we stop buying
    lookbackDraws: 60n, // draws scanned for prizes (30 days at two draws a day)
    minGas: ethers.parseEther("0.05"), // AVAX: below this, unwrap some WAVAX
    gasTopUp: ethers.parseEther("0.15"), // AVAX obtained by each top-up
    keepTickets: 30n, // working balance, in tickets: prize money above it is sent to the vault
    refreshAfter: 20n * 3600n, // the vault's reference price is refreshed at least this often
    maxFeeGwei: 150n, // above this network fee, nothing is sent on this pass
    showAmounts: true, // false: amounts are left out of the logs
    dryRun: false,
    log: console.log,
    ...cfg,
  };
}

/**
 * Number of tickets to buy now.
 * @param affordable    tickets the wallet can pay for
 * @param mine          tickets already held for this draw
 * @param scheduledTime time of the draw
 * @param fixed         fixed number of tickets per draw, or 0 to spread
 *
 * Spreading: the yield is sold once a week (from Saturday 00:00 UTC, once the p33 ratio has
 * finished rising for the epoch), while there are two draws a day. What the wallet holds is divided by the number of
 * draws left before the next sale, with at least one ticket per draw while funds last.
 */
function ticketsToBuy({ affordable, mine, scheduledTime, fixed = 0n }) {
  affordable = BigInt(affordable);
  mine = BigInt(mine);
  let target;
  if (BigInt(fixed) > 0n) {
    target = BigInt(fixed);
  } else {
    const t = BigInt(scheduledTime);
    const saleOffset = 2n * 86400n; // Saturday 00:00 UTC, counted from Thursday 00:00 UTC (see lib.inHarvestWindow)
    let nextSale = t - (t % WEEK) + saleOffset;
    if (nextSale <= t) nextSale += WEEK;
    const drawsLeft = (nextSale - t - 1n) / HALF_DAY + 1n;
    // `mine` tickets were already paid from the same budget: count them back in, so that a
    // second run before the same draw reaches the same target instead of buying again.
    target = (affordable + mine) / drawsLeft;
    if (target < 1n) target = 1n;
  }
  let n = target - mine;
  if (n > affordable) n = affordable;
  if (n > MAX_PER_TX) n = MAX_PER_TX;
  return n > 0n ? n : 0n;
}

const split = (c) => [c.map((p) => p.id), c.map((p) => p.rank), c.map((p) => p.amount), c.map((p) => p.proof)];
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
/** Removes anything that looks like an address, a hash or call data. */
const clean = (s) => String(s).replace(/0x[0-9a-fA-F]{8,}/g, "0x…");
const reason = (e) => clean(e.shortMessage || e.code || "unknown error");

/**
 * One pass.
 * @param signer       signer of the player wallet
 * @param vaultAddress the vault that funds this wallet
 * @returns { sold, received, claimed, collected, bought, swept, lowGas, problems }
 */
async function runPlayer({ signer, vaultAddress, cfg: userCfg }) {
  const cfg = defaults(userCfg);
  const log = (m) => cfg.log(clean(m));
  const fmt = (x) => (cfg.showAmounts ? Number(ethers.formatEther(x)).toFixed(4) : "…");
  const provider = signer.provider;
  const me = await signer.getAddress();
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);
  // The most likely mistake: an address that is a wallet, or another contract, instead of the vault.
  const notVault = "VAULT is not a vault: use the address shown under 'my vault' on the page, not a wallet's";
  if ((await provider.getCode(vaultAddress)) === "0x") throw new Error(notVault);
  const report = {
    sold: 0n, received: 0n, claimed: 0, collected: 0n, bought: 0n, swept: 0n, lowGas: false, problems: [],
    // for the private recap only
    dryRun: cfg.dryRun, drawId: 0n, held: null, price: 0n, wavax: null, gas: null, drawsToCheck: [],
  };
  const problem = (msg) => (report.problems.push(clean(msg)), log(`  ⚠ ${msg}`));
  // One transaction at a time, each one mined before the next. If a send fails, the signer's
  // nonce counter is reset so that the next transaction is not queued behind a gap.
  const send = async (label, fn) => {
    try {
      const tx = await fn();
      const rc = await tx.wait(1, 180000);
      if (!rc || rc.status !== 1) throw new Error(`${label}: transaction failed`);
      return rc;
    } catch (e) {
      if (typeof signer.reset === "function") signer.reset();
      throw e;
    }
  };
  // A step skipped in the simulation can become possible before the transaction is mined
  // (and the other way round): leave room for it instead of the exact estimate.
  const withMargin = async (method, args) => ({ gasLimit: ((await method.estimateGas(...args)) * 3n) / 2n });

  const [playerAddr, keeperAddr, ownerAddr, lotteryAddr, wavaxAddr] = await Promise.all([
    vault.player(), vault.keeper(), vault.owner(), vault.lottery(), vault.wavax(),
  ]).catch(() => {
    throw new Error(notVault);
  });
  if (!same(playerAddr, me)) throw new Error("this wallet is not the player set on the vault (vault settings, 'player wallet')");
  if ((await provider.getNetwork()).chainId === MAINNET.chainId && (!same(lotteryAddr, MAINNET.lottery) || !same(wavaxAddr, MAINNET.wavax))) {
    throw new Error("the vault does not point at the expected lottery and WAVAX contracts");
  }
  const lottery = new ethers.Contract(lotteryAddr, LOTTERY_ABI, signer);
  const wavax = new ethers.Contract(wavaxAddr, WAVAX_ABI, signer);
  const now = BigInt((await provider.getBlock("latest")).timestamp);

  const fee = await provider.getFeeData();
  if ((fee.maxFeePerGas ?? fee.gasPrice ?? 0n) > cfg.maxFeeGwei * GWEI) {
    problem(`network fees unusually high, nothing sent on this pass`);
    return report;
  }

  // Gas: this wallet pays for its own transactions out of the WAVAX it receives.
  const topUpGas = async () => {
    const gas = await provider.getBalance(me);
    if (gas >= cfg.minGas) return;
    const bal = await wavax.balanceOf(me);
    const need = cfg.gasTopUp - gas;
    if (bal < need) return void (report.lowGas = true);
    log(`gas: ${fmt(gas)} AVAX left, unwrapping ${fmt(need)} WAVAX`);
    if (cfg.dryRun) return;
    try {
      await send("gas top-up", () => wavax.withdraw(need));
      report.lowGas = false;
    } catch (e) {
      report.lowGas = true;
      problem(`gas top-up failed (${reason(e)})`);
    }
  };
  await topUpGas();

  // 1. The vault sells its yield and pays the budget out to this wallet.
  if (same(keeperAddr, me) || same(ownerAddr, me)) {
    try {
      const [harvestable, budget, refTime, minAge] = await Promise.all([
        vault.harvestable(), vault.ticketBudget(), vault.refTime(), vault.MIN_REF_AGE(),
      ]);
      const refAge = now - refTime;
      let amount = 0n;
      let minOut = 0n;
      let refresh = refAge >= cfg.refreshAfter; // keep the reference close to the market
      if (harvestable < cfg.minHarvest) log(`vault: yield too small to sell yet (${fmt(harvestable)} p33)`);
      else if (!lib.inHarvestWindow(now)) log(`vault: ${fmt(harvestable)} p33 of yield, sold after the weekly ratio update`);
      else if (refAge < minAge) log(`vault: ${fmt(harvestable)} p33 of yield, reference price too recent, next pass`);
      else {
        const quote = await vault.cycle.staticCall(harvestable, 0n, 0n, [], [], [], []);
        if (quote.harvested > 0n) {
          amount = harvestable;
          minOut = (quote.harvested * (10000n - cfg.slippageBps)) / 10000n;
          log(`vault: selling ${fmt(amount)} p33 for about ${fmt(quote.harvested)} WAVAX`);
        } else {
          // Nothing is offered for sale on this pass (a sale without a minimum of our own could
          // execute at the vault's floor if the price moved back before the transaction is
          // mined). The pass only moves the vault's reference one notch towards the market.
          refresh = true;
          log(`vault: sale postponed, price too far below the vault's reference; the reference is updated`);
        }
      }
      if (amount > 0n || budget > 0n || refresh) {
        if (cfg.dryRun) log(`  (dry run) vault pass not sent`);
        else {
          const before = await wavax.balanceOf(me);
          const args = [amount, minOut, 0n, [], [], [], []];
          await send("vault pass", async () => vault.cycle(...args, await withMargin(vault.cycle, args)));
          report.received = (await wavax.balanceOf(me)) - before;
          if (amount > 0n && report.received > 0n) report.sold = amount;
          log(report.received > 0n ? `vault: ${fmt(report.received)} WAVAX received` : `vault: pass done, nothing to receive`);
        }
      }
    } catch (e) {
      problem(`vault pass failed (${reason(e)})`);
    }
  } else {
    log(`vault: this wallet is not the vault's keeper, the yield is not sold by this bot`);
  }

  // 2. Prizes of this wallet's tickets.
  let drawId = 0n;
  try {
    drawId = await lottery.currentDrawId();
    const minDrawId = drawId > cfg.lookbackDraws ? drawId - cfg.lookbackDraws : 0n;
    const { claims, mismatchedMine } = await lib.planClaims({
      lottery, owner: me, now, minDrawId, lookback: 400,
      log: cfg.showAmounts ? (m) => log(m.trim()) : () => {}, // names the draws: not for public logs
    });
    if (claims.length) log(`prizes: ${claims.length} winning ticket(s) to claim`);
    // A prize seems due but the lottery's own computation differs from ours: nothing is sent,
    // and the run is reported so that somebody looks at it. The prize stays claimable.
    report.drawsToCheck = mismatchedMine;
    for (const d of mismatchedMine) {
      problem(`${cfg.showAmounts ? `draw ${d}` : "a recent draw"}: a prize seems due but its proof could not be rebuilt, claim it by hand with the player wallet`);
    }
    for (let i = 0; i < claims.length && !cfg.dryRun; i += 50) {
      const chunk = claims.slice(i, i + 50);
      await send("prize claim", () => lottery.batchClaimTicketPrizes(...split(chunk)));
      report.claimed += chunk.length;
    }
    const pending = await lottery.claimable(me);
    if (pending > 0n) {
      log(`prizes: ${fmt(pending)} WAVAX to collect`);
      if (!cfg.dryRun) {
        const before = await wavax.balanceOf(me);
        await send("prize collection", () => lottery.claimWinnings());
        report.collected = (await wavax.balanceOf(me)) - before;
      }
    }
  } catch (e) {
    problem(`prize claim failed (${reason(e)})`);
  }

  // 3. A hot wallet should not hold much. Prize money above the working balance goes to the
  //    vault, where it counts as winnings that only the vault's owner can withdraw. It is moved
  //    before the purchase step, so that a prize is never spent on tickets. The budget received
  //    from the vault is left alone, unless the wallet ends up holding more than three times
  //    its working balance.
  let price = 0n;
  try {
    price = await lottery.ticketPrice();
    const balance = await wavax.balanceOf(me);
    const keep = cfg.keepTickets * price;
    let excess = 0n;
    if (balance > keep * 3n) excess = balance - keep;
    else if (report.collected > 0n && balance > keep) excess = balance - keep < report.collected ? balance - keep : report.collected;
    if (price > 0n && excess > 0n) {
      if (cfg.dryRun) log(`  (dry run) would send a surplus of ${fmt(excess)} WAVAX to the vault`);
      else {
        await send("surplus transfer", () => wavax.transfer(vaultAddress, excess));
        report.swept = excess;
        log(`surplus: ${fmt(excess)} WAVAX sent to the vault`);
      }
    }
  } catch (e) {
    problem(`surplus transfer failed (${reason(e)})`);
  }

  await topUpGas();

  // 4. Tickets of the current draw.
  try {
    price = await lottery.ticketPrice();
    const [paused, maxPrice] = await Promise.all([lottery.paused(), vault.maxTicketPrice()]);
    const draw = drawId > 0n ? await lottery.getDraw(drawId) : null;
    const open = !paused && draw && draw.drawnAt === 0n && now + cfg.buyCutoff < draw.scheduledTime;
    if (!open) log(`tickets: no draw open for purchases right now`);
    else if (price === 0n || price > maxPrice) problem(`ticket price (${fmt(price)} WAVAX) above the cap set on the vault, nothing bought`);
    else {
      const ids = Array.from(await lottery.getOwnerTickets(me)).slice(-200);
      const tickets = await Promise.all(ids.map((id) => lottery.getTicket(id)));
      const mine = BigInt(tickets.filter((t) => t.drawId === drawId).length);
      const balance = await wavax.balanceOf(me);
      const n = ticketsToBuy({ affordable: balance / price, mine, scheduledTime: draw.scheduledTime, fixed: cfg.ticketsPerDraw });
      report.held = mine;
      if (n === 0n) log(mine > 0n ? `tickets: ${mine} already held for this draw` : `tickets: not enough WAVAX for a ticket (${fmt(balance)} WAVAX, price ${fmt(price)})`);
      else if (cfg.dryRun) log(`  (dry run) would buy ${n} ticket(s) at ${fmt(price)} WAVAX`);
      else {
        const cost = n * price;
        if ((await wavax.allowance(me, lotteryAddr)) < cost) await send("approval", () => wavax.approve(lotteryAddr, cost));
        const count = Number(n);
        const args = [drawId, Array(count).fill([0, 0, 0, 0, 0, 0]), Array(count).fill([0, 0]), Array(count).fill(true)];
        await lottery.buyMultipleTickets.staticCall(...args); // a refusal is caught here, before paying gas
        await send("ticket purchase", () => lottery.buyMultipleTickets(...args));
        report.bought = n;
        report.held = mine + n;
        log(`tickets: ${n} bought at ${fmt(price)} WAVAX (${mine + n} for this draw)`);
      }
    }
  } catch (e) {
    problem(`ticket purchase failed (${reason(e)})`);
  }

  if (report.lowGas) problem(`gas too low and no WAVAX to convert: send a little AVAX to the player wallet`);
  try {
    report.drawId = drawId;
    report.price = price;
    [report.wavax, report.gas] = await Promise.all([wavax.balanceOf(me), provider.getBalance(me)]);
  } catch {}
  return report;
}

/**
 * Private recap of a pass, for the wallet's owner (amounts included, still no address).
 * Empty when nothing worth a message happened, unless `always` is set.
 */
function recap(report, { always = false } = {}) {
  const f = (x) => Number(ethers.formatEther(x)).toFixed(4);
  const lines = [];
  if (report.sold > 0n) lines.push(`Yield sold: ${f(report.sold)} p33 for ${f(report.received)} WAVAX`);
  else if (report.received > 0n) lines.push(`Received from the vault: ${f(report.received)} WAVAX`);
  if (report.claimed > 0 || report.collected > 0n) lines.push(`Prizes: ${report.claimed} winning ticket(s) claimed, ${f(report.collected)} WAVAX collected`);
  if (report.swept > 0n) lines.push(`Put aside in the vault: ${f(report.swept)} WAVAX`);
  if (report.bought > 0n) lines.push(`Tickets: ${report.bought} bought at ${f(report.price)} WAVAX for draw ${report.drawId} (${report.held} held)`);
  for (const p of report.problems) lines.push(`⚠ ${p}`);
  if (report.drawsToCheck.length) lines.push(`Draw(s) to check by hand: ${report.drawsToCheck.join(", ")}`);
  if (!lines.length) {
    if (!always) return "";
    lines.push("Nothing to do on this pass.");
    if (report.held !== null) lines.push(`Tickets held for draw ${report.drawId}: ${report.held}`);
  }
  if (report.wavax !== null) {
    const tickets = report.price > 0n ? ` (${report.wavax / report.price} ticket(s))` : "";
    lines.push(`Player wallet: ${f(report.wavax)} WAVAX${tickets}, ${f(report.gas)} AVAX for fees`);
  }
  return [`p33 vault · player bot${report.dryRun ? " (dry run, nothing sent)" : ""}`, ...lines].join("\n");
}

function writeRecap(text) {
  const file = process.env.RECAP_FILE;
  if (!file || !text) return;
  try {
    fs.writeFileSync(file, text + "\n", { mode: 0o600 });
  } catch {}
}

async function main() {
  const env = process.env;
  // A .env file is only read on a personal machine, never by the scheduled workflow.
  if (!env.GITHUB_ACTIONS) {
    try {
      require("dotenv").config();
    } catch {}
  }
  if (!env.PLAYER_PRIVATE_KEY || !env.VAULT) throw new Error("PLAYER_PRIVATE_KEY and VAULT are required");
  if (!ethers.isAddress(env.VAULT.trim())) throw new Error("VAULT is not a valid address");
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(env.PLAYER_PRIVATE_KEY.trim())) {
    throw new Error("PLAYER_PRIVATE_KEY is not a private key: 64 hexadecimal characters are expected, not a recovery phrase or an address");
  }
  // First RPC that answers. Small batches: public endpoints cap the size of batched requests.
  const urls = env.RPC_URL ? env.RPC_URL.split(",").map((u) => u.trim()).filter(Boolean) : RPC_URLS;
  let provider;
  for (const url of urls) {
    const p = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: Number(env.RPC_BATCH || 10) });
    try {
      await p.getBlockNumber();
      provider = p;
      break;
    } catch {
      p.destroy();
    }
  }
  if (!provider) throw new Error("no RPC endpoint answered");
  if ((await provider.getNetwork()).chainId !== MAINNET.chainId && env.ALLOW_OTHER_CHAIN !== "1") {
    throw new Error("the RPC endpoint is not Avalanche C-Chain");
  }
  const signer = new ethers.NonceManager(new ethers.Wallet(env.PLAYER_PRIVATE_KEY.trim(), provider));
  const report = await runPlayer({
    signer,
    vaultAddress: ethers.getAddress(env.VAULT.trim()),
    cfg: {
      dryRun: env.DRY_RUN === "1",
      ticketsPerDraw: BigInt(env.TICKETS_PER_DRAW || "0"),
      ...(env.KEEP_TICKETS ? { keepTickets: BigInt(env.KEEP_TICKETS) } : {}),
      // public logs (scheduled workflow): amounts are left out unless asked for
      showAmounts: !env.GITHUB_ACTIONS || env.SHOW_AMOUNTS === "1",
    },
  });
  writeRecap(recap(report, { always: env.RECAP_ALWAYS === "1" }));
  console.log(report.problems.length ? `done, ${report.problems.length} problem(s)` : "done");
  // A non-zero exit makes the scheduler report the run as failed.
  if (report.problems.length) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    // Never print the full error: it can contain addresses and transaction data.
    const msg = `stopped: ${clean(e.shortMessage || String(e.message).split("(")[0])}`;
    console.error(msg);
    writeRecap(`p33 vault · player bot\n⚠ ${msg}`);
    process.exit(1);
  });
}

module.exports = { runPlayer, ticketsToBuy, clean, recap };
