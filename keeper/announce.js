#!/usr/bin/env node
/**
 * Results bot: publishes the result of the latest draw of the AVAX lottery to a Telegram chat.
 *
 *   node keeper/announce.js latest        prints the number of the latest draw that was executed
 *   node keeper/announce.js post [id]     publishes that draw (DRY_RUN=1 prints the message instead)
 *
 * Read-only on the chain: no wallet, no key. It needs a Telegram bot that is allowed to post in
 * the chat (ANNOUNCE_BOT_TOKEN) and the chat itself (ANNOUNCE_CHAT: "@channel" or a numeric id).
 */
const fs = require("fs");
const { ethers } = require("ethers");
const lib = require("./lib");

const LOTTERY = "0xB49a551aecD96b60a121Fc9996C2812e9BF95186"; // PartnerLotteryCore, Avalanche C-Chain
const RPC_URLS = ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"];
const LOTTERY_ABI = [
  "function ticketPrice() view returns (uint256)",
  "function currentDrawId() view returns (uint256)",
  "function getDrawTickets(uint256) view returns (uint256[])",
  "function getDraw(uint256) view returns (tuple(uint256 id,uint256 scheduledTime,uint256 drawnAt,uint8[7] winningMain,uint8[2] winningComp,uint256 prizePool,uint256[12] rankPools,uint256 drawVolume,bool isRun2,bool finalized,bool hasRank1Winner,bytes32 merkleRoot))",
  "function getTicket(uint256) view returns (tuple(uint256 id,uint256 drawId,address owner,uint8[9] mainNumbers,uint8[3] compNumbers,bool isSystemPlay,uint8 systemMainCount,uint8 systemCompCount,uint8 rank,bool claimed,uint256 grossWinAmount))",
];

const TEXT = {
  fr: {
    locale: "fr-FR",
    title: (n) => `Loterie AVAX, tirage n° ${n}`,
    drawn: "Numéros sortis",
    played: (n, pool) => `${n} ticket${n > 1 ? "s" : ""} joué${n > 1 ? "s" : ""}, ${pool} WAVAX en jeu.`,
    winners: "Gagnants : ", sep: " ; ",
    rank: (r, n, pool) => `${n} ticket${n > 1 ? "s" : ""} au rang ${r}${pool ? ` (${pool} WAVAX à partager)` : ""}`,
    none: "Aucun ticket gagnant : les lots sont reportés sur les prochains tirages.",
    next: (when, pool, price) => `Prochain tirage ${when} : ${pool} WAVAX déjà en jeu, ticket à ${price} WAVAX.`,
    notOpen: "Le prochain tirage n'est pas encore ouvert.",
    play: "Jouer sur Sixte",
    at: "à",
  },
  en: {
    locale: "en-GB",
    title: (n) => `AVAX lottery, draw no. ${n}`,
    drawn: "Numbers drawn",
    played: (n, pool) => `${n} ticket${n === 1 ? "" : "s"} played, ${pool} WAVAX in play.`,
    winners: "Winners: ", sep: "; ",
    rank: (r, n, pool) => `${n} ticket${n === 1 ? "" : "s"} at rank ${r}${pool ? ` (${pool} WAVAX to share)` : ""}`,
    none: "No winning ticket: the prizes roll over to the next draws.",
    next: (when, pool, price) => `Next draw ${when}: ${pool} WAVAX in play already, ticket at ${price} WAVAX.`,
    notOpen: "The next draw is not open yet.",
    play: "Play on Sixte",
    at: "at",
  },
};

const fmt = (x, digits, locale) => {
  const [i, f = ""] = ethers.formatEther(x).split(".");
  const frac = f.slice(0, digits).replace(/0+$/, "");
  return Number(i).toLocaleString(locale) + (frac ? (locale.startsWith("fr") ? "," : ".") + frac : "");
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The latest draw that has been executed, looking back a few draws from the current one. */
async function latestExecuted(lottery) {
  const current = await lottery.currentDrawId();
  for (let id = current; id > 0n && id + 6n > current; id--) {
    const draw = await lottery.getDraw(id);
    if (draw.drawnAt > 0n) return draw;
  }
  return null;
}

/** Best rank of a ticket: 6 numbers and 2 extras at most can count, whatever a system play holds. */
function bestRank(ticket, draw) {
  const winM = new Set(Array.from(draw.winningMain, Number)), winC = new Set(Array.from(draw.winningComp, Number));
  const mains = Array.from(ticket.mainNumbers, Number).slice(0, ticket.isSystemPlay ? Number(ticket.systemMainCount) : 6);
  const comps = Array.from(ticket.compNumbers, Number).slice(0, ticket.isSystemPlay ? Number(ticket.systemCompCount) : 2);
  const m = Math.min(6, mains.filter((n) => winM.has(n)).length), c = Math.min(2, comps.filter((n) => winC.has(n)).length);
  return lib.getRank(m, c, draw.isRun2);
}

/** Everything the message needs, read from the chain. */
async function collect(lottery, draw) {
  const ids = Array.from(await lottery.getDrawTickets(draw.id));
  const tickets = [];
  for (let i = 0; i < ids.length; i += 20) tickets.push(...(await Promise.all(ids.slice(i, i + 20).map((id) => lottery.getTicket(id)))));
  const byRank = new Map();
  for (const t of tickets) { const r = bestRank(t, draw); if (r) byRank.set(r, (byRank.get(r) || 0) + 1); }
  const [currentId, price] = await Promise.all([lottery.currentDrawId(), lottery.ticketPrice()]);
  const next = currentId > draw.id ? await lottery.getDraw(currentId) : null;
  return { draw, sold: tickets.length, byRank, next: next && next.drawnAt === 0n ? next : null, price };
}

/** The message, in Telegram's HTML. */
function buildMessage({ draw, sold, byRank, next, price }, { lang = "fr", tz = "Europe/Paris" } = {}) {
  const L = TEXT[lang] || TEXT.fr;
  const when = (ts) => {
    const d = new Date(Number(ts) * 1000);
    const day = d.toLocaleDateString(L.locale, { weekday: "short", day: "numeric", month: "short", timeZone: tz });
    const hour = d.toLocaleTimeString(L.locale, { hour: "2-digit", minute: "2-digit", timeZone: tz });
    return `${day} ${L.at} ${hour}`;
  };
  const lines = [
    `<b>${esc(L.title(draw.id))}</b>`,
    esc(when(draw.scheduledTime)),
    "",
    esc(L.drawn),
    `<b>${Array.from(draw.winningMain, Number).join("  ")}</b>  +  <b>${Array.from(draw.winningComp, Number).join("  ")}</b>`,
    "",
    esc(L.played(sold, fmt(draw.prizePool, 2, L.locale))),
  ];
  if (byRank.size) {
    const parts = [...byRank.keys()].sort((a, b) => a - b).map((r) => {
      const pool = draw.finalized && draw.rankPools[r - 1] > 0n ? fmt(draw.rankPools[r - 1], 3, L.locale) : "";
      return L.rank(r, byRank.get(r), pool);
    });
    lines.push(esc(L.winners + parts.join(L.sep) + "."));
  } else lines.push(esc(L.none));
  lines.push("", esc(next ? L.next(when(next.scheduledTime), fmt(next.prizePool, 2, L.locale), fmt(price, 4, L.locale)) : L.notOpen));
  return lines.join("\n");
}

async function send({ token, chat, text, playUrl, lang = "fr", api = "https://api.telegram.org" }) {
  const L = TEXT[lang] || TEXT.fr;
  const body = { chat_id: chat, text, parse_mode: "HTML" };
  if (playUrl) {
    body.link_preview_options = { url: playUrl, prefer_large_media: true };
    body.reply_markup = { inline_keyboard: [[{ text: L.play, url: playUrl }]] };
  } else body.link_preview_options = { is_disabled: true };
  const res = await fetch(`${api}/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    // The answer can name the chat: only the status and Telegram's own short reason are kept.
    let why = "";
    try { why = (await res.json()).description || ""; } catch {}
    throw new Error(`Telegram refused the message (${res.status}${why ? ", " + why : ""})`);
  }
}

async function main() {
  const env = process.env;
  const cmd = process.argv[2] || "post";
  const urls = env.RPC_URL ? env.RPC_URL.split(",").map((u) => u.trim()).filter(Boolean) : RPC_URLS;
  let provider;
  for (const url of urls) {
    const p = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: Number(env.RPC_BATCH || 10) });
    try { await p.getBlockNumber(); provider = p; break; } catch { p.destroy(); }
  }
  if (!provider) throw new Error("no RPC endpoint answered");
  const lottery = new ethers.Contract(env.LOTTERY || LOTTERY, LOTTERY_ABI, provider);

  const wanted = process.argv[3] ? BigInt(process.argv[3]) : null;
  const draw = wanted ? await lottery.getDraw(wanted) : await latestExecuted(lottery);
  if (cmd === "latest") {
    if (draw && draw.drawnAt > 0n) console.log(draw.id.toString());
    return;
  }
  if (!draw || draw.drawnAt === 0n) return console.log("No executed draw to publish.");
  // A draw that is no longer news is not published, unless asked for (first run, or a cache that expired).
  const now = BigInt((await provider.getBlock("latest")).timestamp);
  if (env.FORCE !== "1" && now - draw.drawnAt > 11n * 3600n) return console.log("The latest draw is more than 11 hours old: not published.");

  const lang = env.ANNOUNCE_LANG === "en" ? "en" : "fr";
  const text = buildMessage(await collect(lottery, draw), { lang, tz: env.ANNOUNCE_TZ || "Europe/Paris" });
  const repo = env.GITHUB_REPOSITORY ? env.GITHUB_REPOSITORY.split("/") : null;
  const playUrl = env.PLAY_URL || (repo ? `https://${repo[0].toLowerCase()}.github.io/${repo[1]}/play/` : "");
  if (env.DRY_RUN === "1") return console.log(text.replace(/<\/?b>/g, ""));
  if (!env.ANNOUNCE_BOT_TOKEN || !env.ANNOUNCE_CHAT) return console.log("Not configured: add the ANNOUNCE_BOT_TOKEN and ANNOUNCE_CHAT secrets (README, Results bot).");
  await send({ token: env.ANNOUNCE_BOT_TOKEN.trim(), chat: env.ANNOUNCE_CHAT.trim(), text, playUrl, lang, api: env.TELEGRAM_API });
  if (env.PUBLISHED_FILE) fs.writeFileSync(env.PUBLISHED_FILE, draw.id.toString() + "\n"); // lets the workflow remember this draw
  console.log("published");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("stopped: " + String(e.shortMessage || e.message).replace(/bot\d+:[\w-]+/g, "bot…"));
    process.exit(1);
  });
}

module.exports = { latestExecuted, collect, buildMessage, send, bestRank };
