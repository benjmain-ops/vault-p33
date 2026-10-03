// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

// Mocks de test uniquement. MockLottery reprend les règles de PartnerLotteryCore qui
// concernent le vault : paiement exact, tirage ouvert, propriété du ticket, format de
// feuille Merkle, délai de 15 min, plafond par tirage, 3 % de frais à l'encaissement.

contract MockERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockP33 is ERC20 {
    uint256 public ratio = 1e18;

    constructor() ERC20("Mock p33", "p33") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setRatio(uint256 r) external {
        ratio = r;
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return (shares * ratio) / 1e18;
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        return (assets * 1e18) / ratio;
    }
}

contract MockClFactory {
    mapping(int24 => address) public pools;

    function setPool(int24 tickSpacing, address pool) external {
        pools[tickSpacing] = pool;
    }

    function getPool(address, address, int24 tickSpacing) external view returns (address) {
        return pools[tickSpacing];
    }
}

contract MockRouter {
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

    uint256 public rate = 0.017e18; // tokenOut par tokenIn, 1e18

    function setRate(uint256 r) external {
        rate = r;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        require(block.timestamp <= p.deadline, "deadline");
        out = (p.amountIn * rate) / 1e18;
        require(out >= p.amountOutMinimum, "Too little received");
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        IERC20(p.tokenOut).transfer(p.recipient, out);
    }
}

contract MockLottery {
    struct Draw {
        uint256 id;
        uint256 scheduledTime;
        uint256 drawnAt;
        uint8[7] winningMain;
        uint8[2] winningComp;
        uint256 prizePool;
        uint256[12] rankPools;
        uint256 drawVolume;
        bool isRun2;
        bool finalized;
        bool hasRank1Winner;
        bytes32 merkleRoot;
    }

    struct Ticket {
        uint256 id;
        uint256 drawId;
        address owner;
        uint8[9] mainNumbers;
        uint8[3] compNumbers;
        bool isSystemPlay;
        uint8 systemMainCount;
        uint8 systemCompCount;
        uint8 rank;
        bool claimed;
        uint256 grossWinAmount;
    }

    IERC20 public immutable token;
    uint256 public ticketPrice;
    uint256 public currentDrawId;
    uint256 public ticketCount;
    bool public paused;

    mapping(uint256 => Draw) internal draws;
    mapping(uint256 => Ticket) internal tickets;
    mapping(uint256 => uint256[]) internal drawTickets;
    mapping(address => uint256[]) internal ownerTickets;
    mapping(uint256 => bool) public ticketPrizeClaimed;
    mapping(address => uint256) public claimable;
    mapping(uint256 => uint256) public drawRemaining;
    mapping(uint256 => uint256) public rootPoseA;
    uint256 private nonce;

    constructor(address token_, uint256 price) {
        token = IERC20(token_);
        ticketPrice = price;
    }

    // ── aides de test ──
    function setTicketPrice(uint256 p) external {
        ticketPrice = p;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function createDraw(uint256 scheduledTime) external returns (uint256) {
        currentDrawId++;
        draws[currentDrawId].id = currentDrawId;
        draws[currentDrawId].scheduledTime = scheduledTime;
        return currentDrawId;
    }

    function setResult(uint256 drawId, uint8[7] calldata main, uint8[2] calldata comp, uint256[12] calldata pools)
        external
    {
        Draw storage d = draws[drawId];
        d.winningMain = main;
        d.winningComp = comp;
        d.rankPools = pools;
        d.drawnAt = block.timestamp;
        d.finalized = true;
    }

    function setMerkleRoot(uint256 drawId, bytes32 root) external {
        Draw storage d = draws[drawId];
        uint256 owed;
        for (uint256 r = 0; r < 12; r++) owed += d.rankPools[r];
        drawRemaining[drawId] = owed;
        d.merkleRoot = root;
        rootPoseA[drawId] = block.timestamp;
    }

    // ── interface PartnerLotteryCore ──
    function buyMultipleTickets(
        uint256 drawId,
        uint8[6][] calldata mainNumsArr,
        uint8[2][] calldata compNumsArr,
        bool[] calldata isFlashPick
    ) external returns (uint256[] memory ticketIds) {
        require(!paused, "EnforcedPause");
        Draw storage d = draws[drawId];
        require(d.id != 0, "E05");
        require(d.drawnAt == 0, "E06");
        require(block.timestamp < d.scheduledTime, "E27");
        uint256 n = mainNumsArr.length;
        require(n > 0, "E21");
        require(n <= 50, "E51");
        require(n == compNumsArr.length && n == isFlashPick.length, "E22");

        ticketIds = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint8[6] memory main;
            uint8[2] memory comp;
            if (isFlashPick[i]) (main, comp) = _flashPick();
            else (main, comp) = (mainNumsArr[i], compNumsArr[i]);

            ticketCount++;
            Ticket storage t = tickets[ticketCount];
            t.id = ticketCount;
            t.drawId = drawId;
            t.owner = msg.sender;
            for (uint256 k = 0; k < 6; k++) t.mainNumbers[k] = main[k];
            t.compNumbers[0] = comp[0];
            t.compNumbers[1] = comp[1];
            t.systemMainCount = 6;
            t.systemCompCount = 2;
            drawTickets[drawId].push(ticketCount);
            ownerTickets[msg.sender].push(ticketCount);
            ticketIds[i] = ticketCount;
        }

        uint256 cost = ticketPrice * n;
        uint256 before = token.balanceOf(address(this));
        token.transferFrom(msg.sender, address(this), cost);
        require(token.balanceOf(address(this)) - before == cost, "E58");
        d.prizePool += (cost * 8000) / 10_000;
        d.drawVolume += cost;
    }

    function batchClaimTicketPrizes(
        uint256[] calldata ticketIds,
        uint8[] calldata ranks,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external {
        require(!paused, "EnforcedPause");
        uint256 len = ticketIds.length;
        require(len > 0 && len == ranks.length && len == amounts.length && len == proofs.length, "E50");
        require(len <= 50, "E51");
        for (uint256 i = 0; i < len; i++) {
            uint256 id = ticketIds[i];
            if (ticketPrizeClaimed[id]) continue;
            Ticket storage t = tickets[id];
            if (t.id == 0 || t.owner != msg.sender) continue;
            Draw storage d = draws[t.drawId];
            if (!d.finalized || d.merkleRoot == bytes32(0) || d.merkleRoot == bytes32(uint256(1))) continue;
            if (block.timestamp < rootPoseA[t.drawId] + 15 minutes) continue;
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(id, msg.sender, ranks[i], amounts[i]))));
            if (!MerkleProof.verify(proofs[i], d.merkleRoot, leaf)) continue;
            if (amounts[i] > drawRemaining[t.drawId]) continue;
            drawRemaining[t.drawId] -= amounts[i];
            ticketPrizeClaimed[id] = true;
            t.rank = ranks[i];
            t.grossWinAmount = amounts[i];
            claimable[msg.sender] += amounts[i];
        }
    }

    function claimWinnings() external {
        uint256 gross = claimable[msg.sender];
        require(gross > 0, "E15");
        claimable[msg.sender] = 0;
        token.transfer(msg.sender, gross - (gross * 300) / 10_000);
    }

    function getDraw(uint256 drawId) external view returns (Draw memory) {
        return draws[drawId];
    }

    function getTicket(uint256 id) external view returns (Ticket memory) {
        return tickets[id];
    }

    function getDrawTickets(uint256 drawId) external view returns (uint256[] memory) {
        return drawTickets[drawId];
    }

    function getOwnerTickets(address o) external view returns (uint256[] memory) {
        return ownerTickets[o];
    }

    function _flashPick() internal returns (uint8[6] memory main, uint8[2] memory comp) {
        nonce++;
        uint256 s = uint256(keccak256(abi.encodePacked(msg.sender, ticketCount, nonce)));
        bool[25] memory used;
        uint8 picked;
        while (picked < 6) {
            s = uint256(keccak256(abi.encodePacked(s)));
            uint8 n = uint8((s % 24) + 1);
            if (!used[n]) {
                used[n] = true;
                main[picked++] = n;
            }
        }
        bool[6] memory usedC;
        picked = 0;
        while (picked < 2) {
            s = uint256(keccak256(abi.encodePacked(s)));
            uint8 n = uint8((s % 5) + 1);
            if (!usedC[n]) {
                usedC[n] = true;
                comp[picked++] = n;
            }
        }
    }
}
