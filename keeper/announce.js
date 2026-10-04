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
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
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
    play: (site) => `Jouer sur ${site}`,
    cardTitle: "Loterie AVAX", cardDraw: (n) => `Tirage n° ${n}`, cardSold: "tickets joués", cardPool: "WAVAX en jeu", cardWinners: "tickets gagnants",
    cardNext: (when) => `Prochain tirage ${when}`, cardJackpot: "WAVAX à gagner, reports compris",
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
    play: (site) => `Play on ${site}`,
    cardTitle: "AVAX lottery", cardDraw: (n) => `Draw no. ${n}`, cardSold: "tickets played", cardPool: "WAVAX in play", cardWinners: "winning tickets",
    cardNext: (when) => `Next draw ${when}`, cardJackpot: "WAVAX to win, rollovers included",
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
function buildMessage({ draw, sold, byRank, next, price }, { lang = "fr", tz = "Europe/Paris", short = false } = {}) {
  const L = TEXT[lang] || TEXT.fr;
  const winnersLine = () => {
    if (!byRank.size) return L.none;
    const parts = [...byRank.keys()].sort((a, b) => a - b).map((r) => L.rank(r, byRank.get(r), draw.finalized && draw.rankPools[r - 1] > 0n ? fmt(draw.rankPools[r - 1], 3, L.locale) : ""));
    return L.winners + parts.join(L.sep) + ".";
  };
  // Under the picture, only what the picture does not say: who won what.
  if (short) return esc(winnersLine());
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

/** The result as a picture: an HTML card, 1200 x 675, rendered by a headless Chrome. */
function cardHtml({ draw, sold, byRank, next, reserve = 0n }, { lang = "fr", tz = "Europe/Paris", font = "" } = {}) {
  const L = TEXT[lang] || TEXT.fr;
  const when = (ts) => {
    const d = new Date(Number(ts) * 1000);
    return `${d.toLocaleDateString(L.locale, { weekday: "short", day: "numeric", month: "short", timeZone: tz })} ${L.at} ${d.toLocaleTimeString(L.locale, { hour: "2-digit", minute: "2-digit", timeZone: tz })}`;
  };
  const winners = [...byRank.values()].reduce((a, n) => a + n, 0);
  const balls = Array.from(draw.winningMain, Number).map((n) => `<span class="ball">${n}</span>`).join("") +
    `<span class="plus">+</span>` + Array.from(draw.winningComp, Number).map((n) => `<span class="ball extra">${n}</span>`).join("");
  const stat = (value, label) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
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
  .next span { display: block; font-size: 24px; color: #AAB1BD; }
  .next b { display: block; font-size: 76px; font-weight: 800; font-stretch: 66%; line-height: 1.05; color: #F2C230; }
</style></head><body>
  <div class="head"><div><small>${esc(L.cardTitle)}</small><h1>${esc(L.cardDraw(draw.id))}</h1></div><div class="date">${esc(when(draw.scheduledTime))}</div></div>
  <div class="balls">${balls}</div>
  <div class="foot">
    <div class="stats">${stat(sold, L.cardSold)}${stat(fmt(draw.prizePool, 2, L.locale), L.cardPool)}${stat(winners, L.cardWinners)}</div>
    ${next ? `<div class="next"><span>${esc(L.cardNext(when(next.scheduledTime)))}</span><b>${esc(fmt(jackpot, 2, L.locale))}</b><span>${esc(L.cardJackpot)}</span></div>` : ""}
  </div>
</body></html>`;
}

/** Renders the card to a PNG with whatever Chrome is installed. Returns the file's path, or null. */
function renderCard(data, opts = {}) {
  const candidates = [process.env.CHROME, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].filter(Boolean);
  let font = "";
  try { font = "data:font/woff2;base64," + fs.readFileSync(path.join(__dirname, "..", "docs", "play", "fonts", "archivo.woff2")).toString("base64"); } catch {}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-"));
  const html = path.join(dir, "card.html"), png = path.join(dir, "card.png");
  fs.writeFileSync(html, cardHtml(data, { ...opts, font }));
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1200,675",
        "--virtual-time-budget=4000", "--user-data-dir=" + path.join(dir, "profile"), "--screenshot=" + png, "file://" + html], { stdio: "ignore", timeout: 60000 });
      if (fs.existsSync(png) && fs.statSync(png).size > 5000) return png;
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

async function send({ token, chat, text, playUrl, photo = null, lang = "fr", api = "https://api.telegram.org" }) {
  const L = TEXT[lang] || TEXT.fr;
  const markup = playUrl ? { inline_keyboard: [[{ text: L.play(new URL(playUrl).hostname.replace(/^www\./, "")), url: playUrl }]] } : null;
  let res;
  if (photo) {
    // the picture carries the result; the text goes with it as its caption
    const form = new FormData();
    form.append("chat_id", chat); form.append("caption", text); form.append("parse_mode", "HTML");
    if (markup) form.append("reply_markup", JSON.stringify(markup));
    form.append("photo", new Blob([fs.readFileSync(photo)], { type: "image/png" }), "tirage.png");
    res = await fetch(`${api}/bot${token}/sendPhoto`, { method: "POST", body: form });
  } else {
    const body = { chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
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
  // a picture of the result, unless switched off or no browser is there to draw it (then: text only)
  const photo = env.ANNOUNCE_CARD === "off" ? null : renderCard(data, { lang, tz });
  const text = buildMessage(data, { lang, tz, short: !!photo });
  if (env.CARD_FILE && photo) fs.copyFileSync(photo, env.CARD_FILE);
  // The button points to the lottery's own site, unless another address is configured
  // (PLAY_URL=none removes the button).
  const playUrl = env.PLAY_URL === "none" ? "" : (env.PLAY_URL || OFFICIAL_SITE).trim();
  if (env.DRY_RUN === "1") return console.log(text.replace(/<\/?b>/g, ""));
  if (!env.ANNOUNCE_BOT_TOKEN || !env.ANNOUNCE_CHAT) return console.log("Not configured: add the ANNOUNCE_BOT_TOKEN and ANNOUNCE_CHAT secrets (README, Results bot).");
  await send({ token: env.ANNOUNCE_BOT_TOKEN.trim(), chat: chatId(env.ANNOUNCE_CHAT), text, playUrl, photo, lang, api: env.TELEGRAM_API });
  if (env.PUBLISHED_FILE) fs.writeFileSync(env.PUBLISHED_FILE, draw.id.toString() + "\n"); // lets the workflow remember this draw
  console.log("published");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("stopped: " + String(e.shortMessage || e.message).replace(/bot\d+:[\w-]+/g, "bot…"));
    process.exit(1);
  });
}

module.exports = { latestExecuted, collect, buildMessage, send, bestRank, chatId, cardHtml, renderCard };
