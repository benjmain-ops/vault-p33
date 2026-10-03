// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev p33 est un ERC-4626 dont l'actif est xPHAR.
interface IP33 {
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
}

/// @dev SwapRouter de Pharaoh (Ramses V3) : tickSpacing à la place du fee.
interface IPharaohSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev Sous-ensemble de PartnerLotteryCore (BCM) utilisé par le vault.
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
    ) external returns (uint256[] memory ticketIds);

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
 * @notice Vault mono-utilisateur. Le principal p33 du propriétaire reste intact ; seul le
 *         rendement (hausse du ratio p33:xPHAR) est vendu en WAVAX et dépensé en tickets
 *         de la loterie BCM.
 *
 * Rôles :
 *  - owner  : dépose, retire, règle les garde-fous. Seul à pouvoir sortir des fonds.
 *  - keeper : déclenche harvest / achat / réclamation. Ne peut rien retirer ; son pouvoir
 *             de nuisance est borné au rendement non encore dépensé.
 *
 * Comptabilité :
 *  - principalAssets : principal exprimé en xPHAR (l'actif de p33). Tant que le ratio monte,
 *    il faut de moins en moins de p33 pour le couvrir ; la différence est le rendement.
 *  - ticketBudget : WAVAX réservé à l'achat de tickets (issu des harvests).
 *  - Le WAVAX au-delà de ticketBudget est constitué des gains ; il n'est rejoué que si
 *    reinvestWinnings est activé.
 */
contract P33LotteryVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_TICKETS_PER_TX = 50; // limite de PartnerLotteryCore

    IERC20 public immutable p33;
    IERC20 public immutable wavax;
    IBcmLottery public immutable lottery;
    IPharaohSwapRouter public immutable router;

    address public keeper;
    int24 public tickSpacing;

    /// @notice Principal en xPHAR-équivalent.
    uint256 public principalAssets;
    /// @notice WAVAX réservé aux tickets.
    uint256 public ticketBudget;
    /// @notice Prix plancher du swap : WAVAX reçus par p33 vendu, en 1e18. 0 = harvest bloqué.
    uint256 public minWavaxPerP33;
    /// @notice Prix maximum accepté pour un ticket. 0 = achat bloqué.
    uint256 public maxTicketPrice;
    /// @notice Si vrai, les gains encaissés repartent dans le budget tickets.
    bool public reinvestWinnings;

    event Deposited(uint256 shares, uint256 assets);
    event Withdrawn(address indexed to, uint256 shares);
    event Harvested(uint256 p33Sold, uint256 wavaxReceived);
    event TicketsBought(uint256 indexed drawId, uint256 count, uint256 cost);
    event PrizesClaimed(uint256 ticketCount);
    event WinningsCollected(uint256 amount, bool reinvested);
    event BudgetFunded(uint256 amount);
    event WavaxWithdrawn(address indexed to, uint256 amount);
    event KeeperSet(address keeper);
    event GuardsSet(uint256 minWavaxPerP33, uint256 maxTicketPrice);
    event TickSpacingSet(int24 tickSpacing);
    event ReinvestSet(bool enabled);

    error NotOperator();
    error ZeroAddress();
    error ZeroAmount();
    error TokenMismatch();
    error ExceedsHarvestable(uint256 requested, uint256 available);
    error FloorNotSet();
    error Slippage(uint256 received, uint256 minimum);
    error TicketPriceTooHigh(uint256 price, uint256 maxPrice);
    error NothingToBuy();
    error ProtectedToken();

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
        address router_,
        int24 tickSpacing_,
        uint256 minWavaxPerP33_,
        uint256 maxTicketPrice_,
        bool reinvestWinnings_
    ) Ownable(owner_) {
        if (p33_ == address(0) || wavax_ == address(0) || lottery_ == address(0) || router_ == address(0)) {
            revert ZeroAddress();
        }
        if (IBcmLottery(lottery_).token() != wavax_) revert TokenMismatch();
        p33 = IERC20(p33_);
        wavax = IERC20(wavax_);
        lottery = IBcmLottery(lottery_);
        router = IPharaohSwapRouter(router_);
        keeper = keeper_;
        tickSpacing = tickSpacing_;
        minWavaxPerP33 = minWavaxPerP33_;
        maxTicketPrice = maxTicketPrice_;
        reinvestWinnings = reinvestWinnings_;
    }

    // ───────────────────────────── Propriétaire ─────────────────────────────

    /// @notice Dépose du p33 (approve préalable). Le principal est figé en xPHAR au ratio du moment.
    function deposit(uint256 shares) external onlyOwner nonReentrant {
        if (shares == 0) revert ZeroAmount();
        uint256 assets = IP33(address(p33)).convertToAssets(shares);
        p33.safeTransferFrom(msg.sender, address(this), shares);
        principalAssets += assets;
        emit Deposited(shares, assets);
    }

    /// @notice Retire du p33. Le principal baisse de la valeur retirée.
    function withdraw(uint256 shares, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroAmount();
        uint256 assets = IP33(address(p33)).convertToAssets(shares);
        principalAssets = assets >= principalAssets ? 0 : principalAssets - assets;
        p33.safeTransfer(to, shares);
        emit Withdrawn(to, shares);
    }

    /// @notice Retire tout le p33 et remet le principal à zéro.
    function withdrawAll(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 shares = p33.balanceOf(address(this));
        principalAssets = 0;
        p33.safeTransfer(to, shares);
        emit Withdrawn(to, shares);
    }

    /// @notice Retire du WAVAX (gains d'abord, puis budget tickets si le montant le dépasse).
    function withdrawWavax(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        wavax.safeTransfer(to, amount);
        uint256 bal = wavax.balanceOf(address(this));
        if (ticketBudget > bal) ticketBudget = bal;
        emit WavaxWithdrawn(to, amount);
    }

    /// @notice Ajoute du WAVAX au budget tickets, en plus du rendement.
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

    /// @notice Garde-fous : prix plancher du swap et prix maximum du ticket.
    function setGuards(uint256 minWavaxPerP33_, uint256 maxTicketPrice_) external onlyOwner {
        minWavaxPerP33 = minWavaxPerP33_;
        maxTicketPrice = maxTicketPrice_;
        emit GuardsSet(minWavaxPerP33_, maxTicketPrice_);
    }

    function setTickSpacing(int24 tickSpacing_) external onlyOwner {
        tickSpacing = tickSpacing_;
        emit TickSpacingSet(tickSpacing_);
    }

    function setReinvestWinnings(bool enabled) external onlyOwner {
        reinvestWinnings = enabled;
        emit ReinvestSet(enabled);
    }

    /// @notice Récupère un jeton envoyé par erreur (ni p33 ni WAVAX, qui ont leurs propres sorties).
    function rescue(address token_, uint256 amount, address to) external onlyOwner {
        if (token_ == address(p33) || token_ == address(wavax)) revert ProtectedToken();
        IERC20(token_).safeTransfer(to, amount);
    }

    // ─────────────────────────────── Vues ───────────────────────────────────

    /// @notice p33 nécessaires pour couvrir le principal au ratio courant (arrondi vers le haut).
    function principalShares() public view returns (uint256) {
        if (principalAssets == 0) return 0;
        return IP33(address(p33)).convertToShares(principalAssets) + 1;
    }

    /// @notice p33 excédentaires, vendables sans entamer le principal.
    function harvestable() public view returns (uint256) {
        uint256 bal = p33.balanceOf(address(this));
        uint256 needed = principalShares();
        return bal > needed ? bal - needed : 0;
    }

    /// @notice WAVAX détenu hors budget tickets (gains non rejoués).
    function winnings() external view returns (uint256) {
        return wavax.balanceOf(address(this)) - ticketBudget;
    }

    // ─────────────────────────────── Keeper ─────────────────────────────────

    /**
     * @notice Tout le cycle en une transaction : réclame et encaisse les gains, vend le
     *         rendement, achète les tickets.
     *
     * Chaque étape est tolérante : si l'une ne peut pas se faire (prix sous le plancher,
     * tirage clos, loterie en pause, rien à réclamer), elle est sautée et les autres
     * s'exécutent quand même. Les garde-fous du propriétaire s'appliquent comme ailleurs.
     *
     * @param harvestAmount p33 à vendre. 0 = ne pas vendre ; type(uint256).max = tout le rendement.
     * @param minOut        WAVAX minimum attendu du swap (le plancher du propriétaire s'applique en plus).
     * @param maxTickets    Nombre maximum de tickets à acheter (50 au plus par transaction).
     * @param ticketIds     Tickets gagnants du vault à réclamer, avec rangs, montants et preuves
     *                      Merkle calculés hors chaîne. Tableaux vides s'il n'y a rien à réclamer.
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
     * @notice Vend `amountIn` p33 excédentaires contre du WAVAX, crédité au budget tickets.
     * @param minOut Minimum attendu par l'appelant. Le plancher du propriétaire s'applique
     *               en plus : le plus exigeant des deux l'emporte.
     */
    function harvest(uint256 amountIn, uint256 minOut) external onlyOperator nonReentrant returns (uint256 out) {
        if (amountIn == 0) revert ZeroAmount();
        uint256 available = harvestable();
        if (amountIn > available) revert ExceedsHarvestable(amountIn, available);
        if (minWavaxPerP33 == 0) revert FloorNotSet();
        out = _harvest(amountIn, minOut, true);
    }

    /**
     * @notice Achète autant de tickets (grilles aléatoires) que le budget le permet sur le
     *         tirage en cours, dans la limite de `maxTickets` et de 50 par transaction.
     *         À rappeler tant que le budget couvre encore un ticket.
     */
    function buyTickets(uint256 maxTickets) external onlyOperator nonReentrant returns (uint256 count) {
        count = _buy(maxTickets, true);
    }

    /**
     * @notice Relaie les preuves Merkle des tickets gagnants du vault, puis encaisse.
     *         Les preuves sont vérifiées par la loterie : une preuve fausse est ignorée.
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

    /// @notice Encaisse les gains déjà reconnus par la loterie (97 % après ses frais).
    function collectWinnings() external onlyOperator nonReentrant {
        _collect();
    }

    // ─────────────────────────────── Interne ────────────────────────────────

    /// @dev `strict` : toute impossibilité fait échouer la transaction. Sinon l'étape est sautée.
    function _harvest(uint256 amountIn, uint256 minOut, bool strict) internal returns (uint256 out) {
        if (amountIn == 0 || minWavaxPerP33 == 0) return 0; // cas déjà refusés en amont en mode strict

        uint256 floorOut = (amountIn * minWavaxPerP33) / 1e18;
        if (minOut < floorOut) minOut = floorOut;

        IPharaohSwapRouter.ExactInputSingleParams memory params = IPharaohSwapRouter.ExactInputSingleParams({
            tokenIn: address(p33),
            tokenOut: address(wavax),
            tickSpacing: tickSpacing,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });

        uint256 before = wavax.balanceOf(address(this));
        p33.forceApprove(address(router), amountIn);
        if (strict) {
            router.exactInputSingle(params);
        } else {
            try router.exactInputSingle(params) {} catch {
                p33.forceApprove(address(router), 0);
                return 0;
            }
        }
        p33.forceApprove(address(router), 0);

        // On croit le solde, pas la valeur de retour du router.
        out = wavax.balanceOf(address(this)) - before;
        if (out < minOut) revert Slippage(out, minOut);

        ticketBudget += out;
        emit Harvested(amountIn, out);
    }

    function _buy(uint256 maxTickets, bool strict) internal returns (uint256 n) {
        uint256 price = lottery.ticketPrice();
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

        uint256 drawId = lottery.currentDrawId();
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

        uint256 spent = before - wavax.balanceOf(address(this));
        ticketBudget -= spent;
        emit TicketsBought(drawId, n, spent);
    }

    function _collect() internal returns (uint256 received) {
        if (lottery.claimable(address(this)) == 0) return 0;
        uint256 before = wavax.balanceOf(address(this));
        try lottery.claimWinnings() {} catch {
            return 0;
        }
        received = wavax.balanceOf(address(this)) - before;
        if (reinvestWinnings) ticketBudget += received;
        emit WinningsCollected(received, reinvestWinnings);
    }
}
