const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { setup, expectRevert, sel, E } = require("./helpers");
const lib = require("../keeper/lib");
const { runVault, makeContext } = require("../keeper/index");

const quiet = { log: () => {} };

test("factory: the caller is the owner, the factory has no rights", async () => {
  const s = await setup();
  assert.equal(await s.vault.owner(), s.owner.address);
  assert.equal(await s.vault.keeper(), s.keeper.address);
  assert.equal(await s.vault.pool(), s.pool.target);
  assert.equal(await s.factory.vaultCount(), 1n);
  assert.equal(await s.vault.minWavaxPerP33(), E("0.015"));
  assert.equal(await s.vault.maxTicketPrice(), E("0.5"));

  await (await s.factory.connect(s.player).createVault(E("0.015"), E("0.5"), E("1"))).wait();
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

test("harvest: rejected below the floor price, and when no floor price is set", async () => {
  const s = await setup();
  await s.depositP33(E("1000"));
  await (await s.p33.setRatio(E("1.02"))).wait();
  const h = await s.vault.harvestable();

  await (await s.pool.setRate(E("0.010"))).wait(); // pool manipulated / price collapsed
  await expectRevert(s.vault.connect(s.keeper).harvest(h, 0), sel("Slippage(uint256,uint256)"));
  assert.equal(await s.p33.balanceOf(s.pool.target), 0n, "the p33 did not stay in the pool");
  assert.equal(await s.vault.ticketBudget(), 0n);

  await (await s.vault.setGuards(0, E("0.5"))).wait();
  await expectRevert(s.vault.connect(s.keeper).harvest(h, 0), sel("FloorNotSet()"));
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
  await expectRevert(k.setGuards(1, 1), unauthorized);
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

test("harvest window: closed from Thursday 00:00 to Friday 01:00 UTC", () => {
  const thu = 1791417600n; // Thursday 2026-10-08 00:00 UTC
  assert.equal(thu % 604800n, 0n);
  assert.equal(lib.inHarvestWindow(thu + 3600n), false); // Thursday 01:00, buyback in progress
  assert.equal(lib.inHarvestWindow(thu + 86400n + 1800n), false); // Friday 00:30, margin
  assert.equal(lib.inHarvestWindow(thu + 86400n + 3600n), true); // Friday 01:00
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
  assert.deepEqual(names(rc), ["Harvested", "TicketsBought"]);
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
  await s.warp(16n * 60n);
  await s.openDraw(3600n);
  await (await s.p33.setRatio(E("1.02"))).wait();

  // 2nd cycle: claim + collection + sale + purchase, still a single transaction
  const p = lib.proofsFor(tree, s.vault.target)[0];
  rc = await (await k.cycle(MAX, 0, 50, [p.id], [p.rank], [p.amount], [p.proof])).wait();
  assert.deepEqual(names(rc), ["PrizesClaimed", "WinningsCollected", "Harvested", "TicketsBought"]);
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
  await expectRevert(s.vault.setGuards(ethers.MaxUint256, E("0.5")), sel("GuardTooHigh()"));

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
