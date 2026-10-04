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

    address[] public allVaults;
    /// @notice True for every vault created by this factory.
    mapping(address => bool) public isVault;
    mapping(address => address[]) internal _vaultsOf;

    event VaultCreated(address indexed owner, address vault);

    constructor(
        address p33_,
        address wavax_,
        address lottery_,
        address pool_
    ) {
        p33 = p33_;
        wavax = wavax_;
        lottery = lottery_;
        pool = pool_;
    }

    /// @param keeper Address allowed to run the cycle besides the owner (0 = nobody).
    /// @param player Wallet that receives the ticket budget and plays in its own name
    ///               (0 = the vault buys the tickets itself).
    function createVault(
        uint16 maxDeviationBps,
        uint256 maxTicketPrice,
        uint256 reinvestCap,
        address keeper,
        address player
    ) external returns (address vault) {
        vault = address(
            new P33LotteryVault(
                msg.sender,
                keeper,
                p33,
                wavax,
                lottery,
                pool,
                maxDeviationBps,
                maxTicketPrice,
                reinvestCap,
                player
            )
        );
        allVaults.push(vault);
        isVault[vault] = true;
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
