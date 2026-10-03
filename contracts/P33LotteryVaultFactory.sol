// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {P33LotteryVault} from "./P33LotteryVault.sol";

/**
 * @title P33LotteryVaultFactory
 * @notice Deploys one vault per user. The caller is the owner of the vault created;
 *         the factory has no rights over it and never holds funds. It only sets
 *         the addresses (p33, WAVAX, lottery, swap pool) and keeps the registry of
 *         vaults so that the keeper can iterate over them.
 */
contract P33LotteryVaultFactory {
    address public immutable p33;
    address public immutable wavax;
    address public immutable lottery;
    /// @notice Default p33/WAVAX DLMM pool of the vaults created.
    address public immutable pool;
    /// @notice Keeper proposed by default. Each owner can change it on their own vault.
    address public immutable defaultKeeper;

    address[] public allVaults;
    mapping(address => address[]) internal _vaultsOf;

    event VaultCreated(address indexed owner, address vault);

    constructor(
        address p33_,
        address wavax_,
        address lottery_,
        address pool_,
        address defaultKeeper_
    ) {
        p33 = p33_;
        wavax = wavax_;
        lottery = lottery_;
        pool = pool_;
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
                pool,
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

    /// @notice Vaults created by `owner` (does not track later ownership transfers).
    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }
}
