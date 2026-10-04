const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { setup, expectRevert, sel, E } = require("./helpers");
const lib = require("../keeper/lib");
const { runVault, makeContext } = require("../keeper/index");
const { runPlayer, ticketsToBuy, clean, recap } = require("../keeper/player");

const quiet = { log: () => {} };

test("factory: the caller is the owner, the factory has no rights", async () => {
  const s = await setup();
  assert.equal(await s.vault.owner(), s.owner.address);
  assert.equal(await s.vault.keeper(), s.keeper.address);
  assert.equal(await s.vault.pool(), s.pool.target);
  assert.equal(await s.factory.vaultCount(), 1n);
  assert.equal(await s.vault.maxDeviationBps(), 1000n);
  assert.equal(await s.vault.minWavaxPerP33(), 0n, "no manual floor needed");
  assert.equal(await s.vault.referencePrice(), E("0.017") - 1n, "reference taken from the pool at creation (1 wei of fixed-point rounding)");
  assert.equal(await s.vault.maxTicketPrice(), E("0.5"));

  await (await s.factory.connect(s.player).createVault(1000, E("0.5"), E("1"), ethers.ZeroAddress, ethers.ZeroAddress)).wait();
  const v2 = (await s.factory.vaultsOf(s.player.address))[0];
  assert.notEqual(v2, s.vault.target);
  assert.equal(await new ethers.Contract(v2, s.vault.interface, s.provider).owner(), s.player.address);
});

test("deposit: the principal is locked in as xPHAR, nothing to sell as long as the ratio does not move", async () => {
  const s = await setup();
  await (await s.p33.setRatio(E("1.25"))).wait();
  await s.depositP33(E("1000"));
  assert.equal(await s.vault.principalAssets(), E("1250"));
  assert.equal(await s.vault.harvestable(), 0n);
});

test("harvest: only the surplus is sold, the principal stays covered", async () => {
  const s = await setup();
  await s.depositP33(E("1000"));
  await (await s.p33.setRatio(E("1.02"))).wait(); // +2% over the epoch

  const h = await s.vault.harvestable();
  // 1000 xPHAR of principal = 980.39 p33 at the new ratio; surplus ~19.6 p33
  assert.ok(h > E("19.6") && h < E("19.61"), `harvestable=${h}`);

  await expectRevert(s.vault.connect(s.keeper).harvest(h + 1n, 0), sel("ExceedsHarvestable(uint256,uint256)"));
  await (await s.vault.connect(s.keeper).harvest(h, 0)).wait();

  assert.equal(await s.vault.ticketBudget(), (h * E("0.017")) / E("1"));
  assert.equal(await s.wavax.balanceOf(s.vault.target), await s.vault.ticketBudget());
  assert.equal(await s.vault.harvestable(), 0n);
  const left = await s.p33.balanceOf(s.vault.target);
  assert.ok((await s.p33.convertToAssets(left)) >= E("1000"), "the principal must stay covered");
});

test("harvest: automatic reference price, no manual floor to maintain", async () => {
  const s = await setup();
  const k = s.vault.connect(s.keeper);
  const MAX = ethers.MaxUint256;
  const SIX_HOURS = 6n * 3600n + 60n;
  const near = (x, target) => x > (target * 9999n) / 10000n && x < (target * 10001n) / 10000n;
  await s.depositP33(E("1000"));
  await (await s.p33.setRatio(E("1.02"))).wait();
  const h = await s.vault.harvestable();
  assert.equal(await s.vault.floorPrice(), E("0.0153") - 1n, "10% below the reference of 0.017");

  // price pushed 41% down at the moment of the sale (sandwich, or a crash): refused
  await (await s.pool.setRate(E("0.010"))).wait();
  await expectRevert(k.harvest(h, 0), sel("Slippage(uint256,uint256)"));
  assert.equal(await s.p33.balanceOf(s.pool.target), 0n, "the p33 did not stay in the pool");
  assert.equal(await s.vault.ticketBudget(), 0n);

  // same pass through cycle(): the sale is skipped, and the reference moves towards the
  // market by one notch only (40 bins of 0.25%, about 10%), not all the way to 0.010
  await (await k.cycle(MAX, 0, 0, [], [], [], [])).wait();
  assert.equal(await s.vault.harvestable(), h);
  const notch1 = await s.vault.referencePrice();
  assert.ok(near(notch1, E("0.015384")), `one notch down: ${notch1}`);

  // a reference written by a pass cannot be sold against, nor moved again, before 6 hours
  await expectRevert(k.harvest(h, 0), sel("ReferenceTooRecent()"));
  await (await s.pool.setRate(E("0.0140"))).wait(); // within 10% of the new reference
  await (await k.cycle(MAX, 0, 0, [], [], [], [])).wait();
  assert.equal(await s.vault.harvestable(), h, "not sold in the hours following a reference update");
  assert.equal(await s.vault.referencePrice(), notch1, "not moved again either");
  await (await s.pool.setRate(E("0.010"))).wait();

  // the price stays at 0.010: pass after pass, every 6 hours, the reference comes down to the
  // market and the sale ends up going through without anyone touching a setting
  let passes = 0;
  while ((await s.vault.harvestable()) > 0n && passes < 10) {
    await s.warp(SIX_HOURS);
    await (await k.cycle(MAX, 0, 0, [], [], [], [])).wait();
    passes++;
  }
  assert.equal(passes, 5, "4 more notches, then the sale");
  assert.equal(await s.vault.harvestable(), 0n);
  assert.equal(await s.vault.ticketBudget(), (h * E("0.010")) / E("1"));

  // a price moving up is never a problem
  await (await s.p33.setRatio(E("1.04"))).wait();
  await (await s.pool.setRate(E("0.030"))).wait();
  await s.warp(SIX_HOURS);
  await (await k.harvest(await s.vault.harvestable(), 0)).wait();

  // the optional absolute floor still applies on top when the owner sets one
  await (await s.p33.setRatio(E("1.06"))).wait();
  await (await s.vault.setGuards(E("0.05"), E("0.5"), 1000)).wait();
  await s.warp(SIX_HOURS);
  await expectRevert(k.harvest(await s.vault.harvestable(), 0), sel("Slippage(uint256,uint256)"));
  await expectRevert(s.vault.setGuards(0, E("0.5"), 0), sel("GuardTooHigh()"));
  await expectRevert(s.vault.setGuards(0, E("0.5"), 6000), sel("GuardTooHigh()"));
});

test("purchase: as many tickets as the budget allows, in batches, tickets held in the vault's name", async () => {
  const s = await setup();
  await (await s.wavax.mint(s.owner.address, E("20"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("20"))).wait();
  await (await s.vault.fundBudget(E("20"))).wait(); // 20 / 0.19 = 105 tickets
  const drawId = await s.openDraw();

  const k = s.vault.connect(s.keeper);
  await (await k.buyTickets(1000)).wait(); // capped at 50
  await (await k.buyTickets(1000)).wait();
  await (await k.buyTickets(1000)).wait(); // the last 5
  await expectRevert(k.buyTickets(1000), sel("NothingToBuy()"));

  const ids = await s.lottery.getOwnerTickets(s.vault.target);
  assert.equal(ids.length, 105);
  assert.equal((await s.lottery.getTicket(ids[0])).drawId, drawId);
  assert.equal(await s.vault.ticketBudget(), E("20") - 105n * E("0.19"));
  assert.equal(await s.wavax.allowance(s.vault.target, s.lottery.target), 0n);
});

test("purchase: rejected if the ticket price exceeds the cap, if the lottery is paused, if the draw is closed", async () => {
  const s = await setup();
  await (await s.wavax.mint(s.owner.address, E("5"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("5"))).wait();
  await (await s.vault.fundBudget(E("5"))).wait();
  await s.openDraw(3600n);
  const k = s.vault.connect(s.keeper);

  await (await s.lottery.setTicketPrice(E("5"))).wait(); // poller key compromised
  await expectRevert(k.buyTickets(10), sel("TicketPriceTooHigh(uint256,uint256)"));
  await (await s.lottery.setTicketPrice(E("0.19"))).wait();

  await (await s.lottery.setPaused(true)).wait();
  await expectRevert(k.buyTickets(10), "EnforcedPause");
  await (await s.lottery.setPaused(false)).wait();

  await s.warp(3700n);
  await expectRevert(k.buyTickets(10), "E27");
  assert.equal(await s.vault.ticketBudget(), E("5"));
});

test("permissions: the keeper cannot withdraw anything, a stranger cannot trigger anything", async () => {
  const s = await setup();
  await s.depositP33(E("1000"));
  const k = s.vault.connect(s.keeper);
  const x = s.vault.connect(s.stranger);
  const unauthorized = sel("OwnableUnauthorizedAccount(address)");

  await expectRevert(k.withdraw(E("1"), s.keeper.address), unauthorized);
  await expectRevert(k.withdrawAll(s.keeper.address), unauthorized);
  await expectRevert(k.withdrawWavax(1, s.keeper.address), unauthorized);
  await expectRevert(k.setGuards(1, 1, 1000), unauthorized);
  await expectRevert(k.setKeeper(s.keeper.address), unauthorized);
  await expectRevert(k.rescue(s.wavax.target, 1, s.keeper.address), unauthorized);
  await expectRevert(x.harvest(1, 0), sel("NotOperator()"));
  await expectRevert(x.buyTickets(1), sel("NotOperator()"));
  await expectRevert(x.collectWinnings(), sel("NotOperator()"));
  await expectRevert(s.vault.rescue(s.p33.target, 1, s.owner.address), sel("ProtectedToken()"));
});

test("withdrawals: the owner can take back their p33 and their WAVAX at any time", async () => {
  const s = await setup();
  await s.depositP33(E("1000"));
  await (await s.p33.setRatio(E("1.02"))).wait();

  await (await s.vault.withdraw(E("400"), s.owner.address)).wait();
  assert.equal(await s.vault.principalAssets(), E("1000") - E("408")); // 400 p33 = 408 xPHAR
  const before = await s.p33.balanceOf(s.owner.address);
  await (await s.vault.withdrawAll(s.owner.address)).wait();
  assert.equal((await s.p33.balanceOf(s.owner.address)) - before, E("600"));
  assert.equal(await s.vault.principalAssets(), 0n);
  assert.equal(await s.p33.balanceOf(s.vault.target), 0n);

  await (await s.wavax.mint(s.owner.address, E("3"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("3"))).wait();
  await (await s.vault.fundBudget(E("3"))).wait();
  await (await s.vault.withdrawWavax(E("2"), s.owner.address)).wait();
  assert.equal(await s.vault.ticketBudget(), E("1"));
});

test("ranks: table identical to PartnerLotteryCore", () => {
  const expected = { "6,2": 1, "6,1": 2, "6,0": 3, "5,2": 4, "5,1": 5, "5,0": 6, "4,2": 7, "4,1": 8, "4,0": 9, "3,2": 10, "3,1": 11, "3,0": 12, "2,2": 0, "0,0": 0 };
  for (const [k, r] of Object.entries(expected)) {
    const [m, c] = k.split(",").map(Number);
    assert.equal(lib.getRank(m, c, false), r, k);
  }
  assert.equal(lib.getRank(6, 2, true), 0); // R1 removed in Run 2
  assert.equal(lib.getRank(6, 1, true), 2);
});

test("harvest window: closed from Thursday 00:00 to Saturday 00:00 UTC", () => {
  const thu = 1791417600n; // Thursday 2026-10-08 00:00 UTC
  assert.equal(thu % 604800n, 0n);
  assert.equal(lib.inHarvestWindow(thu + 3600n), false); // Thursday 01:00, buyback in progress
  assert.equal(lib.inHarvestWindow(thu + 86400n + 3600n), false); // Friday 01:00, buyback still running
  assert.equal(lib.inHarvestWindow(thu + 86400n + 20n * 3600n), false); // Friday 20:00, late step possible
  assert.equal(lib.inHarvestWindow(thu + 2n * 86400n - 1n), false); // Friday 23:59:59
  assert.equal(lib.inHarvestWindow(thu + 2n * 86400n), true); // Saturday 00:00
  assert.equal(lib.inHarvestWindow(thu + 6n * 86400n), true); // Wednesday 00:00
  assert.equal(lib.inHarvestWindow(thu + 604800n - 3600n), false); // 1 h before the flip
});

test("full cycle by the keeper: harvest, purchase, draw, Merkle proofs, 97% collected", async () => {
  const s = await setup();
  await s.depositP33(E("5000"));
  await (await s.p33.setRatio(E("1.01"))).wait(); // ~49.5 p33 of yield -> ~0.84 WAVAX -> 4 tickets
  const drawId = await s.openDraw();

  // move into the harvest window (Saturday), whatever day the test runs on
  const t = await s.now();
  const target = t - (t % 604800n) + 604800n + 2n * 86400n;
  await (await s.lottery.createDraw(target + 86400n)).wait(); // draw still open after the time jump
  const draw2 = await s.lottery.currentDrawId();
  assert.equal(draw2, drawId + 1n);
  await s.warp(target - t);

  const state = {};
  let ctx = await makeContext({ signer: s.keeper, lotteryAddress: s.lottery.target, state, cfg: quiet });
  await runVault(ctx, s.vault.target);

  const mine = await s.lottery.getOwnerTickets(s.vault.target);
  assert.equal(mine.length, 4, "4 tickets bought with the yield");
  assert.ok((await s.vault.ticketBudget()) < E("0.19"), "budget spent as far as possible");
  assert.ok((await s.p33.convertToAssets(await s.p33.balanceOf(s.vault.target))) >= E("5000"), "principal intact");

  // another player picks the same line as the vault's ticket 1: rank 1 will be split in two
  const t1 = await s.lottery.getTicket(mine[0]);
  const main6 = t1.mainNumbers.slice(0, 6).map(Number);
  const comp2 = t1.compNumbers.slice(0, 2).map(Number);
  await (await s.wavax.connect(s.player).approve(s.lottery.target, E("1"))).wait();
  await (await s.lottery.connect(s.player).buyMultipleTickets(draw2, [main6], [comp2], [false])).wait();

  // draw: the 6 numbers of ticket 1 + a 7th, and its 2 complementary numbers
  const seventh = [...Array(24).keys()].map((i) => i + 1).find((n) => !main6.includes(n));
  const pools = Array(12).fill(E("1"));
  pools[0] = E("10");
  await s.warp(86400n + 60n);
  await (await s.lottery.setResult(draw2, [...main6, seventh], comp2, pools)).wait();

  // the official root is computed here with the same library as the keeper
  const allIds = await s.lottery.getDrawTickets(draw2);
  const tickets = await Promise.all(allIds.map((id) => s.lottery.getTicket(id)));
  const winners = lib.computeWinners(
    { winningMain: [...main6, seventh], winningComp: comp2, rankPools: pools, isRun2: false },
    tickets.map((x) => ({ id: x.id, owner: x.owner, mainNumbers: x.mainNumbers.map(Number), compNumbers: x.compNumbers.map(Number), isSystemPlay: x.isSystemPlay, systemMainCount: x.systemMainCount, systemCompCount: x.systemCompCount }))
  );
  const jackpot = winners.find((w) => w.id === mine[0]);
  assert.equal(jackpot.rank, 1);
  assert.equal(jackpot.amount, E("5"), "jackpot of 10 split between two lines");
  const tree = lib.buildTree(winners);
  await (await s.lottery.setMerkleRoot(draw2, tree.root)).wait();

  // before the 15 minutes have passed: the keeper waits, nothing is claimed
  ctx = await makeContext({ signer: s.keeper, lotteryAddress: s.lottery.target, state, cfg: quiet });
  await runVault(ctx, s.vault.target);
  assert.equal(await s.lottery.ticketPrizeClaimed(mine[0]), false);

  await s.warp(16n * 60n);
  const gross = winners.filter((w) => w.owner === s.vault.target).reduce((a, w) => a + w.amount, 0n);
  const balBefore = await s.wavax.balanceOf(s.vault.target);
  const budgetBefore = await s.vault.ticketBudget();
  ctx = await makeContext({ signer: s.keeper, lotteryAddress: s.lottery.target, state, cfg: quiet });
  await runVault(ctx, s.vault.target);

  const net = gross - (gross * 300n) / 10000n;
  assert.equal((await s.wavax.balanceOf(s.vault.target)) - balBefore, net, "97% of the winnings received");
  assert.equal(await s.vault.ticketBudget(), budgetBefore, "winnings not replayed by default");
  assert.equal(await s.vault.winnings(), net);
  assert.equal(await s.lottery.claimable(s.vault.target), 0n);
  assert.ok(state[s.vault.target.toLowerCase()].doneDraws.includes(draw2.toString()));

  // the owner withdraws their winnings
  const ob = await s.wavax.balanceOf(s.owner.address);
  await (await s.vault.withdrawWavax(net, s.owner.address)).wait();
  assert.equal((await s.wavax.balanceOf(s.owner.address)) - ob, net);
  assert.equal(await s.vault.ticketBudget(), budgetBefore);
});

test("winnings replayed when a reinvest cap is set", async () => {
  const s = await setup({ reinvest: true });
  await (await s.wavax.mint(s.owner.address, E("1"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("1"))).wait();
  await (await s.vault.fundBudget(E("0.19"))).wait();
  const drawId = await s.openDraw(3600n);
  await (await s.vault.connect(s.keeper).buyTickets(1)).wait();
  const [id] = await s.lottery.getOwnerTickets(s.vault.target);
  const t1 = await s.lottery.getTicket(id);
  const main6 = t1.mainNumbers.slice(0, 6).map(Number);
  const seventh = [...Array(24).keys()].map((i) => i + 1).find((n) => !main6.includes(n));
  const pools = Array(12).fill(0n);
  pools[0] = E("2");
  await s.warp(3700n);
  await (await s.lottery.setResult(drawId, [...main6, seventh], t1.compNumbers.slice(0, 2).map(Number), pools)).wait();
  const tree = lib.buildTree([{ id, owner: s.vault.target, rank: 1, amount: E("2") }]);
  await (await s.lottery.setMerkleRoot(drawId, tree.root)).wait();
  await s.warp(16n * 60n);
  const p = lib.proofsFor(tree, s.vault.target)[0];
  await (await s.vault.connect(s.keeper).claimPrizes([p.id], [p.rank], [p.amount], [p.proof])).wait();
  assert.equal(await s.vault.ticketBudget(), E("1.94"));
  assert.equal(await s.vault.winnings(), 0n);
});

test("keeper: on-chain root differs from the recomputed one -> nothing is sent", async () => {
  const s = await setup();
  await (await s.wavax.mint(s.owner.address, E("1"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("1"))).wait();
  await (await s.vault.fundBudget(E("0.19"))).wait();
  const drawId = await s.openDraw(3600n);
  await (await s.vault.connect(s.keeper).buyTickets(1)).wait();
  const [id] = await s.lottery.getOwnerTickets(s.vault.target);
  const t1 = await s.lottery.getTicket(id);
  const main6 = t1.mainNumbers.slice(0, 6).map(Number);
  const seventh = [...Array(24).keys()].map((i) => i + 1).find((n) => !main6.includes(n));
  const pools = Array(12).fill(0n);
  pools[0] = E("2");
  await s.warp(3700n);
  await (await s.lottery.setResult(drawId, [...main6, seventh], t1.compNumbers.slice(0, 2).map(Number), pools)).wait();
  await (await s.lottery.setMerkleRoot(drawId, ethers.id("another computation convention"))).wait();
  await s.warp(16n * 60n);

  const logs = [];
  const state = {};
  const ctx = await makeContext({ signer: s.keeper, lotteryAddress: s.lottery.target, state, cfg: { log: (m) => logs.push(m) } });
  await runVault(ctx, s.vault.target);
  assert.equal(await s.lottery.ticketPrizeClaimed(id), false);
  assert.ok(logs.some((l) => l.includes("recomputed root differs")));
  assert.equal(state[s.vault.target.toLowerCase()].doneDraws.length, 0, "the draw is still to be processed");
});

test("cycle: a single transaction collects the winnings, sells the yield and buys the tickets", async () => {
  const s = await setup();
  const k = s.vault.connect(s.keeper);
  const MAX = ethers.MaxUint256;
  await s.depositP33(E("5000"));
  await (await s.p33.setRatio(E("1.01"))).wait();
  const draw1 = await s.openDraw(3600n);

  // 1st cycle: sale + purchase, nothing to claim
  let rc = await (await k.cycle(MAX, 0, 50, [], [], [], [])).wait();
  const names = (r) => r.logs.map((l) => { try { return s.vault.interface.parseLog(l)?.name; } catch { return null; } }).filter(Boolean);
  assert.deepEqual(names(rc), ["Harvested", "ReferenceUpdated", "TicketsBought"]);
  const mine = await s.lottery.getOwnerTickets(s.vault.target);
  assert.equal(mine.length, 4);

  // ticket 1 wins rank 1; a new draw is opened; the ratio rises again
  const t1 = await s.lottery.getTicket(mine[0]);
  const main6 = t1.mainNumbers.slice(0, 6).map(Number);
  const seventh = [...Array(24).keys()].map((i) => i + 1).find((n) => !main6.includes(n));
  const pools = Array(12).fill(0n);
  pools[0] = E("3");
  await s.warp(3700n);
  await (await s.lottery.setResult(draw1, [...main6, seventh], t1.compNumbers.slice(0, 2).map(Number), pools)).wait();
  const tree = lib.buildTree([{ id: mine[0], owner: s.vault.target, rank: 1, amount: E("3") }]);
  await (await s.lottery.setMerkleRoot(draw1, tree.root)).wait();
  await s.warp(6n * 3600n);
  await s.openDraw(3600n);
  await (await s.p33.setRatio(E("1.02"))).wait();

  // 2nd cycle: claim + collection + sale + purchase, still a single transaction
  const p = lib.proofsFor(tree, s.vault.target)[0];
  rc = await (await k.cycle(MAX, 0, 50, [p.id], [p.rank], [p.amount], [p.proof])).wait();
  assert.deepEqual(names(rc), ["PrizesClaimed", "WinningsCollected", "Harvested", "ReferenceUpdated", "TicketsBought"]);
  assert.equal(await s.vault.winnings(), E("2.91"), "3 WAVAX minus the 3% fee, set aside");
  assert.ok((await s.lottery.getOwnerTickets(s.vault.target)).length > 4);
  assert.ok((await s.p33.convertToAssets(await s.p33.balanceOf(s.vault.target))) >= E("5000"), "principal intact");

  await expectRevert(s.vault.connect(s.stranger).cycle(MAX, 0, 50, [], [], [], []), sel("NotOperator()"));
});

test("cycle: an impossible step is skipped without blocking the others", async () => {
  const s = await setup();
  const k = s.vault.connect(s.keeper);
  const MAX = ethers.MaxUint256;
  await s.depositP33(E("1000"));
  await (await s.p33.setRatio(E("1.02"))).wait();
  await (await s.wavax.mint(s.owner.address, E("1"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("1"))).wait();
  await (await s.vault.fundBudget(E("1"))).wait();
  const h = await s.vault.harvestable();

  // price below the floor AND no open draw: nothing moves, nothing fails
  await (await s.pool.setRate(E("0.010"))).wait();
  await (await k.cycle(MAX, 0, 50, [], [], [], [])).wait();
  assert.equal(await s.vault.harvestable(), h);
  assert.equal(await s.vault.ticketBudget(), E("1"));
  assert.equal(await s.p33.balanceOf(s.pool.target), 0n, "sale cancelled: no p33 went to the pool");
  assert.equal(await s.wavax.allowance(s.vault.target, s.lottery.target), 0n);

  // draw open, price still too low: the purchase goes through, the sale waits
  await s.openDraw(3600n);
  await (await k.cycle(MAX, 0, 50, [], [], [], [])).wait();
  assert.equal(await s.vault.harvestable(), h, "yield kept for later");
  assert.equal((await s.lottery.getOwnerTickets(s.vault.target)).length, 5);

  // price recovered, lottery paused: the sale goes through, the purchase waits
  await (await s.pool.setRate(E("0.017"))).wait();
  await s.warp(6n * 3600n + 60n);
  await (await s.lottery.setPaused(true)).wait();
  const before = await s.vault.ticketBudget();
  await (await k.cycle(MAX, 0, 50, [], [], [], [])).wait();
  assert.equal(await s.vault.harvestable(), 0n);
  assert.equal((await s.vault.ticketBudget()) - before, (h * E("0.017")) / E("1"));
  assert.equal((await s.lottery.getOwnerTickets(s.vault.target)).length, 5);
});

test("swap pool: only the owner can change it, and only to a p33/WAVAX pool", async () => {
  const s = await setup();
  const { deploy } = require("./helpers");
  const other = await deploy("MockDlmmPool", s.deployer, s.p33.target, s.wavax.target);
  const wrong = await deploy("MockDlmmPool", s.deployer, s.p33.target, s.p33.target);
  await expectRevert(s.vault.connect(s.keeper).setPool(other.target), sel("OwnableUnauthorizedAccount(address)"));
  await expectRevert(s.vault.setPool(wrong.target), sel("WrongPool()"));
  await (await s.vault.setPool(other.target)).wait();
  assert.equal(await s.vault.pool(), other.target);
  await expectRevert(s.vault.connect(s.stranger).swapForCycle(1, 0), sel("OnlySelf()"));
  await expectRevert(s.vault.swapForCycle(1, 0), sel("OnlySelf()"));
});

test("reinvest cap: a large prize is replayed only up to the cap, the rest is set aside", async () => {
  const s = await setup({ reinvest: E("0.5") });
  await (await s.wavax.mint(s.owner.address, E("1"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("1"))).wait();
  await (await s.vault.fundBudget(E("0.19"))).wait();
  const drawId = await s.openDraw(3600n);
  await (await s.vault.connect(s.keeper).buyTickets(1)).wait();
  const [id] = await s.lottery.getOwnerTickets(s.vault.target);
  const t1 = await s.lottery.getTicket(id);
  const main6 = t1.mainNumbers.slice(0, 6).map(Number);
  const seventh = [...Array(24).keys()].map((i) => i + 1).find((n) => !main6.includes(n));
  const pools = Array(12).fill(0n);
  pools[0] = E("500"); // jackpot
  await s.warp(3700n);
  await (await s.lottery.setResult(drawId, [...main6, seventh], t1.compNumbers.slice(0, 2).map(Number), pools)).wait();
  const tree = lib.buildTree([{ id, owner: s.vault.target, rank: 1, amount: E("500") }]);
  await (await s.lottery.setMerkleRoot(drawId, tree.root)).wait();
  await s.warp(16n * 60n);
  const p = lib.proofsFor(tree, s.vault.target)[0];
  await (await s.vault.connect(s.keeper).claimPrizes([p.id], [p.rank], [p.amount], [p.proof])).wait();
  assert.equal(await s.vault.ticketBudget(), E("0.5"), "only the cap goes back into the budget");
  assert.equal(await s.vault.winnings(), E("485") - E("0.5"), "the rest of the 485 WAVAX is out of the keeper's reach");
  await (await s.vault.setReinvestCap(0)).wait();
  assert.equal(await s.vault.reinvestCap(), 0n);
});

test("owner safety: ownership cannot be renounced, funds cannot be withdrawn into the vault itself, guards are bounded", async () => {
  const s = await setup();
  await s.depositP33(E("1000"));
  await expectRevert(s.vault.renounceOwnership(), sel("RenounceDisabled()"));
  assert.equal(await s.vault.owner(), s.owner.address);
  await expectRevert(s.vault.withdrawAll(s.vault.target), sel("InvalidRecipient()"));
  await expectRevert(s.vault.withdraw(E("1"), s.vault.target), sel("InvalidRecipient()"));
  await expectRevert(s.vault.withdrawWavax(0, s.vault.target), sel("InvalidRecipient()"));
  assert.equal(await s.vault.principalAssets(), E("1000"), "principal untouched by the rejected calls");
  await expectRevert(s.vault.setGuards(ethers.MaxUint256, E("0.5"), 1000), sel("GuardTooHigh()"));

  // withdrawWavax(max) takes the whole balance, whatever the budget is
  await (await s.wavax.mint(s.owner.address, E("2"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("2"))).wait();
  await (await s.vault.fundBudget(E("2"))).wait();
  await (await s.vault.withdrawWavax(ethers.MaxUint256, s.owner.address)).wait();
  assert.equal(await s.wavax.balanceOf(s.vault.target), 0n);
  assert.equal(await s.vault.ticketBudget(), 0n);

  // transfer of ownership is two-step: the new owner must accept
  await (await s.vault.transferOwnership(s.player.address)).wait();
  assert.equal(await s.vault.owner(), s.owner.address);
  await (await s.vault.connect(s.player).acceptOwnership()).wait();
  assert.equal(await s.vault.owner(), s.player.address);
});

test("cycle: a lottery whose views revert does not block the sale of the yield, nor the withdrawals", async () => {
  const s = await setup();
  const k = s.vault.connect(s.keeper);
  await s.depositP33(E("1000"));
  await (await s.p33.setRatio(E("1.02"))).wait();
  await s.openDraw(3600n);
  await (await s.lottery.setBroken(true)).wait();

  const h = await s.vault.harvestable();
  await (await k.cycle(ethers.MaxUint256, 0, 50, [], [], [], [])).wait();
  assert.equal(await s.vault.harvestable(), 0n, "yield sold despite the broken lottery");
  assert.equal(await s.vault.ticketBudget(), (h * E("0.017")) / E("1"));
  await expectRevert(k.buyTickets(1), sel("LotteryUnavailable()"));
  await (await k.collectWinnings()).wait(); // no-op, does not revert

  const before = await s.p33.balanceOf(s.owner.address);
  await (await s.vault.withdrawAll(s.owner.address)).wait();
  assert.ok((await s.p33.convertToAssets((await s.p33.balanceOf(s.owner.address)) - before)) >= E("1000"));
  await (await s.vault.withdrawWavax(ethers.MaxUint256, s.owner.address)).wait();
  assert.equal(await s.wavax.balanceOf(s.vault.target), 0n);
});

test("factory registry: isVault is true only for vaults it created", async () => {
  const s = await setup();
  assert.equal(await s.factory.isVault(s.vault.target), true);
  assert.equal(await s.factory.isVault(s.stranger.address), false);
  assert.equal(await s.factory.isVault(s.pool.target), false);
});

test("execute: the owner can make the vault claim rewards and move NFTs out; nobody else can", async () => {
  const s = await setup();
  const { deploy } = require("./helpers");
  const token = await deploy("MockERC20", s.deployer, "Reward", "RWD");
  const rewards = await deploy("MockRewards", s.deployer, token.target);
  const v = s.vault.target;

  // an NFT sent with a safe transfer is accepted, then sent on to the owner
  await (await rewards.airdropNft(v)).wait();
  assert.equal(await rewards.ownerOf(1n), v);
  const moveNft = rewards.interface.encodeFunctionData("transferFrom", [v, s.owner.address, 1n]);
  await expectRevert(s.vault.connect(s.keeper).execute(rewards.target, 0, moveNft), sel("OwnableUnauthorizedAccount(address)"));
  await expectRevert(s.vault.connect(s.stranger).execute(rewards.target, 0, moveNft), sel("OwnableUnauthorizedAccount(address)"));
  await (await s.vault.execute(rewards.target, 0, moveNft)).wait();
  assert.equal(await rewards.ownerOf(1n), s.owner.address);

  // a reward only the player's address can claim: claimed by the vault, then taken out
  await (await s.vault.execute(rewards.target, 0, rewards.interface.encodeFunctionData("claim"))).wait();
  assert.equal(await token.balanceOf(v), E("100"));
  await (await s.vault.rescue(token.target, E("100"), s.owner.address)).wait();
  assert.equal(await token.balanceOf(s.owner.address), E("100"));

  // a failing call reverts with the callee's own error; the vault cannot call itself
  await expectRevert(s.vault.execute(rewards.target, 0, moveNft), sel("ERC721InsufficientApproval(address,uint256)"));
  await expectRevert(s.vault.execute(v, 0, "0x"), sel("InvalidRecipient()"));

  // native AVAX can come in and be sent out
  await (await s.owner.sendTransaction({ to: v, value: E("1") })).wait();
  const before = await s.provider.getBalance(s.stranger.address);
  await (await s.vault.execute(s.stranger.address, E("1"), "0x")).wait();
  assert.equal((await s.provider.getBalance(s.stranger.address)) - before, E("1"));

  // p33 and WAVAX cannot be targeted: somebody who approved p33 to a vault that is not theirs
  // (a trapped link) cannot have it pulled by that vault's owner
  await (await s.p33.mint(s.stranger.address, E("100"))).wait();
  await (await s.p33.connect(s.stranger).approve(v, E("100"))).wait();
  const pull = s.p33.interface.encodeFunctionData("transferFrom", [s.stranger.address, s.owner.address, E("100")]);
  await expectRevert(s.vault.execute(s.p33.target, 0, pull), sel("ProtectedToken()"));
  const out = s.wavax.interface.encodeFunctionData("transfer", [s.owner.address, 1n]);
  await expectRevert(s.vault.execute(s.wavax.target, 0, out), sel("ProtectedToken()"));
  assert.equal(await s.p33.balanceOf(s.stranger.address), E("100"));
});

test("player wallet: the vault sells the yield and pays the budget to the player, who buys in their own name", async () => {
  const s = await setup({ playerMode: true });
  const k = s.vault.connect(s.player); // the player wallet is also the vault's keeper
  const MAX = ethers.MaxUint256;
  assert.equal(await s.vault.player(), s.player.address);
  await s.depositP33(E("5000"));
  await (await s.p33.setRatio(E("1.01"))).wait();
  await s.openDraw(3600n);
  const h = await s.vault.harvestable();

  const rc = await (await k.cycle(MAX, 0, 50, [], [], [], [])).wait();
  const names = rc.logs.map((l) => { try { return s.vault.interface.parseLog(l)?.name; } catch { return null; } }).filter(Boolean);
  assert.deepEqual(names, ["Harvested", "ReferenceUpdated", "PaidOut"]);
  const paid = (h * E("0.017")) / E("1");
  assert.equal(await s.wavax.balanceOf(s.player.address), paid, "the whole budget went to the player wallet");
  assert.equal(await s.vault.ticketBudget(), 0n);
  assert.equal(await s.wavax.balanceOf(s.vault.target), 0n);
  assert.equal((await s.lottery.getOwnerTickets(s.vault.target)).length, 0, "the vault buys nothing itself");
  assert.ok((await s.p33.convertToAssets(await s.p33.balanceOf(s.vault.target))) >= E("5000"), "principal intact");

  // the vault refuses to buy in this mode, and the keeper cannot redirect the payout
  await expectRevert(k.buyTickets(1), sel("PlayerMode()"));
  await expectRevert(k.setPlayer(s.stranger.address), sel("OwnableUnauthorizedAccount(address)"));
  await expectRevert(s.vault.setPlayer(s.vault.target), sel("InvalidRecipient()"));
  await expectRevert(k.withdrawWavax(1, s.player.address), sel("OwnableUnauthorizedAccount(address)"));
  await expectRevert(k.withdraw(1, s.player.address), sel("OwnableUnauthorizedAccount(address)"));

  // a budget added by the owner follows the same path
  await (await s.wavax.mint(s.owner.address, E("1"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("1"))).wait();
  await (await s.vault.fundBudget(E("1"))).wait();
  await (await k.cycle(0, 0, 0, [], [], [], [])).wait();
  assert.equal(await s.wavax.balanceOf(s.player.address), paid + E("1"));

  // winnings set aside in the vault are never paid out: only the budget is
  await (await s.wavax.mint(s.vault.target, E("3"))).wait();
  await (await k.cycle(0, 0, 0, [], [], [], [])).wait();
  assert.equal(await s.wavax.balanceOf(s.player.address), paid + E("1"));
  assert.equal(await s.vault.winnings(), E("3"));

  // back to the mode where the vault plays itself
  await (await s.vault.setPlayer(ethers.ZeroAddress)).wait();
  await (await s.wavax.mint(s.owner.address, E("1"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("1"))).wait();
  await (await s.vault.fundBudget(E("1"))).wait();
  await (await k.cycle(0, 0, 50, [], [], [], [])).wait();
  assert.equal((await s.lottery.getOwnerTickets(s.vault.target)).length, 5);
});

test("player bot: spreads the tickets over the draws left before the next sale", () => {
  const thu = 1767225600n; // Thursday 2026-01-01 00:00 UTC
  const fri6 = thu + 2n * 86400n + 6n * 3600n; // Saturday 06:00: first draw after the weekly sale
  // 14 draws from Saturday 06:00 to the next Friday 18:00
  assert.equal(ticketsToBuy({ affordable: 28n, mine: 0n, scheduledTime: fri6 }), 2n);
  assert.equal(ticketsToBuy({ affordable: 26n, mine: 2n, scheduledTime: fri6 }), 0n, "second run before the same draw: nothing more");
  assert.equal(ticketsToBuy({ affordable: 26n, mine: 0n, scheduledTime: fri6 + 43200n }), 2n, "next draw: 13 draws left");
  assert.equal(ticketsToBuy({ affordable: 5n, mine: 0n, scheduledTime: fri6 }), 1n, "at least one ticket per draw while funds last");
  assert.equal(ticketsToBuy({ affordable: 0n, mine: 0n, scheduledTime: fri6 }), 0n);
  assert.equal(ticketsToBuy({ affordable: 3n, mine: 0n, scheduledTime: thu + 604800n + 86400n + 18n * 3600n }), 3n, "last draw before the sale: everything");
  assert.equal(ticketsToBuy({ affordable: 5000n, mine: 0n, scheduledTime: fri6 }), 50n, "50 per transaction at most");
  // public logs: anything that looks like an address, a hash or call data is masked
  assert.equal(clean("execution reverted: 0x1E95De5A036767A44e7974151852ACce4223e1E1 is not allowed"), "execution reverted: 0x… is not allowed");
  // fixed number of tickets per draw
  assert.equal(ticketsToBuy({ affordable: 10n, mine: 0n, scheduledTime: fri6, fixed: 3n }), 3n);
  assert.equal(ticketsToBuy({ affordable: 10n, mine: 1n, scheduledTime: fri6, fixed: 3n }), 2n);
  assert.equal(ticketsToBuy({ affordable: 1n, mine: 0n, scheduledTime: fri6, fixed: 3n }), 1n);
});

test("player bot: one pass sells, buys from the player wallet, claims its prizes, and nothing is done twice", async () => {
  const s = await setup({ playerMode: true });
  const logs = [];
  const cfg = { log: (m) => logs.push(m), ticketsPerDraw: 2n };
  const run = () => runPlayer({ signer: s.player, vaultAddress: s.vault.target, cfg });
  await s.depositP33(E("5000"));
  await (await s.p33.setRatio(E("1.01"))).wait(); // ~49.5 p33 of yield -> ~0.84 WAVAX

  // move into the sale window (Saturday), with a draw open
  const t = await s.now();
  const target = t - (t % 604800n) + 604800n + 2n * 86400n;
  await (await s.lottery.createDraw(target + 43200n)).wait();
  const draw1 = await s.lottery.currentDrawId();
  await s.warp(target - t);

  let r = await run();
  assert.deepEqual(r.problems, []);
  assert.ok(r.received > E("0.84") && r.received < E("0.85"), `received ${r.received}`);
  assert.equal(r.bought, 2n);
  let mine = await s.lottery.getOwnerTickets(s.player.address);
  assert.equal(mine.length, 2, "tickets held by the player wallet itself");
  assert.equal((await s.lottery.getTicket(mine[0])).owner, s.player.address);
  assert.equal(await s.vault.ticketBudget(), 0n);
  assert.equal(await s.wavax.allowance(s.player.address, s.lottery.target), 0n, "exact approval, nothing left");
  assert.ok((await s.p33.convertToAssets(await s.p33.balanceOf(s.vault.target))) >= E("5000"), "principal intact");

  // second run before the same draw: nothing sold, nothing bought
  r = await run();
  assert.deepEqual(r.problems, []);
  assert.equal(r.bought, 0n);
  assert.equal(r.received, 0n);
  assert.equal((await s.lottery.getOwnerTickets(s.player.address)).length, 2);

  // the logs can be public: no address in them
  const all = logs.join("\n").toLowerCase();
  for (const a of [s.player.address, s.vault.target, s.owner.address]) assert.ok(!all.includes(a.toLowerCase().slice(2, 12)), "no address in the logs");

  // ticket 1 wins 30 WAVAX at rank 1
  const t1 = await s.lottery.getTicket(mine[0]);
  const main6 = t1.mainNumbers.slice(0, 6).map(Number);
  const comp2 = t1.compNumbers.slice(0, 2).map(Number);
  const seventh = [...Array(24).keys()].map((i) => i + 1).find((n) => !main6.includes(n));
  const pools = Array(12).fill(0n);
  pools[0] = E("30");
  await s.warp(43200n + 60n);
  await (await s.lottery.setResult(draw1, [...main6, seventh], comp2, pools)).wait();
  const tickets = await Promise.all(mine.map((id) => s.lottery.getTicket(id)));
  const winners = lib.computeWinners(
    { winningMain: [...main6, seventh], winningComp: comp2, rankPools: pools, isRun2: false },
    tickets.map((x) => ({ id: x.id, owner: x.owner, mainNumbers: x.mainNumbers.map(Number), compNumbers: x.compNumbers.map(Number), isSystemPlay: x.isSystemPlay, systemMainCount: x.systemMainCount, systemCompCount: x.systemCompCount }))
  );
  await (await s.lottery.setMerkleRoot(draw1, lib.buildTree(winners).root)).wait();
  await s.warp(16n * 60n);
  await (await s.lottery.createDraw((await s.now()) + 43200n)).wait();

  // next pass: prize claimed and collected by the player wallet, tickets bought for the new
  // draw, and the prize money above the working balance (30 tickets) sent to the vault, where
  // only the owner can withdraw it
  const gross = winners.filter((w) => w.owner === s.player.address).reduce((a, w) => a + w.amount, 0n);
  assert.ok(gross >= E("30"));
  r = await run();
  assert.deepEqual(r.problems, []);
  assert.equal(r.claimed, winners.length);
  assert.equal(r.collected, (gross * 97n) / 100n, "97% after the lottery's fee");
  assert.equal(r.bought, 2n);
  assert.equal(await s.wavax.balanceOf(s.player.address), 28n * E("0.19"), "working balance of 30 tickets kept, 2 of them just bought: the prize is not spent on tickets");
  assert.ok(r.swept > E("23"), `swept ${r.swept}`);
  assert.equal(await s.vault.winnings(), r.swept, "in the vault, outside the ticket budget");
  assert.equal(await s.vault.ticketBudget(), 0n);
  await expectRevert(s.vault.connect(s.player).withdrawWavax(r.swept, s.player.address), sel("OwnableUnauthorizedAccount(address)"));
  // a later pass does not pay it back out to the player
  await s.warp(21n * 3600n);
  await run();
  assert.equal(await s.vault.winnings(), r.swept);
  await (await s.vault.withdrawWavax(r.swept, s.owner.address)).wait();
  assert.equal(await s.wavax.balanceOf(s.owner.address), r.swept);

  // nothing is claimed twice
  r = await run();
  assert.deepEqual(r.problems, []);
  assert.equal(r.claimed, 0);
  assert.equal(r.collected, 0n);
});

test("player bot: pays its own gas from the WAVAX it holds, refuses a wallet that is not the vault's player", async () => {
  const s = await setup({ playerMode: true });
  const cfg = { log: () => {} };
  await expectRevert(runPlayer({ signer: s.stranger, vaultAddress: s.vault.target, cfg }), "not the player");

  // gas below the threshold: part of the WAVAX is unwrapped
  await (await s.wavax.mint(s.player.address, E("2"))).wait();
  const gas = await s.provider.getBalance(s.player.address);
  const r = await runPlayer({ signer: s.player, vaultAddress: s.vault.target, cfg: { ...cfg, minGas: gas + E("1"), gasTopUp: gas + E("1.5") } });
  assert.deepEqual(r.problems, []);
  assert.ok((await s.provider.getBalance(s.player.address)) > gas + E("1.4"));
  assert.ok((await s.wavax.balanceOf(s.player.address)) <= E("0.5"));

  // no WAVAX to convert: reported as a problem, so that the scheduler raises an alert
  const r2 = await runPlayer({ signer: s.player, vaultAddress: s.vault.target, cfg: { ...cfg, minGas: gas + E("100"), gasTopUp: gas + E("200") } });
  assert.equal(r2.lowGas, true);
  assert.ok(r2.problems.some((p) => p.includes("gas too low")));
});

test("keeper: when the price is too far below the reference, the pass is still sent so the reference follows", async () => {
  const s = await setup();
  await s.depositP33(E("5000"));
  await (await s.p33.setRatio(E("1.01"))).wait();
  const t = await s.now();
  await s.warp(t - (t % 604800n) + 604800n + 2n * 86400n - t); // Saturday: sale window
  await (await s.pool.setRate(E("0.010"))).wait();
  const h = await s.vault.harvestable();
  const ref = await s.vault.referencePrice();

  const logs = [];
  const ctx = await makeContext({ signer: s.keeper, lotteryAddress: s.lottery.target, state: {}, cfg: { log: (m) => logs.push(m) } });
  await runVault(ctx, s.vault.target);
  assert.ok(logs.some((l) => l.includes("postponed")), logs.join("\n"));
  assert.equal(await s.vault.harvestable(), h, "nothing sold");
  assert.ok((await s.vault.referencePrice()) < ref, "the reference moved towards the market");
  assert.ok((await s.vault.refTime()) > 0n);
});

test("player bot: a prize whose proof cannot be rebuilt is reported, nothing is sent", async () => {
  const s = await setup({ playerMode: true });
  const cfg = { log: () => {}, ticketsPerDraw: 1n };
  await (await s.wavax.mint(s.player.address, E("1"))).wait();
  const draw1 = await s.openDraw(3600n);
  let r = await runPlayer({ signer: s.player, vaultAddress: s.vault.target, cfg });
  assert.equal(r.bought, 1n);

  const [id] = await s.lottery.getOwnerTickets(s.player.address);
  const t1 = await s.lottery.getTicket(id);
  const main6 = t1.mainNumbers.slice(0, 6).map(Number);
  const seventh = [...Array(24).keys()].map((i) => i + 1).find((n) => !main6.includes(n));
  const pools = Array(12).fill(0n);
  pools[0] = E("5");
  await s.warp(3700n);
  await (await s.lottery.setResult(draw1, [...main6, seventh], t1.compNumbers.slice(0, 2).map(Number), pools)).wait();
  // the lottery's tree gives this ticket another amount than the one the bot recomputes
  const tree = lib.buildTree([{ id, owner: s.player.address, rank: 1, amount: E("4") }]);
  await (await s.lottery.setMerkleRoot(draw1, tree.root)).wait();
  await s.warp(16n * 60n);

  r = await runPlayer({ signer: s.player, vaultAddress: s.vault.target, cfg });
  assert.equal(r.claimed, 0);
  assert.ok(r.problems.some((p) => p.includes("claim it by hand")), JSON.stringify(r.problems));
  assert.equal(await s.lottery.ticketPrizeClaimed(id), false);
});

test("player bot: private recap of a pass, empty when nothing happened", async () => {
  const s = await setup({ playerMode: true });
  const cfg = { log: () => {}, ticketsPerDraw: 2n };
  await (await s.wavax.mint(s.player.address, E("1"))).wait();
  await s.openDraw(3600n);
  let r = await runPlayer({ signer: s.player, vaultAddress: s.vault.target, cfg });
  const text = recap(r);
  assert.match(text, /^p33 vault · player bot\n/);
  assert.match(text, /Tickets: 2 bought at 0\.1900 WAVAX for draw 1 \(2 held\)/);
  assert.match(text, /Player wallet: 0\.6200 WAVAX \(3 ticket\(s\)\), \d+\.\d{4} AVAX for fees/);
  assert.ok(!/0x[0-9a-fA-F]{8}/.test(text), "no address in the recap");

  // second run before the same draw: nothing happened, no message; a manual run reports the state
  r = await runPlayer({ signer: s.player, vaultAddress: s.vault.target, cfg });
  assert.equal(recap(r), "");
  assert.match(recap(r, { always: true }), /Nothing to do on this pass\.\nTickets held for draw 1: 2\nPlayer wallet: 0\.6200 WAVAX/);

  // a problem is always reported
  r = await runPlayer({ signer: s.player, vaultAddress: s.vault.target, cfg: { ...cfg, maxFeeGwei: 0n } });
  assert.match(recap(r), /⚠ network fees unusually high/);
  r = await runPlayer({ signer: s.player, vaultAddress: s.vault.target, cfg: { ...cfg, dryRun: true } });
  assert.match(recap(r, { always: true }), /\(dry run, nothing sent\)/);
});

test("results bot: the latest draw is published once to the Telegram chat, with numbers, winners and the next draw", async () => {
  const http = require("http");
  const { latestExecuted, collect, buildMessage, send } = require("../keeper/announce");
  const s = await setup();
  assert.equal(await latestExecuted(s.lottery), null, "no draw yet");

  // draw 1: two tickets, one of them matches 3 numbers and 1 extra (rank 11)
  await s.openDraw(3600n);
  await (await s.wavax.connect(s.player).approve(s.lottery.target, E("10"))).wait();
  await (await s.lottery.connect(s.player).buyMultipleTickets(1, [[1, 2, 3, 10, 11, 12], [13, 14, 15, 16, 17, 18]], [[1, 2], [4, 5]], [false, false])).wait();
  await s.warp(3700n);
  const pools = Array(12).fill(0n);
  pools[10] = E("0.0199");
  await (await s.lottery.setResult(1, [1, 2, 3, 4, 5, 6, 7], [1, 3], pools)).wait();
  // draw 2 is open, with one ticket
  await (await s.lottery.createDraw(1791223200n + 86400n * 3650n)).wait(); // far in the future, fixed for the text below
  await (await s.lottery.connect(s.player).buyMultipleTickets(2, [[1, 2, 3, 4, 5, 6]], [[1, 2]], [false])).wait();

  const draw = await latestExecuted(s.lottery);
  assert.equal(draw.id, 1n);
  const data = await collect(s.lottery, draw);
  assert.equal(data.sold, 2);
  assert.deepEqual([...data.byRank], [[11, 1]]);
  const fr = buildMessage(data, { lang: "fr", tz: "UTC" });
  assert.match(fr, /^<b>Loterie AVAX, tirage n° 1<\/b>\n/);
  assert.match(fr, /Numéros sortis\n<b>1 {2}2 {2}3 {2}4 {2}5 {2}6 {2}7<\/b> {2}\+ {2}<b>1 {2}3<\/b>/);
  assert.match(fr, /2 tickets joués, 0,3 WAVAX en jeu\.\nGagnants : 1 ticket au rang 11 \(0,019 WAVAX à partager\)\./);
  assert.match(fr, /Prochain tirage .* à 18:00 : 0,15 WAVAX déjà en jeu, ticket à 0,19 WAVAX\.$/);
  const en = buildMessage({ ...data, byRank: new Map(), next: null }, { lang: "en", tz: "UTC" });
  assert.match(en, /No winning ticket: the prizes roll over/);
  assert.match(en, /The next draw is not open yet\.$/);

  // sending: one request to the bot API, with the play button; a refusal is reported without the token
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body: JSON.parse(body) });
      const ok = !req.url.includes("bad");
      res.writeHead(ok ? 200 : 403, { "content-type": "application/json" }).end(JSON.stringify(ok ? { ok: true, result: { chat: { title: "secret name" } } } : { ok: false, description: "Forbidden: bot is not a member of the channel chat" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${server.address().port}`;
  await send({ token: "123:abc", chat: "@results", text: fr, playUrl: "https://example.org/play/", lang: "fr", api });
  assert.equal(seen[0].url, "/bot123:abc/sendMessage");
  assert.equal(seen[0].body.chat_id, "@results");
  assert.equal(seen[0].body.parse_mode, "HTML");
  assert.deepEqual(seen[0].body.reply_markup, { inline_keyboard: [[{ text: "Jouer sur Sixte", url: "https://example.org/play/" }]] });
  await assert.rejects(send({ token: "bad", chat: "@results", text: fr, api }), /Telegram refused the message \(403, Forbidden: bot is not a member/);
  server.close();
});
