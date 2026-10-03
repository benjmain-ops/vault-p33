// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {P33LotteryVault} from "./P33LotteryVault.sol";

/**
 * @title P33LotteryVaultFactory
 * @notice Déploie un vault par utilisateur. L'appelant est le propriétaire du vault créé ;
 *         la factory n'a aucun droit dessus et ne détient jamais de fonds. Elle fixe
 *         seulement les adresses (p33, WAVAX, loterie, router) et tient le registre des
 *         vaults pour que le keeper puisse les parcourir.
 */
contract P33LotteryVaultFactory {
    address public immutable p33;
    address public immutable wavax;
    address public immutable lottery;
    address public immutable router;
    int24 public immutable tickSpacing;
    /// @notice Keeper proposé par défaut. Chaque propriétaire peut le changer sur son vault.
    address public immutable defaultKeeper;

    address[] public allVaults;
    mapping(address => address[]) internal _vaultsOf;

    event VaultCreated(address indexed owner, address vault);

    constructor(
        address p33_,
        address wavax_,
        address lottery_,
        address router_,
        int24 tickSpacing_,
        address defaultKeeper_
    ) {
        p33 = p33_;
        wavax = wavax_;
        lottery = lottery_;
        router = router_;
        tickSpacing = tickSpacing_;
        defaultKeeper = defaultKeeper_;
    }

    function createVault(uint256 minWavaxPerP33, uint256 maxTicketPrice, bool reinvestWinnings)
        external
        returns (address vault)
    {
        vault = address(
            new P33LotteryVault(
                msg.sender,
                defaultKeeper,
                p33,
                wavax,
                lottery,
                router,
                tickSpacing,
                minWavaxPerP33,
                maxTicketPrice,
                reinvestWinnings
            )
        );
        allVaults.push(vault);
        _vaultsOf[msg.sender].push(vault);
        emit VaultCreated(msg.sender, vault);
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }

    /// @notice Vaults créés par `owner` (ne suit pas les transferts de propriété ultérieurs).
    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }
}
