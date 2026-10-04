// Pure keeper logic: ranks, prize pool distribution, Merkle tree, harvest window.
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");

const WEEK = 604800n;
const DAY = 86400n;

/** Rank table of PartnerLotteryCore._getRank: R1 = 6+2 ... R12 = 3+0. */
function getRank(mainMatches, compMatches, isRun2) {
  if (mainMatches < 3) return 0;
  const rank = (6 - mainMatches) * 3 + (2 - compMatches) + 1;
  if (isRun2 && rank === 1) return 0;
  return rank;
}

/** Main numbers actually played by a ticket: 6 for an ordinary ticket, more for a system play. */
function playedMains(t) {
  return Array.from(t.mainNumbers, Number).slice(0, t.isSystemPlay ? Number(t.systemMainCount) : 6);
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
 * Recomputes the winners of a draw from on-chain data.
 *
 * @param draw    { winningMain: number[7], winningComp: number[2], rankPools: bigint[12], isRun2 }
 *                read AFTER the root has been set (ranks nobody won are already zeroed in it).
 * @param tickets [{ id: bigint, owner, mainNumbers: number[9], compNumbers: number[3],
 *                   isSystemPlay, systemMainCount, systemCompCount }]
 * @returns [{ id, owner, rank, amount }] for the tickets whose prize is > 0.
 *
 * ASSUMPTIONS (the official computation is done off-chain by BCM's poller, which is not published):
 *  - a rank's prize pool is split equally between the winning lines of that rank;
 *  - a "system play" ticket counts once for each of its combinations; its leaf carries
 *    its best rank and the sum of its shares.
 * The keeper always compares the recomputed root to the on-chain root before claiming:
 * if an assumption is wrong, it stops without sending anything.
 */
function computeWinners(draw, tickets) {
  const winMain = new Set(draw.winningMain.map(Number));
  const winComp = new Set(draw.winningComp.map(Number));
  const counts = new Array(13).fill(0n);
  const perTicket = [];

  for (const t of tickets) {
    const mains = playedMains(t);
    const comps = t.compNumbers.slice(0, t.isSystemPlay ? Number(t.systemCompCount) : 2).map(Number);
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

/** Tree in the format expected by claimTicketPrize: leaf = (ticketId, owner, rank, amount). */
function buildTree(winners) {
  if (!winners.length) return null;
  return StandardMerkleTree.of(
    winners.map((w) => [w.id, w.owner, w.rank, w.amount]),
    ["uint256", "address", "uint8", "uint256"]
  );
}

/** Proofs for the tickets belonging to `owner`. */
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
 * Harvest window. Pharaoh epochs flip on Thursday 00:00 UTC (the Unix epoch
 * started on a Thursday). The p33 ratio then rises in steps: measured on chain for the
 * 2026-09-24 epoch, the buyback ran about 26 h and a last step landed on Friday 19:15 UTC,
 * after which the ratio stayed flat. So we only sell from Saturday 00:00 UTC (flip + 48 h),
 * to sell a complete week of yield in one go.
 */
function inHarvestWindow(timestamp, marginSeconds = 0n) {
  const sinceFlip = BigInt(timestamp) % WEEK;
  return sinceFlip >= 2n * DAY + BigInt(marginSeconds) && sinceFlip < WEEK - 2n * 3600n;
}

const ZERO_ROOT = "0x" + "0".repeat(64);
const SENTINEL_ROOT = "0x" + "0".repeat(63) + "1"; // draw declared with no winner
const CLAIM_DELAY = 15n * 60n;

/**
 * Reads a full draw and rebuilds its Merkle tree.
 * @returns { tree, winners } — tree is null if the recomputed root does not match the on-chain one.
 */
async function loadDraw(lottery, drawId, draw) {
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
  if (!tree || tree.root.toLowerCase() !== draw.merkleRoot.toLowerCase()) return { tree: null, winners };
  return { tree, winners };
}

/** Same, returning only the tree (null if the root does not match). */
async function loadDrawTree(lottery, drawId, draw) {
  return (await loadDraw(lottery, drawId, draw)).tree;
}

/**
 * Winning tickets of `owner` to claim.
 * @param lottery ethers contract of the lottery (read-only)
 * @param done    Set of the draws already processed (strings)
 * @param minDrawId draws before this one are ignored (bounds the work of a stateless caller)
 * @returns { claims: [{id, rank, amount, proof}], resolved: [draws to mark as processed],
 *            mismatched: [draws whose root differs],
 *            mismatchedMine: [those where the recomputation finds a prize for `owner`] }
 */
async function planClaims({ lottery, owner, now, done = new Set(), trees = new Map(), lookback = 2000, minDrawId = 0n, log = () => {} }) {
  const claims = [];
  const resolved = [];
  const mismatched = [];
  const mismatchedMine = [];
  const ids = Array.from(await lottery.getOwnerTickets(owner)).slice(-lookback);
  const draws = new Map(); // drawId -> the owner's tickets in that draw
  for (let i = 0; i < ids.length; i += 25) {
    const batch = await Promise.all(ids.slice(i, i + 25).map((id) => lottery.getTicket(id)));
    for (const t of batch) {
      if (t.drawId < BigInt(minDrawId) || done.has(t.drawId.toString())) continue;
      if (!draws.has(t.drawId)) draws.set(t.drawId, []);
      draws.get(t.drawId).push(t);
    }
  }

  for (const [drawId, own] of draws) {
    const key = drawId.toString();
    const draw = await lottery.getDraw(drawId);
    if (!draw.finalized || draw.merkleRoot === ZERO_ROOT) continue; // not resolved yet
    if (draw.merkleRoot === SENTINEL_ROOT) {
      resolved.push(key);
      continue;
    }
    // No rank exists below 3 main numbers: if none of the owner's tickets reaches that, there
    // is nothing to claim and the rest of the draw does not need to be read.
    const winMain = new Set(Array.from(draw.winningMain, Number));
    const candidate = own.some((t) => playedMains(t).filter((n) => winMain.has(n)).length >= 3);
    if (!candidate) {
      resolved.push(key);
      continue;
    }
    if (BigInt(now) < (await lottery.rootPoseA(drawId)) + CLAIM_DELAY) continue;

    if (!trees.has(key)) trees.set(key, await loadDraw(lottery, drawId, draw));
    const { tree, winners } = trees.get(key);
    if (!tree) {
      mismatched.push(key);
      if (winners.some((w) => w.owner.toLowerCase() === owner.toLowerCase())) mismatchedMine.push(key);
      log(`  winnings: draw ${key} — recomputed root differs from the on-chain root, nothing is sent. Handle manually.`);
      continue;
    }
    const mine = [];
    for (const p of proofsFor(tree, owner)) if (!(await lottery.ticketPrizeClaimed(p.id))) mine.push(p);
    if (mine.length) {
      log(`  winnings: draw ${key} — ${mine.length} winning ticket(s)`);
      claims.push(...mine);
    }
    resolved.push(key);
  }
  return { claims, resolved, mismatched, mismatchedMine };
}

module.exports = { getRank, combinations, computeWinners, buildTree, proofsFor, inHarvestWindow, loadDraw, loadDrawTree, planClaims };
