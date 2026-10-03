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
  lottery: A("0xB49a551aecD96b60a121Fc9996C2812e9BF95186"), // PartnerLotteryCore (BCM, loterie AVAX)
  router: A("0xc8B8fCbDb5C019D7802fFb0b39603395D7d3915c"), // Pharaoh SwapRouter
  clFactory: A("0xAE6E5c62328ade73ceefD42228528b70c8157D0d"), // RamsesV3Factory
};

async function findPools(provider) {
  const f = new ethers.Contract(ADDR.clFactory, ["function getPool(address,address,int24) view returns (address)"], provider);
  const erc20 = new ethers.Contract(ADDR.wavax, ["function balanceOf(address) view returns (uint256)"], provider);
  const out = [];
  for (const ts of [1, 5, 10, 50, 100, 200]) {
    try {
      const pool = await f.getPool(ADDR.p33, ADDR.wavax, ts);
      if (pool !== ethers.ZeroAddress) out.push({ tickSpacing: ts, pool, wavax: ethers.formatEther(await erc20.balanceOf(pool)) });
    } catch (_) {}
  }
  return out;
}

(async () => {
  const { RPC_URL, DEPLOYER_PRIVATE_KEY, KEEPER_ADDRESS, TICK_SPACING } = process.env;
  if (!RPC_URL) throw new Error("RPC_URL requis (.env)");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const { chainId } = await provider.getNetwork();
  if (chainId !== 43114n) throw new Error(`Mauvais réseau (chainId ${chainId}), attendu 43114`);

  const pools = await findPools(provider);
  console.log("Pools p33/WAVAX (liquidité concentrée) :");
  console.table(pools);
  if (!TICK_SPACING) {
    console.log("Relance avec TICK_SPACING=<celui du pool le plus liquide>.");
    return;
  }
  const ts = Number(TICK_SPACING);
  if (pools.length && !pools.some((p) => p.tickSpacing === ts)) throw new Error(`Aucun pool p33/WAVAX avec tickSpacing ${ts}`);
  if (!DEPLOYER_PRIVATE_KEY || !KEEPER_ADDRESS) throw new Error("DEPLOYER_PRIVATE_KEY et KEEPER_ADDRESS requis (.env)");

  const wallet = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);
  console.log(`Déploiement depuis ${wallet.address}, keeper par défaut ${KEEPER_ADDRESS}, tickSpacing ${ts}…`);
  const factory = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet).deploy(
    ADDR.p33, ADDR.wavax, ADDR.lottery, ADDR.router, ts, ethers.getAddress(KEEPER_ADDRESS)
  );
  await factory.waitForDeployment();
  console.log(`\nFactory déployée : ${factory.target}`);
  console.log(`-> docs/config.js : factory: "${factory.target}"`);
  console.log(`-> .env          : FACTORY=${factory.target}`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
