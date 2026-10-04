# Vault p33 → loterie BCM

Chaque utilisateur déploie **son propre vault**, dont il est seul propriétaire. Son p33 y reste
intact ; seul le rendement hebdomadaire (hausse du ratio p33:xPHAR) est vendu en WAVAX et
dépensé en tickets de la loterie BCM (`PartnerLotteryCore`, Avalanche C-Chain).

## Ce que contient le projet

| Élément | Fichier | Rôle |
|---|---|---|
| Vault | `contracts/P33LotteryVault.sol` | Dépôt, retrait, et `cycle` : encaissement des gains, vente du rendement et achat de tickets en une transaction |
| Factory | `contracts/P33LotteryVaultFactory.sol` | Un vault par utilisateur, registre pour le robot |
| Robot (keeper) | `keeper/` | Vend le rendement, achète les tickets, réclame les gains, pour tous les vaults |
| Page web | `docs/` | Connexion wallet, création du vault, dépôt, retrait, réglages |
| Tests | `test/` | 15 tests contrat + robot, 1 parcours complet de la page dans un navigateur |

## Qui peut faire quoi

- **Propriétaire du vault** : dépose, retire le p33 et le WAVAX à tout moment, règle les garde-fous, change de robot.
- **Robot** : `cycle` (tout en une transaction), ou ses étapes séparées `harvest`, `buyTickets`, `claimPrizes`, `collectWinnings`. Aucun retrait possible. Au pire, un robot compromis gaspille le rendement non encore dépensé, dans la limite des garde-fous.
- **Factory** : aucun droit sur les vaults, ne détient jamais de fonds.

Garde-fous réglés par le propriétaire :

- Cours de référence automatique : le vault retient le cours du pool à chaque passage et refuse de vendre plus de `maxDeviationBps` (10 % par défaut) en dessous. Rien à tenir à jour. `minWavaxPerP33` reste disponible comme plancher absolu facultatif (0 = aucun).
- `maxTicketPrice` : prix maximum d'un ticket. Le prix est modifiable par une clé chaude côté BCM ; ce plafond évite qu'un prix anormal vide le budget.
- `reinvestCap` : montant maximum de gains rejoué à chaque encaissement (0 = rien n'est rejoué). Un gros gain n'est donc jamais rejoué en entier.

## Tout faire depuis le téléphone (sans ordinateur ni robot)

1. Héberger le dossier `docs/` sur une adresse HTTPS (voir « Publier la page »).
2. Ouvrir cette adresse dans le navigateur de Trust Wallet et connecter le wallet.
3. **Première installation** : la page propose de déployer la factory. Elle détecte le pool
   p33/WAVAX, tu signes une transaction, c'est fait une fois pour toutes. Elle affiche ensuite
   un lien `?factory=0x…` à partager : chaque personne qui l'ouvre crée son propre vault.
4. Créer son vault, déposer son p33.
5. Une fois par semaine (à partir du vendredi), ou quand tu veux : **« Lancer le cycle
   maintenant »**. Une transaction réclame et encaisse les gains, vend le rendement et achète
   les tickets. La page calcule elle-même les preuves des tickets gagnants.

Aucune clé privée n'est jamais écrite dans un fichier : tout est signé par le wallet.
Le robot (ci-dessous) devient une option, pour ne plus avoir à appuyer sur le bouton.

## Mise en route sur ordinateur

```bash
npm install
npm test            # contrats + robot, sur une chaîne locale
npm run test:web    # la page, dans Chromium (variable CHROMIUM = chemin du binaire)
cp .env.example .env
```

### 1. Déployer la factory (une seule fois) — ou le faire depuis la page, voir plus haut

```bash
npm run deploy                    # utilise le pool DLMM p33/WAVAX par défaut (variable POOL pour en changer)
```

Renseigner d'abord dans `.env` : `DEPLOYER_PRIVATE_KEY`, et `KEEPER_ADDRESS` (l'adresse publique
de la clé du robot). Reporter ensuite l'adresse affichée dans `docs/config.js` et dans `.env` (`FACTORY`).

### 2. Publier la page

Sur GitHub : Settings → Pages → « Deploy from a branch », branche `main`, dossier `/docs`.

Le dossier `docs/` est statique : n'importe quel hébergement HTTPS convient (ou IPFS).
`ethers` est servi en local, sans CDN. Sur iPhone, renseigner `walletConnectProjectId` dans
`config.js` (identifiant gratuit sur cloud.reown.com).

À la première connexion, l'utilisateur crée son vault (1 transaction), puis dépose
(autorisation + dépôt). Ensuite la page retrouve son vault toute seule.

### 3. Lancer le robot

```bash
DRY_RUN=1 npm run keeper run   # affiche ce qui serait fait
npm run keeper run             # un cycle sur tous les vaults de la factory
npm run keeper status
```

En cron, deux passages par jour suffisent, par exemple :

```
15 7,19 * * *  cd /chemin/p33-lottery-vault && npm run keeper run >> keeper.log 2>&1
```

Le robot ne vend le rendement qu'entre le vendredi 01:00 UTC et le mercredi 22:00 UTC : le
ratio p33 monte pendant les 24 h qui suivent le changement d'epoch du jeudi 00:00 UTC. À chaque
passage, il envoie **une transaction `cycle` par vault** : gains réclamés et encaissés, rendement
vendu, tickets achetés. Une étape impossible (cours sous le plancher, tirage clos, loterie en
pause) est sautée sans bloquer les autres. Des transactions supplémentaires ne suivent que s'il
reste plus de 20 tickets à acheter ou plus de 50 gains à réclamer.

Le robot paie le gas de tous les vaults. Il affiche son solde à chaque passage et signale
quand il passe sous `MIN_GAS_AVAX` (0,05 AVAX par défaut). Sans gas, rien n'est perdu : tout
reprend au passage suivant, et le bouton « Lancer le cycle maintenant » de la page fait la
même chose avec le wallet du propriétaire (hors réclamation des gains, qui demande les preuves).

## Ce qui est vérifié, et ce qui ne l'est pas

Vérifié ici, sur une chaîne locale avec des contrats simulés :

- la comptabilité du principal, les droits, les garde-fous, les retraits ;
- le cycle complet du robot, preuves Merkle comprises, au format de feuille exact de la loterie ;
- le parcours de la page dans un vrai navigateur avec un wallet simulé : déploiement de la factory, création du vault, dépôt, cycle, gain réclamé et retiré, lecture seule pour un autre wallet.

**Non vérifié**, faute d'accès au réseau Avalanche depuis l'environnement de construction :

1. **Aucun test sur un fork du mainnet.** Le swap par le vrai router Pharaoh, le vrai p33 et la vraie loterie n'ont pas été exécutés. Les interfaces ont été relevées dans le code vérifié de chaque contrat, mais le premier essai réel doit se faire avec un petit montant.
2. **Le calcul des gains est une hypothèse.** BCM calcule l'arbre Merkle hors chaîne et ne publie pas sa méthode. Le robot le recalcule (partage égal par rang, tickets « system play » comptés par combinaison) et **compare sa racine à la racine on-chain avant d'envoyer quoi que ce soit**. Si elles diffèrent, il l'écrit dans le journal et ne réclame rien. Les gains ne sont pas perdus (un ticket gagnant non réclamé n'a pas de date limite dans le contrat), mais **ils ne peuvent être réclamés que par le vault**, propriétaire des tickets : il faudra corriger `keeper/lib.js`, ou obtenir les preuves auprès de BCM et les passer à `claimPrizes`. Le site de BCM ne peut pas réclamer à la place du vault.
3. **Trust Wallet et WalletConnect** n'ont pas été essayés en réel, notamment le déploiement d'un contrat depuis le navigateur de l'app.
4. **Le gas d'un lot de 20 tickets** sur la vraie loterie : réduire `buyChunk` dans `keeper/index.js` si la transaction dépasse la limite.

## Risques à connaître

- **Espérance négative.** Le rendement joué est perdu en moyenne ; c'est un échange rendement contre variance.
- **Le principal est garanti en xPHAR, pas en dollars.** Il suit le cours du p33.
- **La loterie BCM est récente et non auditée.** Les WAVAX engagés dans un tirage dépendent de son contrat, de sa racine Merkle (clé chaude) et de son `emergencyWithdraw` (multisig).
- **Ces contrats ne sont pas audités non plus.**
- **Cadre légal.** Proposer au public l'accès à un jeu d'argent est réglementé en France (ANJ). Chaque utilisateur garde ses fonds, ce qui écarte la mutualisation, mais la diffusion de la page mérite un avis juridique avant ouverture au-delà d'un cercle privé.
