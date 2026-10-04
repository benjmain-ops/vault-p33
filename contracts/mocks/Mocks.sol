// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

// Test-only mocks. MockLottery reproduces the rules of PartnerLotteryCore that
// concern the vault: exact payment, open draw, ticket ownership, Merkle leaf
// format, 15 min delay, per-draw cap, 3% fee on collection.

contract MockERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Wrapped native token: deposit() / withdraw() like WAVAX.
contract MockWAVAX is MockERC20 {
    constructor() MockERC20("Wrapped AVAX", "WAVAX") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "mock: native transfer failed");
    }

    receive() external payable {}
}

/// @dev Stands for a reward distributed to players: an NFT sent with safeMint, and reward
///      tokens that only the player's own address can claim.
contract MockRewards is ERC721 {
    MockERC20 public immutable rewardToken;
    uint256 public nextId = 1;

    constructor(MockERC20 t) ERC721("Reward", "RWD") {
        rewardToken = t;
    }

    function airdropNft(address to) external returns (uint256 id) {
        id = nextId++;
        _safeMint(to, id);
    }

    function claim() external {
        rewardToken.mint(msg.sender, 100e18);
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

/// @dev Simplified DLMM pool: we send it the input token then call swap().
///      Bins behave like the real ones: each bin is 0.25% above the previous one, and the
///      swap executes at the price of the active bin.
contract MockDlmmPool {
    address public immutable getTokenX;
    address public immutable getTokenY;
    uint24 internal constant ID0 = 8387459;
    uint256 internal constant RATE0 = 0.017e18; // Y per X at bin ID0, 1e18
    uint256 public rate = RATE0; // Y received per X sold, 1e18, at the active bin
    uint24 public getActiveId = ID0;
    uint256 internal reserveX;
    uint256 internal reserveY;

    constructor(address x, address y) {
        getTokenX = x;
        getTokenY = y;
    }

    function getBinStep() external pure returns (uint16) {
        return 25;
    }

    function _rateAt(uint24 id) internal pure returns (uint256 r) {
        r = RATE0;
        for (uint24 i = ID0; i < id; i++) r = (r * 10_025) / 10_000;
        for (uint24 i = ID0; i > id; i--) r = (r * 10_000) / 10_025;
    }

    /// @dev Moves the market to the bin whose price is closest below `r`; swaps execute at `r`.
    function setRate(uint256 r) external {
        uint24 id = ID0;
        uint256 cur = RATE0;
        while (cur > r) {
            id--;
            cur = (cur * 10_000) / 10_025;
        }
        while ((cur * 10_025) / 10_000 <= r) {
            id++;
            cur = (cur * 10_025) / 10_000;
        }
        getActiveId = id;
        rate = r;
    }

    /// @dev Price of X in Y at a bin, 128.128 fixed point.
    function getPriceFromId(uint24 id) external view returns (uint256) {
        uint256 r = id == getActiveId ? rate : _rateAt(id);
        return (r << 128) / 1e18;
    }

    /// @dev To be called after funding the pool.
    function sync() external {
        reserveX = IERC20(getTokenX).balanceOf(address(this));
        reserveY = IERC20(getTokenY).balanceOf(address(this));
    }

    function swap(bool swapForY, address to) external returns (bytes32) {
        require(swapForY, "mock: X->Y only");
        uint256 amountIn = IERC20(getTokenX).balanceOf(address(this)) - reserveX;
        require(amountIn > 0, "LBPair__InsufficientAmountIn");
        uint256 out = (amountIn * rate) / 1e18;
        require(out <= reserveY, "LBPair__OutOfLiquidity");
        reserveX += amountIn;
        reserveY -= out;
        IERC20(getTokenY).transfer(to, out);
        return bytes32(out);
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
    uint256 internal _ticketPrice;
    uint256 internal _currentDrawId;
    bool public broken; // when set, the views revert
    uint256 public ticketCount;
    bool public paused;

    mapping(uint256 => Draw) internal draws;
    mapping(uint256 => Ticket) internal tickets;
    mapping(uint256 => uint256[]) internal drawTickets;
    mapping(address => uint256[]) internal ownerTickets;
    mapping(uint256 => bool) public ticketPrizeClaimed;
    mapping(address => uint256) internal _claimable;
    mapping(uint256 => uint256) public drawRemaining;
    mapping(uint256 => uint256) public rootPoseA;
    uint256 private nonce;

    constructor(address token_, uint256 price) {
        token = IERC20(token_);
        _ticketPrice = price;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function ticketPrice() public view returns (uint256) {
        require(!broken, "broken");
        return _ticketPrice;
    }

    function currentDrawId() public view returns (uint256) {
        require(!broken, "broken");
        return _currentDrawId;
    }

    function claimable(address a) external view returns (uint256) {
        require(!broken, "broken");
        return _claimable[a];
    }

    // ── test helpers ──
    function setTicketPrice(uint256 p) external {
        _ticketPrice = p;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function createDraw(uint256 scheduledTime) external returns (uint256) {
        _currentDrawId++;
        draws[_currentDrawId].id = _currentDrawId;
        draws[_currentDrawId].scheduledTime = scheduledTime;
        return _currentDrawId;
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

    // ── PartnerLotteryCore interface ──
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

        uint256 cost = _ticketPrice * n;
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
            _claimable[msg.sender] += amounts[i];
        }
    }

    function claimWinnings() external {
        uint256 gross = _claimable[msg.sender];
        require(gross > 0, "E15");
        _claimable[msg.sender] = 0;
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
