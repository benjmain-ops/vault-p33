// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev p33 is an ERC-4626 whose asset is xPHAR.
interface IP33 {
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
}

/// @dev Pharaoh DLMM pool (Liquidity Book). We swap directly on the pool, the same way
///      its router does: we send it the input token, then call swap().
interface IDlmmPool {
    function getTokenX() external view returns (address);
    function getTokenY() external view returns (address);
    /// @dev Bin currently traded.
    function getActiveId() external view returns (uint24);
    /// @dev Price of token X in token Y at a given bin, as a 128.128 fixed-point number.
    function getPriceFromId(uint24 id) external view returns (uint256);
    function swap(bool swapForY, address to) external returns (bytes32 amountsOut);
}

/// @dev Subset of PartnerLotteryCore (BCM) used by the vault.
interface IBcmLottery {
    function token() external view returns (address);
    function ticketPrice() external view returns (uint256);
    function currentDrawId() external view returns (uint256);
    function claimable(address account) external view returns (uint256);

    function buyMultipleTickets(
        uint256 drawId,
        uint8[6][] calldata mainNumsArr,
        uint8[2][] calldata compNumsArr,
        bool[] calldata isFlashPick
    ) external; // return value deliberately not declared: nothing here depends on its shape

    function batchClaimTicketPrizes(
        uint256[] calldata ticketIds,
        uint8[] calldata ranks,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external;

    function claimWinnings() external;
}

/**
 * @title P33LotteryVault
 * @notice Single-user vault. The owner's p33 principal stays intact; only the
 *         yield (the rise of the p33:xPHAR ratio) is sold for WAVAX and spent on tickets
 *         of the BCM lottery.
 *
 * Roles:
 *  - owner  : deposits, withdraws, sets the guards. The only one able to take funds out.
 *  - keeper : triggers harvest / purchase / claim. Cannot withdraw anything; the harm it
 *             can do is bounded by the yield not yet spent.
 *
 * Accounting:
 *  - principalAssets : principal expressed in xPHAR (the asset of p33). As long as the ratio rises,
 *    less and less p33 is needed to cover it; the difference is the yield.
 *  - ticketBudget : WAVAX reserved for buying tickets (coming from the harvests).
 *  - The WAVAX beyond ticketBudget is made up of winnings; it is only played again up to
 *    reinvestCap per collection, so a large prize is never replayed down to zero.
 */
contract P33LotteryVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_TICKETS_PER_TX = 50; // PartnerLotteryCore limit

    IERC20 public immutable p33;
    IERC20 public immutable wavax;
    IBcmLottery public immutable lottery;

    address public keeper;
    /// @notice p33/WAVAX DLMM pool used to sell the yield.
    IDlmmPool public pool;
    /// @dev True if p33 is the pool's token X (we then sell X for Y).
    bool internal p33IsX;

    /// @notice Principal in xPHAR-equivalent.
    uint256 public principalAssets;
    /// @notice WAVAX reserved for tickets.
    uint256 public ticketBudget;
    /// @notice Optional absolute floor: WAVAX received per p33 sold, in 1e18. 0 = none.
    ///         The automatic protection below does not need it.
    uint256 public minWavaxPerP33;

    /// @notice Reference price, kept by the vault itself: the pool bin observed at an earlier
    ///         pass. A sale is refused if it would execute more than `maxDeviationBps` below the
    ///         price of that bin. Nothing to maintain by hand: the reference follows the market
    ///         from one pass to the next.
    uint24 public refId;
    /// @notice Time at which the reference was recorded.
    uint40 public refTime;
    /// @notice Maximum distance below the reference price accepted for a sale, in basis points.
    uint16 public maxDeviationBps;

    /// @dev The reference is only replaced once it is this old, so that it cannot be set and
    ///      used within the same transaction or block.
    uint256 public constant MIN_REF_AGE = 1 hours;
    uint16 internal constant MAX_DEVIATION_BPS = 5000;
    /// @notice Maximum price accepted for a ticket. 0 = purchase blocked.
    uint256 public maxTicketPrice;
    /// @notice Maximum WAVAX moved from collected winnings back into the ticket budget, per
    ///         collection. 0 = winnings are never played again.
    uint256 public reinvestCap;

    /// @dev Upper bound for the floor price, so that amount * floor cannot overflow.
    uint256 internal constant MAX_FLOOR = 1e36;

    event Deposited(uint256 shares, uint256 assets);
    event Withdrawn(address indexed to, uint256 shares);
    event Harvested(uint256 p33Sold, uint256 wavaxReceived);
    event TicketsBought(uint256 indexed drawId, uint256 count, uint256 cost);
    event PrizesClaimed(uint256 ticketCount);
    event WinningsCollected(uint256 amount, uint256 reinvested);
    event BudgetFunded(uint256 amount);
    event WavaxWithdrawn(address indexed to, uint256 amount);
    event KeeperSet(address keeper);
    event GuardsSet(uint256 minWavaxPerP33, uint256 maxTicketPrice, uint16 maxDeviationBps);
    event ReferenceUpdated(uint24 id);
    event PoolSet(address pool);
    event ReinvestCapSet(uint256 cap);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error NotOperator();
    error ZeroAddress();
    error ZeroAmount();
    error TokenMismatch();
    error ExceedsHarvestable(uint256 requested, uint256 available);
    error Slippage(uint256 received, uint256 minimum);
    error TicketPriceTooHigh(uint256 price, uint256 maxPrice);
    error NothingToBuy();
    error ProtectedToken();
    error WrongPool();
    error OnlySelf();
    error InvalidRecipient();
    error GuardTooHigh();
    error LotteryUnavailable();
    error RenounceDisabled();

    modifier onlyOperator() {
        if (msg.sender != keeper && msg.sender != owner()) revert NotOperator();
        _;
    }

    constructor(
        address owner_,
        address keeper_,
        address p33_,
        address wavax_,
        address lottery_,
        address pool_,
        uint16 maxDeviationBps_,
        uint256 maxTicketPrice_,
        uint256 reinvestCap_
    ) Ownable(owner_) {
        if (p33_ == address(0) || wavax_ == address(0) || lottery_ == address(0)) {
            revert ZeroAddress();
        }
        if (IBcmLottery(lottery_).token() != wavax_) revert TokenMismatch();
        p33 = IERC20(p33_);
        wavax = IERC20(wavax_);
        lottery = IBcmLottery(lottery_);
        keeper = keeper_;
        _setPool(pool_);
        if (maxDeviationBps_ == 0 || maxDeviationBps_ > MAX_DEVIATION_BPS) revert GuardTooHigh();
        maxDeviationBps = maxDeviationBps_;
        maxTicketPrice = maxTicketPrice_;
        reinvestCap = reinvestCap_;
    }

    /// @dev Renouncing ownership would lock every withdrawal forever: disabled.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ──────────────────────────────── Owner ─────────────────────────────────

    /// @notice Deposits p33 (prior approve required). The principal is locked in xPHAR at the current ratio.
    function deposit(uint256 shares) external onlyOwner nonReentrant {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = IP33(address(p33)).convertToAssets(shares);
        p33.safeTransferFrom(msg.sender, address(this), shares);
        principalAssets += assets;
        emit Deposited(shares, assets);
    }

    /// @notice Withdraws p33. The principal decreases by the value withdrawn.
    function withdraw(uint256 shares, address to) external onlyOwner nonReentrant {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        if (shares == 0) revert ZeroAmount();
        uint256 assets = IP33(address(p33)).convertToAssets(shares);
        principalAssets = assets >= principalAssets ? 0 : principalAssets - assets;
        p33.safeTransfer(to, shares);
        emit Withdrawn(to, shares);
    }

    /// @notice Withdraws all the p33 and resets the principal to zero.
    function withdrawAll(address to) external onlyOwner nonReentrant {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        uint256 shares = p33.balanceOf(address(this));
        principalAssets = 0;
        p33.safeTransfer(to, shares);
        emit Withdrawn(to, shares);
    }

    /// @notice Withdraws WAVAX (winnings first, then ticket budget if the amount exceeds them).
    ///         Pass type(uint256).max to withdraw the whole WAVAX balance.
    function withdrawWavax(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        if (amount == type(uint256).max) amount = wavax.balanceOf(address(this));
        wavax.safeTransfer(to, amount);
        uint256 bal = wavax.balanceOf(address(this));
        if (ticketBudget > bal) ticketBudget = bal;
        emit WavaxWithdrawn(to, amount);
    }

    /// @notice Adds WAVAX to the ticket budget, on top of the yield.
    function fundBudget(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        wavax.safeTransferFrom(msg.sender, address(this), amount);
        ticketBudget += amount;
        emit BudgetFunded(amount);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// @notice Guards: optional absolute floor price (0 = none), maximum ticket price, and the
    ///         maximum distance below the reference price accepted for a sale.
    function setGuards(uint256 minWavaxPerP33_, uint256 maxTicketPrice_, uint16 maxDeviationBps_) external onlyOwner {
        if (minWavaxPerP33_ > MAX_FLOOR) revert GuardTooHigh();
        if (maxDeviationBps_ == 0 || maxDeviationBps_ > MAX_DEVIATION_BPS) revert GuardTooHigh();
        minWavaxPerP33 = minWavaxPerP33_;
        maxTicketPrice = maxTicketPrice_;
        maxDeviationBps = maxDeviationBps_;
        emit GuardsSet(minWavaxPerP33_, maxTicketPrice_, maxDeviationBps_);
    }

    /// @notice Changes the swap pool (if the liquidity migrates). Must be a p33/WAVAX pool.
    function setPool(address pool_) external onlyOwner {
        _setPool(pool_);
    }

    /// @notice Sets how much of each collection of winnings is played again (0 = none).
    function setReinvestCap(uint256 cap) external onlyOwner {
        reinvestCap = cap;
        emit ReinvestCapSet(cap);
    }

    /// @notice Recovers a token sent by mistake (neither p33 nor WAVAX, which have their own exits).
    function rescue(address token_, uint256 amount, address to) external onlyOwner {
        if (token_ == address(p33) || token_ == address(wavax)) revert ProtectedToken();
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        IERC20(token_).safeTransfer(to, amount);
        emit Rescued(token_, to, amount);
    }

    // ─────────────────────────────── Views ──────────────────────────────────

    /// @notice p33 needed to cover the principal at the current ratio (rounded up).
    function principalShares() public view returns (uint256) {
        if (principalAssets == 0) return 0;
        return IP33(address(p33)).convertToShares(principalAssets) + 1;
    }

    /// @notice Excess p33, sellable without eating into the principal.
    function harvestable() public view returns (uint256) {
        uint256 bal = p33.balanceOf(address(this));
        uint256 needed = principalShares();
        return bal > needed ? bal - needed : 0;
    }

    /// @notice Price of one p33 in WAVAX (1e18) at the reference bin.
    function referencePrice() public view returns (uint256) {
        uint256 p = pool.getPriceFromId(refId); // token Y per token X, 128.128
        return p33IsX ? Math.mulDiv(p, 1e18, 1 << 128) : Math.mulDiv(1 << 128, 1e18, p);
    }

    /// @notice Lowest price (WAVAX per p33, 1e18) at which a sale is accepted right now.
    function floorPrice() public view returns (uint256 floor) {
        floor = (referencePrice() * (10_000 - maxDeviationBps)) / 10_000;
        if (minWavaxPerP33 > floor) floor = minWavaxPerP33;
    }

    /// @notice WAVAX held outside the ticket budget (winnings not played again).
    function winnings() external view returns (uint256) {
        return wavax.balanceOf(address(this)) - ticketBudget;
    }

    // ─────────────────────────────── Keeper ─────────────────────────────────

    /**
     * @notice The whole cycle in one transaction: claims and collects the winnings, sells the
     *         yield, buys the tickets.
     *
     * Each step is tolerant: if one of them cannot be done (price below the floor,
     * draw closed, lottery paused, nothing to claim), it is skipped and the others
     * still run. The owner's guards apply as they do elsewhere.
     *
     * @param harvestAmount p33 to sell. 0 = do not sell; type(uint256).max = all the yield.
     * @param minOut        Minimum WAVAX expected from the swap (the owner's floor applies on top).
     * @param maxTickets    Maximum number of tickets to buy (50 at most per transaction).
     * @param ticketIds     The vault's winning tickets to claim, with ranks, amounts and Merkle
     *                      proofs computed off-chain. Empty arrays if there is nothing to claim.
     */
    function cycle(
        uint256 harvestAmount,
        uint256 minOut,
        uint256 maxTickets,
        uint256[] calldata ticketIds,
        uint8[] calldata ranks,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external onlyOperator nonReentrant returns (uint256 harvested, uint256 ticketsBought, uint256 collected) {
        if (ticketIds.length > 0) {
            try lottery.batchClaimTicketPrizes(ticketIds, ranks, amounts, proofs) {
                emit PrizesClaimed(ticketIds.length);
            } catch {}
        }
        collected = _collect();

        if (harvestAmount > 0) {
            uint256 available = harvestable();
            if (harvestAmount > available) harvestAmount = available;
            harvested = _harvest(harvestAmount, minOut, false);
        }
        ticketsBought = _buy(maxTickets, false);
    }

    /**
     * @notice Sells `amountIn` excess p33 for WAVAX, credited to the ticket budget.
     * @param minOut Minimum expected by the caller. The owner's floor applies
     *               on top: the stricter of the two prevails.
     */
    function harvest(uint256 amountIn, uint256 minOut) external onlyOperator nonReentrant returns (uint256 out) {
        if (amountIn == 0) revert ZeroAmount();
        uint256 available = harvestable();
        if (amountIn > available) revert ExceedsHarvestable(amountIn, available);
        out = _harvest(amountIn, minOut, true);
    }

    /**
     * @notice Buys as many tickets (random picks) as the budget allows on the
     *         current draw, capped by `maxTickets` and by 50 per transaction.
     *         To be called again as long as the budget still covers a ticket.
     */
    function buyTickets(uint256 maxTickets) external onlyOperator nonReentrant returns (uint256 count) {
        count = _buy(maxTickets, true);
    }

    /**
     * @notice Relays the Merkle proofs of the vault's winning tickets, then collects.
     *         The proofs are verified by the lottery: an invalid proof is ignored.
     */
    function claimPrizes(
        uint256[] calldata ticketIds,
        uint8[] calldata ranks,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external onlyOperator nonReentrant {
        lottery.batchClaimTicketPrizes(ticketIds, ranks, amounts, proofs);
        emit PrizesClaimed(ticketIds.length);
        _collect();
    }

    /// @notice Collects the winnings already recognized by the lottery (97% after its fees).
    function collectWinnings() external onlyOperator nonReentrant {
        _collect();
    }

    // ─────────────────────────────── Internal ───────────────────────────────

    /// @dev `strict`: any failure makes the transaction revert. Otherwise the step is skipped.
    function _harvest(uint256 amountIn, uint256 minOut, bool strict) internal returns (uint256 out) {
        if (amountIn == 0) return 0;

        // The stricter of the caller's minimum and the vault's own floor prevails.
        uint24 currentId = pool.getActiveId();
        uint256 floorOut = Math.mulDiv(amountIn, floorPrice(), 1e18);
        if (minOut < floorOut) minOut = floorOut;

        bool done = true;
        if (strict) {
            out = _swap(amountIn, minOut);
        } else {
            // External call to itself: if the swap fails (price below the floor, empty pool),
            // everything is reverted, including the transfer of the p33 to the pool, and the step is skipped.
            try this.swapForCycle(amountIn, minOut) returns (uint256 o) {
                out = o;
            } catch {
                done = false;
            }
        }

        // The reference follows the market from one pass to the next, whether or not the sale
        // went through: after a real move beyond the tolerance, the next pass sells again.
        if (block.timestamp - refTime >= MIN_REF_AGE) _setReference(currentId);
        if (!done) return 0;

        ticketBudget += out;
        emit Harvested(amountIn, out);
    }

    function _setReference(uint24 id) internal {
        refId = id;
        refTime = uint40(block.timestamp);
        emit ReferenceUpdated(id);
    }

    /// @dev Reserved for the vault itself (see _harvest). Does nothing other than a bounded swap.
    function swapForCycle(uint256 amountIn, uint256 minOut) external returns (uint256) {
        if (msg.sender != address(this)) revert OnlySelf();
        return _swap(amountIn, minOut);
    }

    /// @dev Sends the p33 to the pool, swaps, and checks the WAVAX received against the actual balance.
    function _swap(uint256 amountIn, uint256 minOut) internal returns (uint256 out) {
        uint256 before = wavax.balanceOf(address(this));
        p33.safeTransfer(address(pool), amountIn);
        pool.swap(p33IsX, address(this));
        out = wavax.balanceOf(address(this)) - before;
        if (out < minOut) revert Slippage(out, minOut);
    }

    function _setPool(address pool_) internal {
        if (pool_ == address(0)) revert ZeroAddress();
        address x = IDlmmPool(pool_).getTokenX();
        address y = IDlmmPool(pool_).getTokenY();
        if (x == address(p33) && y == address(wavax)) p33IsX = true;
        else if (x == address(wavax) && y == address(p33)) p33IsX = false;
        else revert WrongPool();
        pool = IDlmmPool(pool_);
        emit PoolSet(pool_);
        _setReference(IDlmmPool(pool_).getActiveId());
    }

    function _buy(uint256 maxTickets, bool strict) internal returns (uint256 n) {
        // The lottery is an external contract: in tolerant mode, none of its failures may
        // block the rest of the cycle, not even a reverting view.
        uint256 price;
        try lottery.ticketPrice() returns (uint256 p) {
            price = p;
        } catch {
            if (strict) revert LotteryUnavailable();
            return 0;
        }
        if (price > maxTicketPrice) {
            if (strict) revert TicketPriceTooHigh(price, maxTicketPrice);
            return 0;
        }
        n = price == 0 ? 0 : ticketBudget / price;
        if (n > maxTickets) n = maxTickets;
        if (n > MAX_TICKETS_PER_TX) n = MAX_TICKETS_PER_TX;
        if (n == 0) {
            if (strict) revert NothingToBuy();
            return 0;
        }

        uint256 drawId;
        try lottery.currentDrawId() returns (uint256 d) {
            drawId = d;
        } catch {
            if (strict) revert LotteryUnavailable();
            return 0;
        }
        uint8[6][] memory mains = new uint8[6][](n);
        uint8[2][] memory comps = new uint8[2][](n);
        bool[] memory flash = new bool[](n);
        for (uint256 i = 0; i < n; i++) flash[i] = true;

        uint256 before = wavax.balanceOf(address(this));
        wavax.forceApprove(address(lottery), n * price);
        if (strict) {
            lottery.buyMultipleTickets(drawId, mains, comps, flash);
        } else {
            try lottery.buyMultipleTickets(drawId, mains, comps, flash) {} catch {
                wavax.forceApprove(address(lottery), 0);
                return 0;
            }
        }
        wavax.forceApprove(address(lottery), 0);

        // Trust the balance. The clamps keep the accounting safe even if the lottery misbehaves.
        uint256 afterBal = wavax.balanceOf(address(this));
        uint256 spent = before > afterBal ? before - afterBal : 0;
        ticketBudget = spent >= ticketBudget ? 0 : ticketBudget - spent;
        emit TicketsBought(drawId, n, spent);
    }

    function _collect() internal returns (uint256 received) {
        try lottery.claimable(address(this)) returns (uint256 pending) {
            if (pending == 0) return 0;
        } catch {
            return 0;
        }
        uint256 before = wavax.balanceOf(address(this));
        try lottery.claimWinnings() {} catch {
            return 0;
        }
        uint256 afterBal = wavax.balanceOf(address(this));
        received = afterBal > before ? afterBal - before : 0;
        uint256 reinvested = received < reinvestCap ? received : reinvestCap;
        ticketBudget += reinvested;
        emit WinningsCollected(received, reinvested);
    }
}
