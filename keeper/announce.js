#!/usr/bin/env node
/**
 * Results bot: publishes the result of the latest draw of the AVAX lottery to a Telegram chat.
 *
 *   node keeper/announce.js latest        prints the number of the latest draw that was executed
 *   node keeper/announce.js post [id]     publishes that draw (DRY_RUN=1 prints the message instead)
 *   node keeper/announce.js open          prints the number of the open draw when it is due within two hours
 *   node keeper/announce.js teaser        publishes a short film about that draw, before it happens
 *
 * Read-only on the chain: no wallet, no key. It needs a Telegram bot that is allowed to post in
 * the chat (ANNOUNCE_BOT_TOKEN) and the chat itself (ANNOUNCE_CHAT: "@channel" or a numeric id).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { ethers } = require("ethers");
const lib = require("./lib");

const LOTTERY = "0xB49a551aecD96b60a121Fc9996C2812e9BF95186"; // PartnerLotteryCore, Avalanche C-Chain
const OFFICIAL_SITE = "https://bcmdao.io/avax-lottery";
const RPC_URLS = ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"];
const LOTTERY_ABI = [
  "function ticketPrice() view returns (uint256)",
  "function currentDrawId() view returns (uint256)",
  "function getDrawTickets(uint256) view returns (uint256[])",
  "function rankRollover(uint256) view returns (uint256)",
  "function getDrawTicketCount(uint256) view returns (uint256)",
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
    next: (when, pool, price) => `Prochain tirage ${when} : ${pool} WAVAX à gagner, ticket à ${price} WAVAX.`,
    notOpen: "Le prochain tirage n'est pas encore ouvert.",
    play: (site) => `Jouer sur ${site}`,
    cardTitle: "Loterie AVAX de BCM DAO", cardDraw: (n) => `Tirage n° ${n}`, cardSold: "tickets joués", cardPool: "WAVAX en jeu", cardWinners: "tickets gagnants",
    cardNext: (when) => `Prochain tirage ${when}`, cardJackpot: "à gagner, reports compris",
    at: "à",
    teaseJackpot: "à gagner, reports compris", teaseStreak: (n) => `jackpot reporté depuis ${n} tirages`,
    teaseSold: (n) => (n === 0 ? "Aucun ticket pour l'instant." : `${n} ticket${n > 1 ? "s" : ""} en jeu.`),
    teaseAsk: (n) => (n === 0 ? "Le premier ?" : "Et le tien ?"), teasePrice: (p) => `Ticket à ${p} WAVAX`,
    teaseText: (n, when, pool, price, sold) => `Tirage n° ${n}, ${when} : ${pool} WAVAX à gagner, reports compris. Ticket à ${price} WAVAX, ${sold} ticket${sold > 1 ? "s" : ""} en jeu pour l'instant.`,
    teaseHead: (n) => `Tirage n° ${n}`, teaseIn: (t) => `dans ${t}`,
  },
  en: {
    locale: "en-GB",
    title: (n) => `AVAX lottery, draw no. ${n}`,
    drawn: "Numbers drawn",
    played: (n, pool) => `${n} ticket${n === 1 ? "" : "s"} played, ${pool} WAVAX in play.`,
    winners: "Winners: ", sep: "; ",
    rank: (r, n, pool) => `${n} ticket${n === 1 ? "" : "s"} at rank ${r}${pool ? ` (${pool} WAVAX to share)` : ""}`,
    none: "No winning ticket: the prizes roll over to the next draws.",
    next: (when, pool, price) => `Next draw ${when}: ${pool} WAVAX to win, ticket at ${price} WAVAX.`,
    notOpen: "The next draw is not open yet.",
    play: (site) => `Play on ${site}`,
    cardTitle: "BCM DAO's AVAX lottery", cardDraw: (n) => `Draw no. ${n}`, cardSold: "tickets played", cardPool: "WAVAX in play", cardWinners: "winning tickets",
    cardNext: (when) => `Next draw ${when}`, cardJackpot: "to win, rollovers included",
    at: "at",
    teaseJackpot: "to win, rollovers included", teaseStreak: (n) => `jackpot rolled over for ${n} draws`,
    teaseSold: (n) => (n === 0 ? "No ticket yet." : `${n} ticket${n === 1 ? "" : "s"} in play.`),
    teaseAsk: (n) => (n === 0 ? "The first one?" : "And yours?"), teasePrice: (p) => `Ticket at ${p} WAVAX`,
    teaseText: (n, when, pool, price, sold) => `Draw no. ${n}, ${when}: ${pool} WAVAX to win, rollovers included. Ticket at ${price} WAVAX, ${sold} ticket${sold === 1 ? "" : "s"} in play so far.`,
    teaseHead: (n) => `Draw no. ${n}`, teaseIn: (t) => `in ${t}`,
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
  // What the next draw can pay: its own pool, plus what earlier draws left unwon in each rank
  // (the rank 1 rollover is the jackpot that builds up).
  let reserve = 0n;
  try {
    const rolled = await Promise.all([...Array(12).keys()].map((i) => lottery.rankRollover(i + 1)));
    reserve = rolled.reduce((a, x) => a + x, 0n);
  } catch {}
  return { draw, sold: tickets.length, byRank, next: next && next.drawnAt === 0n ? next : null, price, reserve };
}

/** The message, in Telegram's HTML. */
function buildMessage({ draw, sold, byRank, next, price, reserve = 0n }, { lang = "fr", tz = "Europe/Paris", short = false } = {}) {
  const L = TEXT[lang] || TEXT.fr;
  const winnersLine = () => {
    if (!byRank.size) return L.none;
    const parts = [...byRank.keys()].sort((a, b) => a - b).map((r) => L.rank(r, byRank.get(r), draw.finalized && draw.rankPools[r - 1] > 0n ? fmt(draw.rankPools[r - 1], 3, L.locale) : ""));
    return L.winners + parts.join(L.sep) + ".";
  };
  const when = (ts) => {
    const d = new Date(Number(ts) * 1000);
    const day = d.toLocaleDateString(L.locale, { weekday: "short", day: "numeric", month: "short", timeZone: tz });
    const hour = d.toLocaleTimeString(L.locale, { hour: "2-digit", minute: "2-digit", timeZone: tz });
    return `${day} ${L.at} ${hour}`;
  };
  // the next draw pays its own pool plus what earlier draws left unwon
  const nextLine = next ? L.next(when(next.scheduledTime), fmt(next.prizePool + reserve, 2, L.locale), fmt(price, 4, L.locale)) : L.notOpen;
  // Under the picture, what the picture does not spell out: who won what, and the next draw.
  if (short) return esc(winnersLine()) + "\n\n" + esc(nextLine);
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
  lines.push("", esc(nextLine));
  return lines.join("\n");
}

// the animated card: the jackpot counts up between these two instants, the film lasts FILM_MS and then holds
const COUNT_FROM = 3700, COUNT_TO = 5000, FILM_MS = 6300, HOLD_S = 3.5, FPS = 20;

/** The result as a picture: an HTML card, 1200 x 675, rendered by a headless Chrome. */
function cardHtml({ draw, sold, byRank, next, reserve = 0n }, { lang = "fr", tz = "Europe/Paris", font = "" } = {}) {
  const L = TEXT[lang] || TEXT.fr;
  const when = (ts) => {
    const d = new Date(Number(ts) * 1000);
    return `${d.toLocaleDateString(L.locale, { weekday: "short", day: "numeric", month: "short", timeZone: tz })} ${L.at} ${d.toLocaleTimeString(L.locale, { hour: "2-digit", minute: "2-digit", timeZone: tz })}`;
  };
  const winners = [...byRank.values()].reduce((a, n) => a + n, 0);
  const balls = Array.from(draw.winningMain, Number).map((n, i) => `<span class="ball" style="--i:${i}">${n}</span>`).join("") +
    `<span class="plus">+</span>` + Array.from(draw.winningComp, Number).map((n, i) => `<span class="ball extra" style="--i:${7.6 + i}">${n}</span>`).join("");
  const stat = (value, label, i) => `<div class="stat" style="--i:${i}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const jackpot = (next ? next.prizePool : 0n) + reserve;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${font ? `@font-face { font-family: "Archivo"; src: url("${font}") format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }` : ""}
  * { box-sizing: border-box; }
  /* A headless Chrome's viewport is a little shorter than its window: the card fills the viewport
     and the page colour continues below it. */
  html { min-height: 675px; background: radial-gradient(900px 520px at 78% -10%, rgba(220, 47, 51, 0.38), transparent 70%), radial-gradient(700px 420px at 0% 100%, rgba(220, 47, 51, 0.2), transparent 70%), #0B0D12; }
  body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; color: #F4F5F7; font-family: "Archivo", "DejaVu Sans", Arial, sans-serif;
    padding: 62px 64px 8px; display: flex; flex-direction: column; justify-content: space-between; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; }
  .head small { display: block; font-size: 30px; color: #AAB1BD; font-weight: 500; }
  h1 { margin: 2px 0 0; font-size: 104px; line-height: 1; font-weight: 800; font-stretch: 66%; }
  .date { font-size: 30px; color: #AAB1BD; text-align: right; padding-top: 8px; }
  .balls { display: flex; align-items: center; gap: 14px; }
  .ball { flex: none; width: 100px; height: 100px; border-radius: 50%; display: grid; place-items: center; font-size: 50px; font-weight: 800; font-stretch: 66%; color: #fff;
    background: radial-gradient(circle at 32% 28%, #FF7A70, #DC2F33 58%, #A51B1F); box-shadow: 0 0 34px rgba(220, 47, 51, 0.55), inset 0 -8px 0 rgba(0, 0, 0, 0.18); }
  .ball.extra { color: #15181D; background: radial-gradient(circle at 32% 28%, #FFFFFF, #DCE1E8 62%, #AEB6C2); box-shadow: 0 0 30px rgba(255, 255, 255, 0.28), inset 0 -8px 0 rgba(0, 0, 0, 0.1); }
  .plus { font-size: 54px; font-weight: 700; color: #7C8594; padding: 0 2px; }
  .foot { display: flex; justify-content: space-between; align-items: flex-end; gap: 40px; }
  .stats { display: flex; gap: 46px; }
  .stat b { display: block; font-size: 54px; font-weight: 800; font-stretch: 66%; line-height: 1.05; }
  .stat span { font-size: 24px; color: #AAB1BD; }
  .next { text-align: right; }
  .next > span { display: block; font-size: 24px; color: #AAB1BD; }
  .next b { display: block; font-size: 84px; font-weight: 800; font-stretch: 66%; line-height: 1.05; white-space: nowrap; font-variant-numeric: tabular-nums;
    color: transparent; -webkit-background-clip: text; background-clip: text; background-size: 300% 100%; background-position: 100% 0;
    background-image: linear-gradient(100deg, #C9971A 0%, #F2C230 38%, #FFF6C9 50%, #F2C230 62%, #C9971A 100%); filter: drop-shadow(0 0 18px rgba(242, 194, 48, 0.35)); }
  .next b i { font-style: normal; font-size: 0.6em; letter-spacing: 0.04em; margin-left: 14px; }
  /* Animated version only (class set by the renderer). Without it the card is its own last frame. */
  .anim .head { animation: rise 0.5s both; }
  .anim .ball { animation: drop 0.6s calc(0.45s + var(--i) * 0.27s) both cubic-bezier(0.2, 1.5, 0.4, 1); }
  .anim .plus { animation: rise 0.3s 2.4s both; }
  .anim .stat { animation: rise 0.45s calc(3.3s + var(--i) * 0.12s) both; }
  .anim .next { animation: rise 0.5s ${COUNT_FROM - 200}ms both; }
  .anim .next b { animation: shine 1.6s ${COUNT_TO - 300}ms both ease-in-out; }
  @keyframes rise { from { opacity: 0; transform: translateY(18px); } }
  @keyframes drop { from { opacity: 0; transform: translateY(-150px) scale(0.5); } 60% { opacity: 1; } }
  @keyframes shine { from { background-position: 100% 0; } to { background-position: 0 0; } }
</style></head><body>
  <div class="head"><div><small>${esc(L.cardTitle)}</small><h1>${esc(L.cardDraw(draw.id))}</h1></div><div class="date">${esc(when(draw.scheduledTime))}</div></div>
  <div class="balls">${balls}</div>
  <div class="foot">
    <div class="stats">${stat(sold, L.cardSold, 0)}${stat(fmt(draw.prizePool, 2, L.locale), L.cardPool, 1)}${stat(winners, L.cardWinners, 2)}</div>
    ${next ? `<div class="next"><span>${esc(L.cardNext(when(next.scheduledTime)))}</span><b><span id="amount">${esc(fmt(jackpot, 2, L.locale))}</span><i>AVAX</i></b><span>${esc(L.cardJackpot)}</span></div>` : ""}
  </div>
<script>
  // The animated version is drawn frame by frame: seek(ms) puts every animation at that instant.
  const amount = document.getElementById("amount"), last = amount ? amount.textContent : "";
  const target = ${Number(ethers.formatEther(jackpot))}, from = ${COUNT_FROM}, to = ${COUNT_TO};
  function seek(ms) {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; }
    if (!amount) return;
    const k = Math.min(1, Math.max(0, (ms - from) / (to - from))), eased = 1 - Math.pow(1 - k, 3);
    amount.textContent = k >= 1 ? last : (target * eased).toLocaleString("${L.locale}", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
</script>
</body></html>`;
}

// the film posted before a draw
const TEASE_MS = 6600, TEASE_COUNT = [700, 2500], TEASE_SETTLE = (i) => 3300 + i * 190;

/** What the teaser needs about the draw that is open: its pot, its tickets, how long the jackpot has been rolling. */
async function collectTeaser(lottery) {
  const id = await lottery.currentDrawId();
  if (id === 0n) return null;
  const draw = await lottery.getDraw(id);
  if (draw.drawnAt > 0n) return null;
  const [price, sold, rolled] = await Promise.all([lottery.ticketPrice(), lottery.getDrawTicketCount(id),
    Promise.all([...Array(12).keys()].map((i) => lottery.rankRollover(i + 1))).catch(() => [])]);
  // consecutive draws before this one that nobody won at rank 1
  let streak = 0;
  for (let d = id - 1n; d > 0n && streak < 60; d--) {
    const past = await lottery.getDraw(d);
    if (past.drawnAt === 0n) continue;
    if (past.hasRank1Winner) break;
    streak++;
  }
  return { draw, price, sold: Number(sold), total: draw.prizePool + rolled.reduce((a, x) => a + x, 0n), streak };
}

function teaserText({ draw, price, sold, total }, { lang = "fr", tz = "Europe/Paris" } = {}) {
  const L = TEXT[lang] || TEXT.fr;
  const d = new Date(Number(draw.scheduledTime) * 1000);
  const when = `${d.toLocaleDateString(L.locale, { weekday: "short", day: "numeric", month: "short", timeZone: tz })} ${L.at} ${d.toLocaleTimeString(L.locale, { hour: "2-digit", minute: "2-digit", timeZone: tz })}`;
  return esc(L.teaseText(draw.id, when, fmt(total, 2, L.locale), fmt(price, 4, L.locale), sold));
}

/**
 * The teaser's caption with a countdown that Telegram keeps up to date: a "date_time" entity in
 * relative format, which each reader's app renders ("in 25 minutes") from the draw's time. The
 * text inside it is what an app that does not know the entity shows: the time left when posted.
 * Plain text and entities, not HTML.
 */
function teaserCaption(data, { lang = "fr", tz = "Europe/Paris", now = Math.floor(Date.now() / 1000) } = {}) {
  const L = TEXT[lang] || TEXT.fr;
  const at = Number(data.draw.scheduledTime), left = Math.max(60, at - now);
  const h = Math.floor(left / 3600), m = Math.round((left % 3600) / 60);
  const head = L.teaseHead(data.draw.id) + " · ", count = L.teaseIn(h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`);
  const rest = teaserText(data, { lang, tz }).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return { text: head + count + "\n" + rest, entities: [{ type: "date_time", offset: head.length, length: count.length, unix_time: at, date_time_format: "r" }] };
}

/** The film before a draw: the pot climbs, the balls spin and stay unknown. Same look as the result card. */
function teaserHtml({ draw, price, sold, total, streak = 0 }, { lang = "fr", tz = "Europe/Paris", font = "" } = {}) {
  const L = TEXT[lang] || TEXT.fr;
  const d = new Date(Number(draw.scheduledTime) * 1000);
  const when = `${d.toLocaleDateString(L.locale, { weekday: "short", day: "numeric", month: "short", timeZone: tz })} ${L.at} ${d.toLocaleTimeString(L.locale, { hour: "2-digit", minute: "2-digit", timeZone: tz })}`;
  const balls = [...Array(7).keys()].map((i) => `<span class="ball" style="--i:${i}">?</span>`).join("") +
    `<span class="plus">+</span>` + [7, 8].map((i) => `<span class="ball extra" style="--i:${i}">?</span>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${font ? `@font-face { font-family: "Archivo"; src: url("${font}") format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }` : ""}
  * { box-sizing: border-box; }
  html { min-height: 675px; background: radial-gradient(1000px 560px at 50% 42%, rgba(242, 194, 48, 0.13), transparent 70%), radial-gradient(900px 520px at 78% -10%, rgba(220, 47, 51, 0.38), transparent 70%), radial-gradient(700px 420px at 0% 100%, rgba(220, 47, 51, 0.2), transparent 70%), #0B0D12; }
  body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; color: #F4F5F7; font-family: "Archivo", "DejaVu Sans", Arial, sans-serif;
    padding: 50px 64px 8px; display: flex; flex-direction: column; justify-content: space-between; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; }
  .head small { display: block; font-size: 28px; color: #AAB1BD; font-weight: 500; }
  h1 { margin: 2px 0 0; font-size: 64px; line-height: 1; font-weight: 800; font-stretch: 66%; }
  .date { font-size: 36px; font-weight: 700; font-stretch: 80%; text-align: right; padding-top: 6px; }
  .pot { text-align: center; margin-top: -6px; }
  .pot b { display: inline-block; font-size: 210px; font-weight: 800; font-stretch: 64%; line-height: 0.95; white-space: nowrap; font-variant-numeric: tabular-nums;
    color: transparent; -webkit-background-clip: text; background-clip: text; background-size: 300% 100%; background-position: 0 0;
    background-image: linear-gradient(100deg, #C9971A 0%, #F2C230 38%, #FFF6C9 50%, #F2C230 62%, #C9971A 100%); filter: drop-shadow(0 0 34px rgba(242, 194, 48, 0.42)); }
  .pot b i { font-style: normal; font-size: 0.42em; letter-spacing: 0.04em; margin-left: 22px; }
  .pot > span { display: block; margin-top: 6px; font-size: 30px; color: #E9D08A; font-weight: 600; letter-spacing: 0.02em; }
  .balls { display: flex; align-items: center; justify-content: center; gap: 12px; }
  .ball { flex: none; width: 78px; height: 78px; border-radius: 50%; display: grid; place-items: center; font-size: 40px; font-weight: 800; font-stretch: 66%; color: #fff;
    background: radial-gradient(circle at 32% 28%, #FF7A70, #DC2F33 58%, #A51B1F); box-shadow: 0 0 28px rgba(220, 47, 51, 0.55), inset 0 -7px 0 rgba(0, 0, 0, 0.18); }
  .ball.extra { color: #15181D; background: radial-gradient(circle at 32% 28%, #FFFFFF, #DCE1E8 62%, #AEB6C2); box-shadow: 0 0 26px rgba(255, 255, 255, 0.28), inset 0 -7px 0 rgba(0, 0, 0, 0.1); }
  .ball.spin { color: rgba(255, 255, 255, 0.75); text-shadow: 0 7px 0 rgba(255, 255, 255, 0.28), 0 -7px 0 rgba(255, 255, 255, 0.28); filter: blur(0.6px); }
  .ball.extra.spin { color: rgba(21, 24, 29, 0.7); text-shadow: 0 7px 0 rgba(21, 24, 29, 0.22), 0 -7px 0 rgba(21, 24, 29, 0.22); }
  .plus { font-size: 44px; font-weight: 700; color: #7C8594; padding: 0 2px; }
  .foot { display: flex; justify-content: space-between; align-items: baseline; gap: 40px; padding-bottom: 26px; }
  .ask { font-size: 44px; font-weight: 800; font-stretch: 72%; }
  .ask em { font-style: normal; color: #F2C230; margin-left: 12px; }
  .price { font-size: 30px; color: #AAB1BD; }
  .anim .head { animation: rise 0.5s both; }
  .anim .pot { animation: swell 0.7s 0.45s both cubic-bezier(0.2, 1.2, 0.4, 1); }
  .anim .pot b { animation: shine 1.7s ${TEASE_COUNT[1] - 200}ms both ease-in-out; }
  .anim .pot > span { animation: rise 0.5s ${TEASE_COUNT[1]}ms both; }
  .anim .ball { animation: drop 0.5s calc(1.3s + var(--i) * 0.11s) both cubic-bezier(0.2, 1.5, 0.4, 1), settle 0.45s calc(${TEASE_SETTLE(0)}ms + var(--i) * ${TEASE_SETTLE(1) - TEASE_SETTLE(0)}ms) both; }
  .anim .plus { animation: rise 0.3s 2.1s both; }
  .anim .ask { animation: rise 0.5s 5.2s both; }
  .anim .ask em { animation: rise 0.45s 5.75s both; display: inline-block; }
  .anim .price { animation: rise 0.5s 5.5s both; }
  @keyframes rise { from { opacity: 0; transform: translateY(18px); } }
  @keyframes swell { from { opacity: 0; transform: scale(0.72); } }
  @keyframes drop { from { opacity: 0; transform: translateY(-110px) scale(0.5); } 60% { opacity: 1; } }
  @keyframes settle { 40% { scale: 1.2; } }
  @keyframes shine { from { background-position: 100% 0; } to { background-position: 0 0; } }
</style></head><body>
  <div class="head"><div><small>${esc(L.cardTitle)}</small><h1>${esc(L.cardDraw(draw.id))}</h1></div><div class="date">${esc(when)}</div></div>
  <div class="pot"><b><span id="amount">${esc(fmt(total, 2, L.locale))}</span><i>AVAX</i></b><span>${esc(streak >= 2 ? L.teaseStreak(streak) : L.teaseJackpot)}</span></div>
  <div class="balls">${balls}</div>
  <div class="foot"><div class="ask">${esc(L.teaseSold(sold))}<em>${esc(L.teaseAsk(sold))}</em></div><div class="price">${esc(L.teasePrice(fmt(price, 4, L.locale)))}</div></div>
<script>
  // Drawn frame by frame: seek(ms) puts every animation at that instant. The balls spin through
  // numbers and settle on a question mark: the result is still open.
  const amount = document.getElementById("amount"), last = amount.textContent, target = ${Number(ethers.formatEther(total))};
  const balls = [...document.querySelectorAll(".ball")];
  function seek(ms) {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; }
    const k = Math.min(1, Math.max(0, (ms - ${TEASE_COUNT[0]}) / ${TEASE_COUNT[1] - TEASE_COUNT[0]})), eased = 1 - Math.pow(1 - k, 3);
    amount.textContent = k >= 1 ? last : (target * eased).toLocaleString("${L.locale}", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    balls.forEach((b, i) => {
      const done = ms >= ${TEASE_SETTLE(0)} + i * ${TEASE_SETTLE(1) - TEASE_SETTLE(0)};
      b.classList.toggle("spin", !done);
      b.textContent = done ? "?" : 1 + ((i * 7 + Math.floor(ms / 100) * (5 + i)) % (i < 7 ? 24 : 5));
    });
  }
</script>
</body></html>`;
}

const CHROMES = () => [process.env.CHROME, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].filter(Boolean);
const CHROME_FLAGS = ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1200,675"];

/** Plays the card in a headless Chrome and saves one PNG per frame (DevTools protocol). Returns the frames' paths. */
async function captureFrames(bin, html, dir, ms = FILM_MS) {
  const WebSocket = require("ws"); // comes with ethers
  const profile = path.join(dir, "profile-film");
  const chrome = spawn(bin, [...CHROME_FLAGS, "--remote-debugging-port=0", "--user-data-dir=" + profile, "file://" + html], { stdio: "ignore" });
  let ws;
  try {
    const failed = new Promise((_, no) => chrome.once("error", no));
    failed.catch(() => {});
    // Chrome writes the port it chose in its profile
    const portFile = path.join(profile, "DevToolsActivePort");
    let port = 0;
    for (let i = 0; i < 150 && !port; i++) {
      await Promise.race([new Promise((r) => setTimeout(r, 100)), failed]);
      try { port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]); } catch {}
    }
    if (!port) throw new Error("no DevTools port");
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page" && t.url.startsWith("file:"));
      if (!page) await new Promise((r) => setTimeout(r, 100));
    }
    if (!page) throw new Error("no page");
    ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((ok, no) => { ws.once("open", ok); ws.once("error", no); });
    const waiting = new Map();
    let seq = 0;
    ws.on("message", (m) => { const d = JSON.parse(m); const w = waiting.get(d.id); if (w) { waiting.delete(d.id); d.error ? w.no(new Error(d.error.message)) : w.ok(d.result); } });
    const call = (method, params = {}) => new Promise((ok, no) => {
      const id = ++seq;
      waiting.set(id, { ok, no });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => waiting.delete(id) && no(new Error(method + " timed out")), 20000);
    });
    const run = async (expression) => {
      const r = await call("Runtime.evaluate", { expression, awaitPromise: true });
      if (r.exceptionDetails) throw new Error("page script failed");
    };
    await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 675, deviceScaleFactor: 1, mobile: false });
    await run(`document.fonts.ready.then(() => { document.documentElement.classList.add("anim"); })`);
    const frames = [];
    const count = Math.round((ms / 1000) * FPS);
    for (let i = 0; i <= count; i++) {
      await run(`seek(${Math.round((i * 1000) / FPS)}); new Promise((r) => requestAnimationFrame(() => r()))`);
      const shot = await call("Page.captureScreenshot", { format: "png" });
      const file = path.join(dir, `f${String(i).padStart(3, "0")}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      frames.push(file);
    }
    return frames;
  } finally {
    try { if (ws) ws.terminate(); } catch {}
    chrome.kill("SIGKILL");
  }
}

/**
 * Draws the card with whatever Chrome is installed. Returns { png, mp4 }: the still picture, and
 * the short film when it could be made (it needs ffmpeg too), or null when nothing could be drawn.
 */
async function renderCard(data, opts = {}) {
  return renderPage((font) => cardHtml(data, { ...opts, font }), { film: opts.film, ms: FILM_MS });
}
async function renderTeaser(data, opts = {}) {
  return renderPage((font) => teaserHtml(data, { ...opts, font }), { film: opts.film, ms: TEASE_MS });
}
async function renderPage(build, opts = {}) {
  let font = "";
  try { font = "data:font/woff2;base64," + fs.readFileSync(path.join(__dirname, "..", "docs", "play", "fonts", "archivo.woff2")).toString("base64"); } catch {}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-"));
  const html = path.join(dir, "card.html"), png = path.join(dir, "card.png"), mp4 = path.join(dir, "card.mp4");
  fs.writeFileSync(html, build(font));
  if (opts.film !== false) {
    for (const bin of CHROMES()) {
      try {
        const frames = await captureFrames(bin, html, dir, opts.ms);
        fs.copyFileSync(frames[frames.length - 1], png);
        try {
          // H.264 without sound: Telegram plays it in a loop, like a GIF. The last frame is held.
          execFileSync(process.env.FFMPEG || "ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(dir, "f%03d.png"),
            "-vf", `tpad=stop_mode=clone:stop_duration=${HOLD_S},scale=1280:720:flags=lanczos,format=yuv420p`,
            "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-movflags", "+faststart", "-an", mp4], { stdio: "ignore", timeout: 120000 });
          if (fs.statSync(mp4).size > 5000) return { png, mp4 };
        } catch {}
        return { png, mp4: null };
      } catch {}
    }
  }
  for (const bin of CHROMES()) {
    try {
      execFileSync(bin, [...CHROME_FLAGS, "--virtual-time-budget=4000", "--user-data-dir=" + path.join(dir, "profile"), "--screenshot=" + png, "file://" + html], { stdio: "ignore", timeout: 60000 });
      if (fs.existsSync(png) && fs.statSync(png).size > 5000) return { png, mp4: null };
    } catch {}
  }
  return null;
}

/**
 * The chat as the bot API wants it: "@name" or a numeric id. A public link (t.me/name) is
 * accepted too. An invitation link (t.me/+...) belongs to a private chat and names nothing.
 */
function chatId(value) {
  const v = String(value || "").trim();
  if (/^-?\d+$/.test(v) || /^@\w+$/.test(v)) return v;
  const m = v.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([^/?#]+)/i);
  if (m && /^\w+$/.test(m[1]) && !/^joinchat$/i.test(m[1])) return "@" + m[1];
  if (m || /joinchat/i.test(v)) throw new Error("ANNOUNCE_CHAT is an invitation link to a private chat: make the channel public and use its @name, or use its numeric id");
  if (/^\w+$/.test(v)) return "@" + v;
  throw new Error("ANNOUNCE_CHAT is not a channel name: expected @name, a t.me/name link or a numeric id");
}

async function send({ token, chat, text, entities = null, playUrl, photo = null, film = null, lang = "fr", api = "https://api.telegram.org" }) {
  // With entities, the text is plain (no HTML) and Telegram is told where they are. If it refuses
  // the message (an entity it does not accept), the same text goes out without them.
  if (entities && entities.length) {
    try { return await send({ token, chat, text, entities: [], playUrl, photo, film, lang, api, plain: entities }); } catch (e) {
      if (!/\(400/.test(e.message)) throw e;
      return send({ token, chat, text, entities: [], playUrl, photo, film, lang, api, plain: [] });
    }
  }
  const plain = arguments[0].plain || null; // internal: entities to attach to a plain text
  const L = TEXT[lang] || TEXT.fr;
  const markup = playUrl ? { inline_keyboard: [[{ text: L.play(new URL(playUrl).hostname.replace(/^www\./, "")), url: playUrl }]] } : null;
  let res;
  if (photo || film) {
    // the picture (or its short film) carries the result; the text goes with it as its caption
    const form = new FormData();
    form.append("chat_id", chat); form.append("caption", text);
    if (plain) { if (plain.length) form.append("caption_entities", JSON.stringify(plain)); } else form.append("parse_mode", "HTML");
    if (markup) form.append("reply_markup", JSON.stringify(markup));
    if (film) {
      form.append("width", "1280"); form.append("height", "720");
      form.append("animation", new Blob([fs.readFileSync(film)], { type: "video/mp4" }), "tirage.mp4");
    } else form.append("photo", new Blob([fs.readFileSync(photo)], { type: "image/png" }), "tirage.png");
    res = await fetch(`${api}/bot${token}/${film ? "sendAnimation" : "sendPhoto"}`, { method: "POST", body: form });
  } else {
    const body = { chat_id: chat, text, link_preview_options: { is_disabled: true } };
    if (plain) { if (plain.length) body.entities = plain; } else body.parse_mode = "HTML";
    if (markup) body.reply_markup = markup;
    res = await fetch(`${api}/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
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

  if (cmd === "open" || cmd === "teaser") {
    // Before a draw: a film of the pot, for the draw that is open and due soon.
    const data = await collectTeaser(lottery);
    const now = BigInt((await provider.getBlock("latest")).timestamp);
    const left = data ? data.draw.scheduledTime - now : 0n;
    const due = data && left > 120n && (env.FORCE === "1" || left < 2n * 3600n);
    if (cmd === "open") { if (due) console.log(data.draw.id.toString()); return; }
    if (!due) return console.log("No draw due within two hours: nothing to announce.");
    if (env.ANNOUNCE_TEASER === "off") return console.log("Teaser switched off.");
    const lang = env.ANNOUNCE_LANG === "en" ? "en" : "fr";
    const tz = env.ANNOUNCE_TZ || "Europe/Paris";
    const card = env.ANNOUNCE_CARD === "off" ? null : await renderTeaser(data, { lang, tz, film: env.ANNOUNCE_CARD !== "still" });
    const { text, entities } = teaserCaption(data, { lang, tz, now: Number(now) });
    if (env.CARD_FILE && card) fs.copyFileSync(card.mp4 || card.png, env.CARD_FILE);
    const playUrl = env.PLAY_URL === "none" ? "" : (env.PLAY_URL || OFFICIAL_SITE).trim();
    if (env.DRY_RUN === "1") return console.log(text);
    if (!env.ANNOUNCE_BOT_TOKEN || !env.ANNOUNCE_CHAT) return console.log("Not configured: add the ANNOUNCE_BOT_TOKEN and ANNOUNCE_CHAT secrets (README, Results bot).");
    await send({ token: env.ANNOUNCE_BOT_TOKEN.trim(), chat: chatId(env.ANNOUNCE_CHAT), text, entities, playUrl, photo: card && card.png, film: card && card.mp4, lang, api: env.TELEGRAM_API });
    if (env.PUBLISHED_FILE) fs.writeFileSync(env.PUBLISHED_FILE, data.draw.id.toString() + "\n");
    return console.log("published");
  }

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
  const tz = env.ANNOUNCE_TZ || "Europe/Paris";
  const data = await collect(lottery, draw);
  // The result as a short film, or as a still picture (ANNOUNCE_CARD=still, or no ffmpeg), unless
  // switched off or no browser is there to draw it (then: text only).
  const card = env.ANNOUNCE_CARD === "off" ? null : await renderCard(data, { lang, tz, film: env.ANNOUNCE_CARD !== "still" });
  const photo = card && card.png, film = card && card.mp4;
  const text = buildMessage(data, { lang, tz, short: !!card });
  if (env.CARD_FILE && card) fs.copyFileSync(film || photo, env.CARD_FILE);
  // The button points to the lottery's own site, unless another address is configured
  // (PLAY_URL=none removes the button).
  const playUrl = env.PLAY_URL === "none" ? "" : (env.PLAY_URL || OFFICIAL_SITE).trim();
  if (env.DRY_RUN === "1") return console.log(text.replace(/<\/?b>/g, ""));
  if (!env.ANNOUNCE_BOT_TOKEN || !env.ANNOUNCE_CHAT) return console.log("Not configured: add the ANNOUNCE_BOT_TOKEN and ANNOUNCE_CHAT secrets (README, Results bot).");
  await send({ token: env.ANNOUNCE_BOT_TOKEN.trim(), chat: chatId(env.ANNOUNCE_CHAT), text, playUrl, photo, film, lang, api: env.TELEGRAM_API });
  if (env.PUBLISHED_FILE) fs.writeFileSync(env.PUBLISHED_FILE, draw.id.toString() + "\n"); // lets the workflow remember this draw
  console.log("published");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("stopped: " + String(e.shortMessage || e.message).replace(/bot\d+:[\w-]+/g, "bot…"));
    process.exit(1);
  });
}

module.exports = { latestExecuted, collect, buildMessage, send, bestRank, chatId, cardHtml, renderCard, collectTeaser, teaserHtml, teaserText, teaserCaption, renderTeaser };
