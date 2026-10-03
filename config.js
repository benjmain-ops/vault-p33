// Configuration de la page.
window.VAULT_CONFIG = {
  // Adresse de la factory. Laisser vide : la page propose de la déployer depuis le wallet
  // à la première utilisation, puis s'en souvient (et fournit un lien à partager).
  factory: "",
  chainId: 43114,
  chainName: "Avalanche C-Chain",
  rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
  explorer: "https://snowscan.xyz",
  // Contrats utilisés lors du déploiement de la factory (Avalanche C-Chain).
  addresses: {
    p33: "0x26e9dbe75aed331e41272bece932ff1b48926ca9",
    wavax: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
    lottery: "0xb49a551aecd96b60a121fc9996c2812e9bf95186", // PartnerLotteryCore (BCM, loterie AVAX)
    // Pool DLMM p33/WAVAX de Pharaoh (bin step 25) : https://www.phar.gg/liquidity/0x7d94f880736c2558e039e573b9a8fe230d60297e
    pool: "0x7d94f880736c2558e039e573b9a8fe230d60297e",
  },
  // Optionnel : identifiant de projet Reown (WalletConnect), nécessaire sur iPhone.
  // Gratuit sur https://cloud.reown.com — laisser vide pour masquer le bouton.
  walletConnectProjectId: "",
};
