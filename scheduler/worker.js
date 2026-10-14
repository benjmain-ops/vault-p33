/**
 * Starts the bots on time. GitHub's own scheduler starts scheduled workflows hours late on a
 * busy day; this Cloudflare Worker has cron triggers that fire on the minute, and each one asks
 * GitHub to run a workflow now (the same thing as the "Run workflow" button).
 *
 * Settings: GH_REPO ("owner/name", in wrangler.toml) and the secret GH_TOKEN, a fine-grained
 * GitHub token limited to that repository with the permission "Actions: read and write".
 * The workflows keep their own safeguards: a draw is published once, a teaser is posted once.
 *
 * It also watches the bingo every minute and sends a Telegram message when a round opens for
 * sale and when its draw starts (secrets BINGO_BOT_TOKEN and BINGO_CHAT; BINGO_URL in vars).
 * Stateless: each run looks at the events of the minute just ended, so nothing is sent twice.
 */
const BINGO = "0xeE23eEcA4C3876bB3729E1d0f508920d3A8B4D4F"; // BingoGameEngine, Avalanche C-Chain
const RPC = "https://api.avax.network/ext/bc/C/rpc";
// keccak256 of the event signatures: RoundCreated(uint256,uint256), DrawOrderRevealed(uint256)
const TOPICS = {
  "0xe934619c48e1b0b21b662adf6b7c08ad37e6f0d120f40a505503b4fd3bcfec58": "opened",
  "0xdc2d5ab4e78c15b262f67835bab28c885f4710ad88d1ac9c5268bf3082e275e1": "drawing",
};
const BINGO_CRON = "* * * * *";
const SCHEDULE = {
  // tickets, two to three hours before each draw ("scheduled": no recap when nothing happened)
  "13 3,4,15,16 * * *": { workflow: "play.yml", inputs: { scheduled: "true" } },
  "30,44 5,17 * * *": { workflow: "teaser.yml" },   // the film, half an hour before
  "1,5,35 6,18 * * *": { workflow: "results.yml" }, // the result, right after
};

async function start({ workflow, inputs }, env) {
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "lottery-scheduler", "content-type": "application/json" },
    body: JSON.stringify({ ref: env.GH_REF || "main", ...(inputs ? { inputs } : {}) }),
  });
  // GitHub answers 204 with no body. Its error text can name the repository: only the status is kept.
  if (!res.ok) throw new Error(`GitHub refused to start ${workflow} (${res.status})`);
}

async function rpc(method, params, url = RPC) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error("rpc: " + j.error.message);
  return j.result;
}

/** The bingo events of the minute that ended at `until` (unix seconds): [{ kind, roundId }]. */
async function bingoEvents(until, env) {
  const url = env.RPC_URL || RPC;
  const latest = await rpc("eth_getBlockByNumber", ["latest", false], url);
  const head = Number(latest.number);
  // about one block every 2 s: 90 blocks cover the minute and some slack
  const logs = await rpc("eth_getLogs", [{ address: env.BINGO || BINGO, fromBlock: "0x" + Math.max(0, head - 90).toString(16), toBlock: "0x" + head.toString(16), topics: [Object.keys(TOPICS)] }], url);
  const out = [];
  const times = new Map();
  for (const log of logs) {
    if (!times.has(log.blockNumber)) times.set(log.blockNumber, Number((await rpc("eth_getBlockByNumber", [log.blockNumber, false], url)).timestamp));
    const t = times.get(log.blockNumber);
    if (t < until - 60 || t >= until) continue;
    out.push({ kind: TOPICS[log.topics[0]], roundId: BigInt(log.topics[1]).toString() });
  }
  return out;
}

const BINGO_TEXT = {
  fr: { opened: (n, url) => `🟢 Bingo : la manche n° ${n} est ouverte, les grilles sont en vente.`, drawing: (n, url) => `🔴 Bingo : le tirage de la manche n° ${n} commence maintenant.` },
  en: { opened: (n, url) => `🟢 Bingo: round no. ${n} is open, grids are on sale.`, drawing: (n, url) => `🔴 Bingo: the draw of round no. ${n} starts now.` },
};

async function tellBingo(events, env) {
  if (!env.BINGO_BOT_TOKEN || !env.BINGO_CHAT) return;
  const L = BINGO_TEXT[env.BINGO_LANG === "fr" ? "fr" : "en"];
  const url = env.BINGO_URL || "";
  for (const e of events) {
    const body = { chat_id: env.BINGO_CHAT, text: L[e.kind](e.roundId, url), link_preview_options: { is_disabled: true } };
    if (url) body.reply_markup = { inline_keyboard: [[{ text: e.kind === "drawing" ? "▶ Live" : "Open", url }]] };
    const res = await fetch(`https://api.telegram.org/bot${env.BINGO_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Telegram refused the bingo message (${res.status})`);
  }
}

export default {
  async scheduled(event, env) {
    if (event.cron === BINGO_CRON) {
      // the minute that just ended, by the schedule's own clock: no overlap between runs
      const until = Math.floor(event.scheduledTime / 1000);
      return tellBingo(await bingoEvents(until, env), env);
    }
    const job = SCHEDULE[event.cron];
    if (!job) throw new Error("no workflow for this schedule: " + event.cron);
    await start(job, env);
  },
  // nothing is served: the worker only exists for its schedule
  fetch() { return new Response("", { status: 404 }); },
};
export { SCHEDULE, BINGO_CRON, bingoEvents, tellBingo, TOPICS };
