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
    /// @dev Width of a bin, in basis points.
    function getBinStep() external view returns (uint16);
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
 * Two ways to play:
 *  - `player` unset: the vault buys the tickets itself and holds them.
 *  - `player` set: the vault only produces the budget. Each pass sends the WAVAX from the
 *    yield to that wallet, which buys the tickets in its own name. This is the mode to use
 *    when the lottery account must be an ordinary wallet (profile, referral, rewards).
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
    /// @notice If set, the ticket budget is paid out to this wallet instead of being spent by the vault.
    address public player;
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

    /// @notice Reference price, kept by the vault itself: a pool bin recorded at an earlier pass.
    ///         A sale is refused if it would execute more than `maxDeviationBps` below the price
    ///         of that bin. Nothing to maintain by hand: every pass moves the reference towards
    ///         the market, by at most `maxDeviationBps` at a time, and a reference written by a
    ///         pass cannot be sold against until it is MIN_REF_AGE old. A manipulated price at
    ///         the time of one pass can therefore neither be used in that pass nor drag the
    ///         reference far.
    uint24 public refId;
    /// @notice Time at which the reference was recorded by a pass (0 = set by the owner).
    uint40 public refTime;
    /// @notice Maximum distance below the reference price accepted for a sale, in basis points.
    uint16 public maxDeviationBps;
    /// @dev Bin width of the pool, in basis points.
    uint16 internal binStep;

    uint256 public constant MIN_REF_AGE = 6 hours;
    uint16 internal constant MIN_DEVIATION_BPS = 100;
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
    event PlayerSet(address player);
    event PaidOut(address indexed player, uint256 amount);
    event GuardsSet(uint256 minWavaxPerP33, uint256 maxTicketPrice, uint16 maxDeviationBps);
    event ReferenceUpdated(uint24 id);
    event PoolSet(address pool);
    event ReinvestCapSet(uint256 cap);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event Executed(address indexed target, uint256 value, bytes data);

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
    error ReferenceTooRecent();
    error PoolUnavailable();
    error NotAContract();
    error PlayerMode();

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
        uint256 reinvestCap_,
        address player_
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
        if (maxDeviationBps_ < MIN_DEVIATION_BPS || maxDeviationBps_ > MAX_DEVIATION_BPS) revert GuardTooHigh();
        maxDeviationBps = maxDeviationBps_;
        maxTicketPrice = maxTicketPrice_;
        reinvestCap = reinvestCap_;
        if (player_ == address(this)) revert InvalidRecipient();
        player = player_;
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

    /// @notice Sets the wallet that receives the ticket budget and plays in its own name.
    ///         address(0) = the vault buys the tickets itself.
    function setPlayer(address player_) external onlyOwner {
        if (player_ == address(this)) revert InvalidRecipient();
        player = player_;
        emit PlayerSet(player_);
    }

    /// @notice Guards: optional absolute floor price (0 = none), maximum ticket price, and the
    ///         maximum distance below the reference price accepted for a sale.
    function setGuards(uint256 minWavaxPerP33_, uint256 maxTicketPrice_, uint16 maxDeviationBps_) external onlyOwner {
        if (minWavaxPerP33_ > MAX_FLOOR) revert GuardTooHigh();
        if (maxDeviationBps_ < MIN_DEVIATION_BPS || maxDeviationBps_ > MAX_DEVIATION_BPS) revert GuardTooHigh();
        minWavaxPerP33 = minWavaxPerP33_;
        maxTicketPrice = maxTicketPrice_;
        maxDeviationBps = maxDeviationBps_;
        emit GuardsSet(minWavaxPerP33_, maxTicketPrice_, maxDeviationBps_);
    }

    /// @notice Changes the swap pool (if the liquidity migrates). Must be a p33/WAVAX pool.
    function setPool(address pool_) external onlyOwner nonReentrant {
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

    /**
     * @notice Makes the vault call any contract, on the owner's order. This is what lets the
     *         owner collect whatever the vault earns as a player (reward tokens to claim, NFTs
     *         to move out), in any form the lottery may choose later.
     *
     * Owner only: the keeper has no access to it. p33 and WAVAX cannot be targeted: they have
     * their own exits (withdraw, withdrawWavax), and a direct call would let the vault use an
     * allowance somebody granted it by mistake.
     */
    function execute(address target, uint256 value, bytes calldata data)
        external
        payable
        onlyOwner
        nonReentrant
        returns (bytes memory result)
    {
        if (target == address(0) || target == address(this)) revert InvalidRecipient();
        if (target == address(p33) || target == address(wavax)) revert ProtectedToken();
        // A call with data to an address without code would "succeed" while doing nothing.
        if (data.length > 0 && target.code.length == 0) revert NotAContract();
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        // If the call moved WAVAX out, keep the budget consistent with the balance.
        uint256 bal = wavax.balanceOf(address(this));
        if (ticketBudget > bal) ticketBudget = bal;
        emit Executed(target, value, data);
    }

    /// @dev Native AVAX can be received (a reward, a refund) and sent out with execute().
    receive() external payable {}

    // The vault accepts NFTs sent with the "safe" transfer functions.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x150b7a02 || interfaceId == 0x4e2312e0;
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
        uint256 bal = wavax.balanceOf(address(this));
        return bal > ticketBudget ? bal - ticketBudget : 0;
    }

    // ─────────────────────────────── Keeper ─────────────────────────────────

    /**
     * @notice The whole cycle in one transaction: claims and collects the winnings, sells the
     *         yield, then buys the tickets, or sends the budget to the player's wallet if one
     *         is set.
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
            // p33 is an external contract too: if its conversion reverts, the sale is skipped.
            try this.harvestable() returns (uint256 available) {
                if (harvestAmount > available) harvestAmount = available;
                harvested = _harvest(harvestAmount, minOut, false);
            } catch {}
        }
        // Every pass moves the reference towards the market, whether or not something was sold.
        _refreshReference();
        if (player != address(0)) _payout();
        else ticketsBought = _buy(maxTickets, false);
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
        _refreshReference();
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

        // A reference written by a pass is only sold against once it is old enough: it cannot
        // be set and used within the same transaction, block or hour.
        if (block.timestamp - refTime < MIN_REF_AGE) {
            if (strict) revert ReferenceTooRecent();
            return 0;
        }

        // The stricter of the caller's minimum and the vault's own floor prevails.
        uint256 floor;
        try this.floorPrice() returns (uint256 f) {
            floor = f;
        } catch {
            if (strict) revert PoolUnavailable();
            return 0;
        }
        uint256 floorOut = Math.mulDiv(amountIn, floor, 1e18);
        if (minOut < floorOut) minOut = floorOut;

        if (strict) {
            out = _swap(amountIn, minOut);
        } else {
            // External call to itself: if the swap fails (price below the floor, empty pool),
            // everything is reverted, including the transfer of the p33 to the pool, and the step is skipped.
            try this.swapForCycle(amountIn, minOut) returns (uint256 o) {
                out = o;
            } catch {
                return 0;
            }
        }

        ticketBudget += out;
        emit Harvested(amountIn, out);
    }

    /// @dev Moves the reference towards the pool's current bin, by at most the tolerated
    ///      deviation, and at most once per MIN_REF_AGE. Called after the sale of a pass, so a
    ///      pass never sells against a reference it has just written.
    function _refreshReference() internal {
        if (block.timestamp - refTime < MIN_REF_AGE) return;
        uint256 id;
        try pool.getActiveId() returns (uint24 active) {
            id = active;
        } catch {
            return;
        }
        uint256 maxBins = uint256(maxDeviationBps) / binStep;
        if (maxBins == 0) maxBins = 1;
        uint256 ref = refId;
        if (id > ref + maxBins) id = ref + maxBins;
        else if (id + maxBins < ref) id = ref - maxBins;
        refId = uint24(id);
        refTime = uint40(block.timestamp);
        emit ReferenceUpdated(uint24(id));
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
        uint16 step = IDlmmPool(pool_).getBinStep();
        if (step == 0) revert WrongPool();
        pool = IDlmmPool(pool_);
        binStep = step;
        emit PoolSet(pool_);
        // Set by the owner (creation or pool change): usable at once, and the first pass will
        // start moving it towards the market.
        refId = IDlmmPool(pool_).getActiveId();
        refTime = 0;
        emit ReferenceUpdated(refId);
    }

    /// @dev Player mode: the whole ticket budget goes to the player's wallet.
    function _payout() internal {
        _clampBudget();
        uint256 amount = ticketBudget;
        if (amount == 0) return;
        ticketBudget = 0;
        wavax.safeTransfer(player, amount);
        emit PaidOut(player, amount);
    }

    function _buy(uint256 maxTickets, bool strict) internal returns (uint256 n) {
        // In player mode the budget belongs to the player's wallet: the vault does not spend it.
        if (player != address(0)) {
            if (strict) revert PlayerMode();
            return 0;
        }
        _clampBudget();
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

    /// @dev The budget can never exceed the WAVAX actually held (it could after an allowance
    ///      granted through execute() was used by a third party).
    function _clampBudget() internal {
        uint256 bal = wavax.balanceOf(address(this));
        if (ticketBudget > bal) ticketBudget = bal;
    }

    function _collect() internal returns (uint256 received) {
        _clampBudget();
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
        // Winnings are only played again when the vault plays itself: in player mode the budget
        // leaves for the player's wallet, and winnings must stay under the owner's control.
        uint256 reinvested = player != address(0) ? 0 : (received < reinvestCap ? received : reinvestCap);
        ticketBudget += reinvested;
        emit WinningsCollected(received, reinvested);
    }
}
