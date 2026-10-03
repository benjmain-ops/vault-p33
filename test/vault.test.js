const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { setup, expectRevert, sel, E } = require("./helpers");
const lib = require("../keeper/lib");
const { runVault, makeContext } = require("../keeper/index");

const quiet = { log: () => {} };

test("factory : l'appelant est propriétaire, la factory n'a aucun droit", async () => {
  const s = await setup();
  assert.equal(await s.vault.owner(), s.owner.address);
  assert.equal(await s.vault.keeper(), s.keeper.address);
  assert.equal(await s.factory.vaultCount(), 1n);
  assert.equal(await s.vault.minWavaxPerP33(), E("0.015"));
  assert.equal(await s.vault.maxTicketPrice(), E("0.5"));

  await (await s.factory.connect(s.player).createVault(E("0.015"), E("0.5"), true)).wait();
  const v2 = (await s.factory.vaultsOf(s.player.address))[0];
  assert.notEqual(v2, s.vault.target);
  assert.equal(await new ethers.Contract(v2, s.vault.interface, s.provider).owner(), s.player.address);
});

test("dépôt : le principal est figé en xPHAR, rien à vendre tant que le ratio ne bouge pas", async () => {
  const s = await setup();
  await (await s.p33.setRatio(E("1.25"))).wait();
  await s.depositP33(E("1000"));
  assert.equal(await s.vault.principalAssets(), E("1250"));
  assert.equal(await s.vault.harvestable(), 0n);
});

test("harvest : seul l'excédent est vendu, le principal reste couvert", async () => {
  const s = await setup();
  await s.depositP33(E("1000"));
  await (await s.p33.setRatio(E("1.02"))).wait(); // +2 % sur l'epoch

  const h = await s.vault.harvestable();
  // 1000 xPHAR de principal = 980,39 p33 au nouveau ratio ; excédent ~19,6 p33
  assert.ok(h > E("19.6") && h < E("19.61"), `harvestable=${h}`);

  await expectRevert(s.vault.connect(s.keeper).harvest(h + 1n, 0), sel("ExceedsHarvestable(uint256,uint256)"));
  await (await s.vault.connect(s.keeper).harvest(h, 0)).wait();

  assert.equal(await s.vault.ticketBudget(), (h * E("0.017")) / E("1"));
  assert.equal(await s.wavax.balanceOf(s.vault.target), await s.vault.ticketBudget());
  assert.equal(await s.vault.harvestable(), 0n);
  const left = await s.p33.balanceOf(s.vault.target);
  assert.ok((await s.p33.convertToAssets(left)) >= E("1000"), "le principal doit rester couvert");
});

test("harvest : refusé sous le prix plancher, et sans plancher réglé", async () => {
  const s = await setup();
  await s.depositP33(E("1000"));
  await (await s.p33.setRatio(E("1.02"))).wait();
  const h = await s.vault.harvestable();

  await (await s.router.setRate(E("0.010"))).wait(); // pool manipulé / prix effondré
  await expectRevert(s.vault.connect(s.keeper).harvest(h, 0), "Too little received");
  assert.equal(await s.vault.ticketBudget(), 0n);

  await (await s.vault.setGuards(0, E("0.5"))).wait();
  await expectRevert(s.vault.connect(s.keeper).harvest(h, 0), sel("FloorNotSet()"));
});

test("achat : maximum de tickets que le budget permet, par lots, tickets au nom du vault", async () => {
  const s = await setup();
  await (await s.wavax.mint(s.owner.address, E("20"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("20"))).wait();
  await (await s.vault.fundBudget(E("20"))).wait(); // 20 / 0,19 = 105 tickets
  const drawId = await s.openDraw();

  const k = s.vault.connect(s.keeper);
  await (await k.buyTickets(1000)).wait(); // plafonné à 50
  await (await k.buyTickets(1000)).wait();
  await (await k.buyTickets(1000)).wait(); // les 5 derniers
  await expectRevert(k.buyTickets(1000), sel("NothingToBuy()"));

  const ids = await s.lottery.getOwnerTickets(s.vault.target);
  assert.equal(ids.length, 105);
  assert.equal((await s.lottery.getTicket(ids[0])).drawId, drawId);
  assert.equal(await s.vault.ticketBudget(), E("20") - 105n * E("0.19"));
  assert.equal(await s.wavax.allowance(s.vault.target, s.lottery.target), 0n);
});

test("achat : refusé si le prix du ticket dépasse le plafond, si la loterie est en pause, si le tirage est clos", async () => {
  const s = await setup();
  await (await s.wavax.mint(s.owner.address, E("5"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("5"))).wait();
  await (await s.vault.fundBudget(E("5"))).wait();
  await s.openDraw(3600n);
  const k = s.vault.connect(s.keeper);

  await (await s.lottery.setTicketPrice(E("5"))).wait(); // clé du poller compromise
  await expectRevert(k.buyTickets(10), sel("TicketPriceTooHigh(uint256,uint256)"));
  await (await s.lottery.setTicketPrice(E("0.19"))).wait();

  await (await s.lottery.setPaused(true)).wait();
  await expectRevert(k.buyTickets(10), "EnforcedPause");
  await (await s.lottery.setPaused(false)).wait();

  await s.warp(3700n);
  await expectRevert(k.buyTickets(10), "E27");
  assert.equal(await s.vault.ticketBudget(), E("5"));
});

test("droits : le keeper ne peut rien retirer, un inconnu ne peut rien déclencher", async () => {
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

test("retraits : le propriétaire récupère son p33 et son WAVAX à tout moment", async () => {
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

test("rangs : table identique à PartnerLotteryCore", () => {
  const expected = { "6,2": 1, "6,1": 2, "6,0": 3, "5,2": 4, "5,1": 5, "5,0": 6, "4,2": 7, "4,1": 8, "4,0": 9, "3,2": 10, "3,1": 11, "3,0": 12, "2,2": 0, "0,0": 0 };
  for (const [k, r] of Object.entries(expected)) {
    const [m, c] = k.split(",").map(Number);
    assert.equal(lib.getRank(m, c, false), r, k);
  }
  assert.equal(lib.getRank(6, 2, true), 0); // R1 supprimé en Run 2
  assert.equal(lib.getRank(6, 1, true), 2);
});

test("fenêtre de harvest : fermée du jeudi 00:00 au vendredi 01:00 UTC", () => {
  const thu = 1791417600n; // jeudi 2026-10-08 00:00 UTC
  assert.equal(thu % 604800n, 0n);
  assert.equal(lib.inHarvestWindow(thu + 3600n), false); // jeudi 01:00, rachat en cours
  assert.equal(lib.inHarvestWindow(thu + 86400n + 1800n), false); // vendredi 00:30, marge
  assert.equal(lib.inHarvestWindow(thu + 86400n + 3600n), true); // vendredi 01:00
  assert.equal(lib.inHarvestWindow(thu + 6n * 86400n), true); // mercredi 00:00
  assert.equal(lib.inHarvestWindow(thu + 604800n - 3600n), false); // 1 h avant le flip
});

test("cycle complet par le keeper : harvest, achat, tirage, preuves Merkle, encaissement à 97 %", async () => {
  const s = await setup();
  await s.depositP33(E("5000"));
  await (await s.p33.setRatio(E("1.01"))).wait(); // ~49,5 p33 de rendement -> ~0,84 WAVAX -> 4 tickets
  const drawId = await s.openDraw();

  // se placer dans la fenêtre de harvest (samedi), quel que soit le jour d'exécution du test
  const t = await s.now();
  const target = t - (t % 604800n) + 604800n + 2n * 86400n;
  await (await s.lottery.createDraw(target + 86400n)).wait(); // tirage ouvert après le saut
  const draw2 = await s.lottery.currentDrawId();
  assert.equal(draw2, drawId + 1n);
  await s.warp(target - t);

  const state = {};
  let ctx = await makeContext({ signer: s.keeper, lotteryAddress: s.lottery.target, state, cfg: quiet });
  await runVault(ctx, s.vault.target);

  const mine = await s.lottery.getOwnerTickets(s.vault.target);
  assert.equal(mine.length, 4, "4 tickets achetés avec le rendement");
  assert.ok((await s.vault.ticketBudget()) < E("0.19"), "budget dépensé au maximum");
  assert.ok((await s.p33.convertToAssets(await s.p33.balanceOf(s.vault.target))) >= E("5000"), "principal intact");

  // un autre joueur prend la même grille que le ticket 1 du vault : le rang 1 sera partagé en deux
  const t1 = await s.lottery.getTicket(mine[0]);
  const main6 = t1.mainNumbers.slice(0, 6).map(Number);
  const comp2 = t1.compNumbers.slice(0, 2).map(Number);
  await (await s.wavax.connect(s.player).approve(s.lottery.target, E("1"))).wait();
  await (await s.lottery.connect(s.player).buyMultipleTickets(draw2, [main6], [comp2], [false])).wait();

  // tirage : les 6 numéros du ticket 1 + un 7e, et ses 2 complémentaires
  const seventh = [...Array(24).keys()].map((i) => i + 1).find((n) => !main6.includes(n));
  const pools = Array(12).fill(E("1"));
  pools[0] = E("10");
  await s.warp(86400n + 60n);
  await (await s.lottery.setResult(draw2, [...main6, seventh], comp2, pools)).wait();

  // la racine officielle est calculée ici avec la même bibliothèque que le keeper
  const allIds = await s.lottery.getDrawTickets(draw2);
  const tickets = await Promise.all(allIds.map((id) => s.lottery.getTicket(id)));
  const winners = lib.computeWinners(
    { winningMain: [...main6, seventh], winningComp: comp2, rankPools: pools, isRun2: false },
    tickets.map((x) => ({ id: x.id, owner: x.owner, mainNumbers: x.mainNumbers.map(Number), compNumbers: x.compNumbers.map(Number), isSystemPlay: x.isSystemPlay, systemMainCount: x.systemMainCount, systemCompCount: x.systemCompCount }))
  );
  const jackpot = winners.find((w) => w.id === mine[0]);
  assert.equal(jackpot.rank, 1);
  assert.equal(jackpot.amount, E("5"), "jackpot de 10 partagé entre deux grilles");
  const tree = lib.buildTree(winners);
  await (await s.lottery.setMerkleRoot(draw2, tree.root)).wait();

  // avant les 15 minutes : le keeper attend, rien n'est réclamé
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
  assert.equal((await s.wavax.balanceOf(s.vault.target)) - balBefore, net, "97 % des gains reçus");
  assert.equal(await s.vault.ticketBudget(), budgetBefore, "gains non rejoués par défaut");
  assert.equal(await s.vault.winnings(), net);
  assert.equal(await s.lottery.claimable(s.vault.target), 0n);
  assert.ok(state[s.vault.target.toLowerCase()].doneDraws.includes(draw2.toString()));

  // le propriétaire sort ses gains
  const ob = await s.wavax.balanceOf(s.owner.address);
  await (await s.vault.withdrawWavax(net, s.owner.address)).wait();
  assert.equal((await s.wavax.balanceOf(s.owner.address)) - ob, net);
  assert.equal(await s.vault.ticketBudget(), budgetBefore);
});

test("gains rejoués quand reinvestWinnings est activé", async () => {
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

test("keeper : racine on-chain différente du recalcul -> rien n'est envoyé", async () => {
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
  await (await s.lottery.setMerkleRoot(drawId, ethers.id("autre convention de calcul"))).wait();
  await s.warp(16n * 60n);

  const logs = [];
  const state = {};
  const ctx = await makeContext({ signer: s.keeper, lotteryAddress: s.lottery.target, state, cfg: { log: (m) => logs.push(m) } });
  await runVault(ctx, s.vault.target);
  assert.equal(await s.lottery.ticketPrizeClaimed(id), false);
  assert.ok(logs.some((l) => l.includes("racine recalculée différente")));
  assert.equal(state[s.vault.target.toLowerCase()].doneDraws.length, 0, "le tirage reste à traiter");
});

test("cycle : une seule transaction encaisse les gains, vend le rendement et achète les tickets", async () => {
  const s = await setup();
  const k = s.vault.connect(s.keeper);
  const MAX = ethers.MaxUint256;
  await s.depositP33(E("5000"));
  await (await s.p33.setRatio(E("1.01"))).wait();
  const draw1 = await s.openDraw(3600n);

  // 1er cycle : vente + achat, rien à réclamer
  let rc = await (await k.cycle(MAX, 0, 50, [], [], [], [])).wait();
  const names = (r) => r.logs.map((l) => { try { return s.vault.interface.parseLog(l)?.name; } catch { return null; } }).filter(Boolean);
  assert.deepEqual(names(rc), ["Harvested", "TicketsBought"]);
  const mine = await s.lottery.getOwnerTickets(s.vault.target);
  assert.equal(mine.length, 4);

  // le ticket 1 gagne le rang 1 ; nouveau tirage ouvert ; le ratio remonte
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

  // 2e cycle : réclamation + encaissement + vente + achat, toujours une transaction
  const p = lib.proofsFor(tree, s.vault.target)[0];
  rc = await (await k.cycle(MAX, 0, 50, [p.id], [p.rank], [p.amount], [p.proof])).wait();
  assert.deepEqual(names(rc), ["PrizesClaimed", "WinningsCollected", "Harvested", "TicketsBought"]);
  assert.equal(await s.vault.winnings(), E("2.91"), "3 WAVAX moins 3 % de frais, mis de côté");
  assert.ok((await s.lottery.getOwnerTickets(s.vault.target)).length > 4);
  assert.ok((await s.p33.convertToAssets(await s.p33.balanceOf(s.vault.target))) >= E("5000"), "principal intact");

  await expectRevert(s.vault.connect(s.stranger).cycle(MAX, 0, 50, [], [], [], []), sel("NotOperator()"));
});

test("cycle : une étape impossible est sautée sans bloquer les autres", async () => {
  const s = await setup();
  const k = s.vault.connect(s.keeper);
  const MAX = ethers.MaxUint256;
  await s.depositP33(E("1000"));
  await (await s.p33.setRatio(E("1.02"))).wait();
  await (await s.wavax.mint(s.owner.address, E("1"))).wait();
  await (await s.wavax.connect(s.owner).approve(s.vault.target, E("1"))).wait();
  await (await s.vault.fundBudget(E("1"))).wait();
  const h = await s.vault.harvestable();

  // cours sous le plancher ET aucun tirage ouvert : rien ne bouge, rien n'échoue
  await (await s.router.setRate(E("0.010"))).wait();
  await (await k.cycle(MAX, 0, 50, [], [], [], [])).wait();
  assert.equal(await s.vault.harvestable(), h);
  assert.equal(await s.vault.ticketBudget(), E("1"));
  assert.equal(await s.p33.allowance(s.vault.target, s.router.target), 0n);
  assert.equal(await s.wavax.allowance(s.vault.target, s.lottery.target), 0n);

  // tirage ouvert, cours toujours trop bas : l'achat se fait, la vente attend
  await s.openDraw(3600n);
  await (await k.cycle(MAX, 0, 50, [], [], [], [])).wait();
  assert.equal(await s.vault.harvestable(), h, "rendement conservé pour plus tard");
  assert.equal((await s.lottery.getOwnerTickets(s.vault.target)).length, 5);

  // cours revenu, loterie en pause : la vente se fait, l'achat attend
  await (await s.router.setRate(E("0.017"))).wait();
  await (await s.lottery.setPaused(true)).wait();
  const before = await s.vault.ticketBudget();
  await (await k.cycle(MAX, 0, 50, [], [], [], [])).wait();
  assert.equal(await s.vault.harvestable(), 0n);
  assert.equal((await s.vault.ticketBudget()) - before, (h * E("0.017")) / E("1"));
  assert.equal((await s.lottery.getOwnerTickets(s.vault.target)).length, 5);
});
