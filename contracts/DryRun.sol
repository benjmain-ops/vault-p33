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
        bool cycled; // a scheduled pass through cycle() does not revert
        uint256 p33Sold;
        uint256 wavaxOut;
        bool bought; // tickets bought on the lottery
        uint256 ticketPrice;
        uint256 tickets;
        bool paidOut; // "player wallet" mode: the remaining budget is sent to the player
        uint256 paid;
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
        try new P33LotteryVaultFactory(p33, wavax, lottery, pool) returns (P33LotteryVaultFactory f) {
            // same guard as a real vault: a sale more than 10% below the pool's price is refused
            try f.createVault(1000, type(uint256).max, 0, address(0), address(0)) returns (address a) {
                v = P33LotteryVault(payable(a));
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
        (r.deposited,) = _step(r, address(v), abi.encodeCall(v.deposit, (depositAmount)));
        if (!r.deposited) return r;

        IERC20(p33).transfer(address(v), yieldAmount);
        _play(r, v);
        _exit(r, v, IERC20(p33), IERC20(wavax));
    }

    /// @dev The simulated yield is sold with harvest() (strict: a failure gives its reason), then
    ///      cycle() is called the way a scheduled pass would call it: that covers the lottery
    ///      views it reads and the refresh of the reference price. Then tickets are bought.
    function _play(Report memory r, P33LotteryVault v) private {
        uint256 amount = v.harvestable();
        (bool ok, bytes memory ret) = _step(r, address(v), abi.encodeCall(v.harvest, (amount, 0)));
        if (ok) {
            r.swapped = true;
            r.p33Sold = amount;
            r.wavaxOut = abi.decode(ret, (uint256));
        }
        (r.cycled,) = _step(r, address(v), _cycle(v, type(uint256).max));

        try v.lottery().ticketPrice() returns (uint256 price) {
            r.ticketPrice = price;
        } catch {}
        if (r.swapped) {
            (ok, ret) = _step(r, address(v), abi.encodeCall(v.buyTickets, (50)));
            if (ok) {
                r.bought = true;
                r.tickets = abi.decode(ret, (uint256));
            }
        }
    }

    /// @dev "Player wallet" mode: what is left of the budget must reach the player on the next
    ///      pass. Then everything is withdrawn.
    function _exit(Report memory r, P33LotteryVault v, IERC20 p33, IERC20 wavax) private {
        uint256 p33Before = p33.balanceOf(address(this));
        uint256 wavaxBefore = wavax.balanceOf(address(this));
        uint256 budget = v.ticketBudget();
        (bool ok,) = _step(r, address(v), abi.encodeCall(v.setPlayer, (address(this))));
        if (ok) (ok,) = _step(r, address(v), _cycle(v, 0));
        if (ok) {
            r.paid = wavax.balanceOf(address(this)) - wavaxBefore;
            r.paidOut = r.paid == budget;
            wavaxBefore += r.paid;
        }

        (ok,) = _step(r, address(v), abi.encodeCall(v.withdrawAll, (address(this))));
        if (ok) {
            (r.withdrawn,) = _step(r, address(v), abi.encodeCall(v.withdrawWavax, (type(uint256).max, address(this))));
            r.p33Back = p33.balanceOf(address(this)) - p33Before;
            r.wavaxBack = wavax.balanceOf(address(this)) - wavaxBefore;
        }
    }

    function _cycle(P33LotteryVault v, uint256 harvestAmount) private pure returns (bytes memory) {
        uint256[] memory noIds;
        uint8[] memory noRanks;
        bytes32[][] memory noProofs;
        return abi.encodeCall(v.cycle, (harvestAmount, 0, 0, noIds, noRanks, noIds, noProofs));
    }

    /// @dev Runs one step; keeps the revert data of the first step that fails.
    function _step(Report memory r, address target, bytes memory data) private returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call(data);
        if (!ok && r.error.length == 0) r.error = ret;
    }
}
