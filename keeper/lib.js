// Logique pure du keeper : rangs, répartition des cagnottes, arbre Merkle, fenêtre de harvest.
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");

const WEEK = 604800n;
const DAY = 86400n;

/** Table des rangs de PartnerLotteryCore._getRank : R1 = 6+2 ... R12 = 3+0. */
function getRank(mainMatches, compMatches, isRun2) {
  if (mainMatches < 3) return 0;
  const rank = (6 - mainMatches) * 3 + (2 - compMatches) + 1;
  if (isRun2 && rank === 1) return 0;
  return rank;
}

function combinations(arr, k) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === k) return out.push(cur.slice());
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i]);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return out;
}

/**
 * Recalcule les gagnants d'un tirage à partir des données on-chain.
 *
 * @param draw    { winningMain: number[7], winningComp: number[2], rankPools: bigint[12], isRun2 }
 *                lu APRÈS la pose de la racine (les rangs non gagnés y sont déjà remis à zéro).
 * @param tickets [{ id: bigint, owner, mainNumbers: number[9], compNumbers: number[3],
 *                   isSystemPlay, systemMainCount, systemCompCount }]
 * @returns [{ id, owner, rank, amount }] pour les tickets dont le gain est > 0.
 *
 * HYPOTHÈSES (le calcul officiel est fait hors chaîne par le poller de BCM, non publié) :
 *  - la cagnotte d'un rang est divisée à parts égales entre les grilles gagnantes du rang ;
 *  - un ticket « system play » compte pour chacune de ses combinaisons ; sa feuille porte
 *    son meilleur rang et la somme de ses parts.
 * Le keeper compare toujours la racine recalculée à la racine on-chain avant de réclamer :
 * si une hypothèse est fausse, il s'arrête sans rien envoyer.
 */
function computeWinners(draw, tickets) {
  const winMain = new Set(draw.winningMain.map(Number));
  const winComp = new Set(draw.winningComp.map(Number));
  const counts = new Array(13).fill(0n);
  const perTicket = [];

  for (const t of tickets) {
    const mains = t.mainNumbers.slice(0, Number(t.systemMainCount)).map(Number);
    const comps = t.compNumbers.slice(0, Number(t.systemCompCount)).map(Number);
    const hits = new Map();
    const mainCombos = t.isSystemPlay ? combinations(mains, 6) : [mains];
    const compCombos = t.isSystemPlay ? combinations(comps, 2) : [comps];
    for (const mc of mainCombos) {
      const m = mc.filter((n) => winMain.has(n)).length;
      for (const cc of compCombos) {
        const c = cc.filter((n) => winComp.has(n)).length;
        const rank = getRank(m, c, draw.isRun2);
        if (rank) hits.set(rank, (hits.get(rank) || 0n) + 1n);
      }
    }
    for (const [rank, n] of hits) counts[rank] += n;
    if (hits.size) perTicket.push({ t, hits });
  }

  const winners = [];
  for (const { t, hits } of perTicket) {
    let amount = 0n;
    let best = 13;
    for (const [rank, n] of hits) {
      amount += (BigInt(draw.rankPools[rank - 1]) / counts[rank]) * n;
      if (rank < best) best = rank;
    }
    if (amount > 0n) winners.push({ id: BigInt(t.id), owner: t.owner, rank: best, amount });
  }
  return winners;
}

/** Arbre au format attendu par claimTicketPrize : feuille = (ticketId, owner, rank, amount). */
function buildTree(winners) {
  if (!winners.length) return null;
  return StandardMerkleTree.of(
    winners.map((w) => [w.id, w.owner, w.rank, w.amount]),
    ["uint256", "address", "uint8", "uint256"]
  );
}

/** Preuves pour les tickets appartenant à `owner`. */
function proofsFor(tree, owner) {
  const out = [];
  if (!tree) return out;
  for (const [i, v] of tree.entries()) {
    if (v[1].toLowerCase() === owner.toLowerCase()) {
      out.push({ id: BigInt(v[0]), rank: Number(v[2]), amount: BigInt(v[3]), proof: tree.getProof(i) });
    }
  }
  return out;
}

/**
 * Fenêtre de harvest. Les epochs Pharaoh basculent le jeudi 00:00 UTC (l'epoch Unix a
 * commencé un jeudi) ; le ratio p33 monte pendant les 24 h de rachat TWAP qui suivent.
 * On ne vend donc qu'à partir du vendredi 00:00 UTC, plus une marge.
 */
function inHarvestWindow(timestamp, marginSeconds = 3600n) {
  const sinceFlip = BigInt(timestamp) % WEEK;
  return sinceFlip >= DAY + BigInt(marginSeconds) && sinceFlip < WEEK - 2n * 3600n;
}

const ZERO_ROOT = "0x" + "0".repeat(64);
const SENTINEL_ROOT = "0x" + "0".repeat(63) + "1"; // tirage déclaré sans gagnant
const CLAIM_DELAY = 15n * 60n;

/** Lit un tirage complet et reconstruit son arbre Merkle. null si la racine ne correspond pas. */
async function loadDrawTree(lottery, drawId, draw) {
  const ids = await lottery.getDrawTickets(drawId);
  const tickets = [];
  for (let i = 0; i < ids.length; i += 25) {
    tickets.push(...(await Promise.all(ids.slice(i, i + 25).map((id) => lottery.getTicket(id)))));
  }
  const winners = computeWinners(
    {
      winningMain: Array.from(draw.winningMain, Number),
      winningComp: Array.from(draw.winningComp, Number),
      rankPools: Array.from(draw.rankPools),
      isRun2: draw.isRun2,
    },
    tickets.map((t) => ({
      id: t.id,
      owner: t.owner,
      mainNumbers: Array.from(t.mainNumbers, Number),
      compNumbers: Array.from(t.compNumbers, Number),
      isSystemPlay: t.isSystemPlay,
      systemMainCount: t.systemMainCount,
      systemCompCount: t.systemCompCount,
    }))
  );
  const tree = buildTree(winners);
  if (!tree || tree.root.toLowerCase() !== draw.merkleRoot.toLowerCase()) return null;
  return tree;
}

/**
 * Tickets gagnants de `owner` à réclamer.
 * @param lottery contrat ethers de la loterie (lecture)
 * @param done    Set des tirages déjà traités (chaînes)
 * @returns { claims: [{id, rank, amount, proof}], resolved: [tirages à marquer traités], mismatched: [tirages dont la racine diffère] }
 */
async function planClaims({ lottery, owner, now, done = new Set(), trees = new Map(), lookback = 2000, log = () => {} }) {
  const claims = [];
  const resolved = [];
  const mismatched = [];
  const ids = Array.from(await lottery.getOwnerTickets(owner)).slice(-lookback);
  const draws = new Set();
  for (let i = 0; i < ids.length; i += 25) {
    const batch = await Promise.all(ids.slice(i, i + 25).map((id) => lottery.getTicket(id)));
    for (const t of batch) if (!done.has(t.drawId.toString())) draws.add(t.drawId);
  }

  for (const drawId of draws) {
    const key = drawId.toString();
    const draw = await lottery.getDraw(drawId);
    if (!draw.finalized || draw.merkleRoot === ZERO_ROOT) continue; // pas encore résolu
    if (draw.merkleRoot === SENTINEL_ROOT) {
      resolved.push(key);
      continue;
    }
    if (BigInt(now) < (await lottery.rootPoseA(drawId)) + CLAIM_DELAY) continue;

    if (!trees.has(key)) trees.set(key, await loadDrawTree(lottery, drawId, draw));
    const tree = trees.get(key);
    if (!tree) {
      mismatched.push(key);
      log(`  gains: tirage ${key} — racine recalculée différente de la racine on-chain, rien n'est envoyé. À traiter à la main.`);
      continue;
    }
    const mine = [];
    for (const p of proofsFor(tree, owner)) if (!(await lottery.ticketPrizeClaimed(p.id))) mine.push(p);
    if (mine.length) {
      const sum = mine.reduce((a, p) => a + p.amount, 0n);
      log(`  gains: tirage ${key} — ${mine.length} ticket(s) gagnant(s), ${sum} wei brut`);
      claims.push(...mine);
    }
    resolved.push(key);
  }
  return { claims, resolved, mismatched };
}

module.exports = { getRank, combinations, computeWinners, buildTree, proofsFor, inHarvestWindow, loadDrawTree, planClaims };
