# p33 vault → BCM lottery

Each user deploys **their own vault** and is its only owner. The p33 deposited stays intact;
only its weekly yield (the rise of the p33:xPHAR ratio) is sold for WAVAX and played on the
BCM lottery (`PartnerLotteryCore`, Avalanche C-Chain).

Web page: `docs/` (GitHub Pages). Everything can be done from a phone, inside a wallet's browser.

## What is in the repository

| Part | File | Role |
|---|---|---|
| Vault | `contracts/P33LotteryVault.sol` | Deposit, withdrawal, and `cycle`: collects winnings, sells the yield, then buys tickets or pays the budget to a player wallet, in one transaction |
| Factory | `contracts/P33LotteryVaultFactory.sol` | One vault per user. Holds no funds and has no rights over the vaults |
| Dry run | `contracts/DryRun.sol` | Never deployed: lets the page simulate the whole flow against the live chain with a read-only call |
| Player bot | `keeper/player.js` | Runs with the key of a dedicated player wallet: triggers the vault, buys the tickets in the wallet's own name, claims its prizes |
| Vault keeper | `keeper/index.js` | Alternative bot for vaults that buy the tickets themselves |
| Schedule | `.github/workflows/play.yml` | Runs the player bot before each draw |
| Web page | `docs/` | Wallet connection, vault creation, deposit, withdrawal, settings, dry run |
| Tests | `test/` | Contracts and bots on a local chain, and the page in a real browser |

## Two ways to play

**The vault plays.** The vault buys the tickets and holds them. Simple, but the lottery sees a
contract, not a person: a contract cannot sign the off-chain message BCM uses for a profile
or a referral.

**A player wallet plays.** The vault only produces the budget: each pass sells the yield and
sends the WAVAX to an ordinary wallet set by the owner (`player`). That wallet buys the tickets
in its own name, so it can have a BCM profile, a referrer, and receive whatever the lottery
distributes to players. This is the mode used by the automatic setup below.

## Who can do what

- **Vault owner**: deposits, withdraws p33 and WAVAX at any time, sets the guards, the keeper
  and the player wallet. The only one able to take funds out.
- **Keeper** (the player wallet, in player mode): `cycle` and its separate steps. No withdrawal.
  At worst, a compromised keeper wastes the yield not yet spent, within the guards.
- **Player wallet**: receives the ticket budget, nothing else. It never has access to the p33.
- **Factory**: no rights over the vaults.

Guards:

- **Reference price.** The vault keeps a reference bin of the pool and refuses to sell more than
  `maxDeviationBps` (10% by default) below it. Each pass moves the reference towards the market
  by at most that distance, and a reference written by a pass cannot be sold against for 6 hours.
  Nothing to maintain by hand. This protects a sale against a price manipulated at that moment;
  against the keeper itself it only slows things down (a keeper sending passes for days while
  holding the pool's price down can walk the reference down). What is exposed is the yield, never
  the principal. `minWavaxPerP33` is an optional absolute floor on top, which is a hard bound.
- **`maxTicketPrice`**: the ticket price can be changed by the lottery's operators; this cap
  stops an abnormal price from draining the budget. The player bot applies it too.
- **`reinvestCap`**: when the vault plays itself, the most it replays from each collection of
  winnings.

## Setup from a phone

1. Open the page in the wallet's browser and connect.
2. **Test without deploying**: the page simulates factory, vault, deposit, sale on the real
   pool, ticket purchase on the real lottery, payout and withdrawal. Nothing is signed.
3. Deploy the factory if nobody has yet (one transaction; its address only depends on the code,
   so everyone using the same version shares it).
4. Create the vault. Fill in "player wallet" to use the player mode. Deposit p33.

## Automatic play

The bot needs to sign transactions for the player wallet, so its key has to live where the bot
runs. Use a **dedicated wallet** for this, never the one that owns the vault. It holds the ticket
budget and owns the tickets, so **a prize belongs to it too**: at each pass the bot claims the
prizes and moves that money into the vault, where only the vault's owner can withdraw it. Between
a draw and the next pass, whoever holds the key could claim a prize: protect the account that
stores it (two-factor authentication on GitHub).

1. Create a new wallet in your wallet app. Its address is the "player wallet" of the vault.
2. Send it a little AVAX (0.1 is plenty). Afterwards it pays its own fees out of the WAVAX it
   receives.
3. On the lottery's site, connect with that wallet once to fill in the profile and the referral.
4. Fork this repository (or use your own copy). In **Settings → Secrets and variables → Actions**,
   add two repository secrets:
   - `PLAYER_PRIVATE_KEY`: the private key of the player wallet;
   - `VAULT`: the address of your vault.
5. In the **Actions** tab, enable workflows, open **play**, and use **Run workflow** with
   "dry run" ticked to check the configuration. Then let the schedule do its work.

Optional repository *variables*:

- `TICKETS_PER_DRAW`: fixed number of tickets per draw. By default the bot spreads what the wallet
  holds over the draws left before the next weekly sale, with at least one ticket per draw while
  funds last.
- `KEEP_TICKETS` (default 30): working balance of the player wallet, in tickets. Prize money above
  it goes to the vault. Whatever its origin, the wallet never keeps more than three times that, so
  raise it if one week of yield buys more than 90 tickets.
- `SHOW_AMOUNTS=1`: print amounts in the logs (left out by default, the logs being public).

What a pass does: asks the vault to sell its yield and pay it out (from Saturday 00:00 UTC:
after the epoch flip of Thursday 00:00 UTC the p33 ratio rises in steps until Friday evening);
claims and collects the prizes of the wallet's tickets; sends prize money above the working
balance to the vault; unwraps a little WAVAX when AVAX for fees runs low; buys the tickets of
the current draw. About once a day it also sends a pass that only keeps the vault's reference
price close to the market. Every step is idempotent, so the schedule runs twice before each
draw. A run that hits a problem is marked as failed.

Every transaction the bot signs goes to the vault named in `VAULT` or to the lottery and WAVAX
contracts pinned in its code: an RPC endpoint that lies can make a pass fail, not send funds
elsewhere.

### Recap on Telegram

GitHub's own notifications only say that a run succeeded or failed, and for a scheduled workflow
they do not reliably reach the repository owner. The bot therefore sends its own message, only
when something happened: yield sold, tickets bought, prizes claimed, money put aside in the
vault, or a problem. The message is private, so it includes the amounts (never an address).

1. In Telegram, talk to **@BotFather**, send `/newbot`, and keep the token it gives you.
2. Send any message to your new bot: a bot can only write to someone who wrote to it first.
3. Open `https://api.telegram.org/bot<token>/getUpdates` in a browser and read your chat id, the
   number in `"chat":{"id":…}`.
4. Add two more repository secrets: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

A manual run (**Run workflow**) always sends a recap, which is the way to test the setup. If no
message arrives for a draw while the wallet still has funds, the schedule is not running: check
the Actions tab.

Things to know:

- Secrets are encrypted by GitHub and masked in logs. The bot never prints an address or a
  transaction hash, and leaves amounts out. Still, run times are public on a public repository:
  someone determined could match them with purchases on the lottery and link the repository to
  the player wallet. Use a private repository if that matters.
- The key is readable by any code that runs in the workflow. Do not merge changes you have not
  read (bot, workflow, `package-lock.json`), and do not give anyone write access to the
  repository.
- Tickets bought by the vault itself before switching to player mode are claimed from the page
  ("run the cycle now"), not by this bot.
- GitHub disables scheduled workflows on public repositories after 60 days without activity.
  The workflow re-enables itself at each run; if GitHub disables it anyway, the recaps stop, and
  one tap in the Actions tab turns it back on.
- Scheduled runs can start late when GitHub is busy. That is why they are planned two to three
  hours before each draw.

The bot can also run anywhere Node.js runs: `cp .env.example .env`, fill it in, `npm run player`.

## Development

```bash
npm install
npm test            # contracts and bots, on a local chain
npm run test:web    # the page, in Chromium (CHROMIUM = path of the binary)
```

## What is verified, and what is not

Verified on a local chain with mock contracts: principal accounting, permissions, guards,
withdrawals, both play modes, both bots including Merkle proofs in the lottery's leaf format,
and the page in a real browser with a simulated wallet.

Verified on Avalanche through the page's dry run: creation, deposit, sale on the real pool,
purchase of a ticket on the real lottery, withdrawal.

**Not verified:**

1. **The prize computation is an assumption.** BCM builds its Merkle tree off-chain and does not
   publish the method. The bots recompute it (equal split per rank, system-play tickets counted
   per combination) and **compare their root with the on-chain root before sending anything**.
   If they differ, nothing is claimed; when a prize seems due for the wallet, the run fails so
   that somebody looks at it. The prize stays claimable by the ticket's owner (from the
   lottery's own site for a player wallet); `keeper/lib.js` then needs correcting.
2. **The player bot against the real chain.** It is tested against mocks that follow the
   lottery's verified source; its first real runs should be watched.
3. **How BCM attributes rewards to players** is not documented; the player mode makes the wallet
   an ordinary player, which is all a contract can do about it.

## Risks

- **Negative expectation.** On average the yield played is lost; this trades yield for variance.
- **The principal is protected in xPHAR, not in dollars.** It follows the price of p33.
- **The BCM lottery is recent and unaudited.** WAVAX committed to a draw depends on its contract,
  its Merkle root (set by a hot key) and its `emergencyWithdraw` (multisig).
- **These contracts are unaudited too.** Use amounts you can afford to lose.
- **The player wallet's key is held by the scheduler.** Whoever controls the repository controls
  that wallet: its ticket budget, its tickets, and a prize until the next pass moves it to the vault.
