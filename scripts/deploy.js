// Déploie la factory sur Avalanche C-Chain. À faire une seule fois.
//   npm run deploy            -> liste les pools p33/WAVAX si TICK_SPACING n'est pas renseigné
//   TICK_SPACING=… npm run deploy
require("dotenv").config();
const { ethers } = require("ethers");
const artifact = require("../artifacts/P33LotteryVaultFactory.json");

const A = (x) => ethers.getAddress(x.toLowerCase());
const ADDR = {
  p33: A("0x26e9dbe75aed331E41272BEcE932Ff1B48926Ca9"),
  wavax: A("0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"),
  lottery: A("0xB49a551aecD96b60a121Fc9996C2812e9BF95186"), // PartnerLotteryCore (BCM, AVAX lottery)
  pool: A("0x7d94f880736c2558e039e573b9a8fe230d60297e"), // Pharaoh DLMM pool p33/WAVAX, bin step 25
};

(async () => {
  const { RPC_URL, DEPLOYER_PRIVATE_KEY, KEEPER_ADDRESS } = process.env;
  if (!RPC_URL) throw new Error("RPC_URL requis (.env)");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const { chainId } = await provider.getNetwork();
  if (chainId !== 43114n) throw new Error(`Mauvais réseau (chainId ${chainId}), attendu 43114`);

  const pool = process.env.POOL ? ethers.getAddress(process.env.POOL) : ADDR.pool;
  if (!DEPLOYER_PRIVATE_KEY || !KEEPER_ADDRESS) throw new Error("DEPLOYER_PRIVATE_KEY and KEEPER_ADDRESS are required (.env)");

  const wallet = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);
  console.log(`Déploiement depuis ${wallet.address}, keeper par défaut ${KEEPER_ADDRESS}, pool ${pool}…`);
  const factory = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet).deploy(
    ADDR.p33, ADDR.wavax, ADDR.lottery, pool, ethers.getAddress(KEEPER_ADDRESS)
  );
  await factory.waitForDeployment();
  console.log(`\nFactory déployée : ${factory.target}`);
  console.log(`-> docs/config.js : factory: "${factory.target}"`);
  console.log(`-> .env          : FACTORY=${factory.target}`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
