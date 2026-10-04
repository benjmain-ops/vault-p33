// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {P33LotteryVault} from "./P33LotteryVault.sol";
import {P33LotteryVaultFactory} from "./P33LotteryVaultFactory.sol";

/**
 * @title DryRun
 * @notice Never deployed. Its code is injected at a p33 holder's address with an `eth_call`
 *         state override, so the whole flow runs against the real chain state (real p33, real
 *         DLMM pool, real lottery) without sending any transaction or spending any gas.
 *
 * Each step is isolated: a failing step is reported with its revert data and the next ones
 * still run when they can.
 */
contract DryRun {
    struct Report {
        bool created; // factory + vault deployed
        bool deposited; // p33 deposited, principal recorded
        bool swapped; // yield sold on the pool through harvest()
        bool cycled; // remaining yield sold through cycle(): covers the lottery views and the self-call swap
        uint256 p33Sold;
        uint256 wavaxOut;
        bool bought; // tickets bought on the lottery
        uint256 ticketPrice;
        uint256 tickets;
        bool withdrawn; // p33 and WAVAX withdrawn back
        uint256 p33Back;
        uint256 wavaxBack;
        bytes error; // revert data of the first failing step
    }

    /// @param depositAmount p33 deposited as principal.
    /// @param yieldAmount   p33 sent on top of it to stand for one epoch of yield.
    function run(address p33, address wavax, address lottery, address pool, uint256 depositAmount, uint256 yieldAmount)
        external
        returns (Report memory r)
    {
        P33LotteryVault v;
        try new P33LotteryVaultFactory(p33, wavax, lottery, pool, address(0)) returns (P33LotteryVaultFactory f) {
            // floor of 1 wei so the sale is never refused: the point is to observe the real price
            try f.createVault(1, type(uint256).max, 0) returns (address a) {
                v = P33LotteryVault(a);
                r.created = true;
            } catch (bytes memory e) {
                r.error = e;
                return r;
            }
        } catch (bytes memory e) {
            r.error = e;
            return r;
        }

        IERC20(p33).approve(address(v), depositAmount);
        try v.deposit(depositAmount) {
            r.deposited = true;
        } catch (bytes memory e) {
            r.error = e;
            return r;
        }

        // Half of the simulated yield goes through harvest() (strict: a failure gives its reason),
        // the other half through cycle(), the path used in normal operation.
        IERC20(p33).transfer(address(v), yieldAmount);
        uint256 half = v.harvestable() / 2;
        try v.harvest(half, 0) returns (uint256 out) {
            r.swapped = true;
            r.p33Sold = half;
            r.wavaxOut = out;
        } catch (bytes memory e) {
            r.error = e;
        }

        uint256[] memory noIds;
        uint8[] memory noRanks;
        bytes32[][] memory noProofs;
        uint256 rest = v.harvestable();
        try v.cycle(type(uint256).max, 0, 0, noIds, noRanks, noIds, noProofs) returns (uint256 harvested, uint256, uint256) {
            if (harvested > 0) {
                r.cycled = true;
                r.p33Sold += rest;
                r.wavaxOut += harvested;
            }
        } catch (bytes memory e) {
            if (r.error.length == 0) r.error = e;
        }

        try v.lottery().ticketPrice() returns (uint256 price) {
            r.ticketPrice = price;
        } catch {}
        if (r.swapped || r.cycled) {
            try v.buyTickets(50) returns (uint256 n) {
                r.bought = true;
                r.tickets = n;
            } catch (bytes memory e) {
                if (r.error.length == 0) r.error = e;
            }
        }

        uint256 p33Before = IERC20(p33).balanceOf(address(this));
        uint256 wavaxBefore = IERC20(wavax).balanceOf(address(this));
        try v.withdrawAll(address(this)) {
            try v.withdrawWavax(type(uint256).max, address(this)) {
                r.withdrawn = true;
            } catch (bytes memory e) {
                if (r.error.length == 0) r.error = e;
            }
            r.p33Back = IERC20(p33).balanceOf(address(this)) - p33Before;
            r.wavaxBack = IERC20(wavax).balanceOf(address(this)) - wavaxBefore;
        } catch (bytes memory e) {
            if (r.error.length == 0) r.error = e;
        }
    }
}
