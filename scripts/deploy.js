// Deploys the factory on Avalanche C-Chain from the command line. One time only.
// The web page can do the same from a wallet (deterministic address); this script is the
// alternative for a computer:   npm run deploy      (POOL=0x… to use another pool)
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
  const { RPC_URL, DEPLOYER_PRIVATE_KEY } = process.env;
  if (!RPC_URL || !DEPLOYER_PRIVATE_KEY) throw new Error("RPC_URL and DEPLOYER_PRIVATE_KEY are required (.env)");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const { chainId } = await provider.getNetwork();
  if (chainId !== 43114n) throw new Error(`Wrong network (chainId ${chainId}), expected 43114`);

  const pool = process.env.POOL ? ethers.getAddress(process.env.POOL) : ADDR.pool;
  const wallet = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);
  console.log(`Deploying from ${wallet.address}, pool ${pool}…`);
  const factory = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet).deploy(ADDR.p33, ADDR.wavax, ADDR.lottery, pool);
  await factory.waitForDeployment();
  console.log(`\nFactory deployed: ${factory.target}`);
  console.log(`-> docs/config.js : factory: "${factory.target}"`);
  console.log(`-> .env           : FACTORY=${factory.target}`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
