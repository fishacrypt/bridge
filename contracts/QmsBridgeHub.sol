// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BridgeBase} from "./BridgeBase.sol";

interface IWQMS {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @notice Lives on QMS Testnet. Holds ONE pool of native QMS.
///  - users deposit native QMS or WQMS (WQMS is unwrapped into the pool)
///  - the relayer releases native QMS or WQMS (wrapped from the pool) against burns on remote chains
/// Invariant: total wQMS supplied on all remote chains <= native QMS locked here.
contract QmsBridgeHub is BridgeBase {
    using SafeERC20 for IERC20;

    IWQMS public immutable wqms;
    mapping(uint256 => bool) public supportedChain; // remote chain ids
    mapping(address => uint256) public claimable; // native QMS that could not be pushed to a recipient
    uint256 public totalClaimable;

    event ChainSupport(uint256 indexed chainId, bool supported);
    event Claimed(address indexed account, uint256 amount);
    event ClaimableCredited(address indexed account, uint256 amount);
    event LiquidityWithdrawn(address indexed to, uint256 amount);

    error UnsupportedChain();
    error InsufficientLiquidity();
    error NothingToClaim();

    constructor(address wqms_, address owner_, address relayer_) BridgeBase(owner_, relayer_) {
        if (wqms_ == address(0)) revert ZeroAddress();
        wqms = IWQMS(wqms_);
    }

    /// @dev accepts native QMS from WQMS.withdraw() and from owner top-ups
    receive() external payable {}

    function setChainSupport(uint256 chainId, bool ok) external onlyOwner {
        supportedChain[chainId] = ok;
        emit ChainSupport(chainId, ok);
    }

    // ------------------------------------------------------------------ users

    function depositNative(uint256 dstChainId, address recipient) external payable whenNotPaused nonReentrant {
        _checkDeposit(dstChainId, recipient, msg.value);
        _emitBridged(dstChainId, recipient, msg.value);
    }

    function depositWQMS(uint256 amount, uint256 dstChainId, address recipient) external whenNotPaused nonReentrant {
        _checkDeposit(dstChainId, recipient, amount);
        IERC20(address(wqms)).safeTransferFrom(msg.sender, address(this), amount);
        wqms.withdraw(amount); // unwrap into the native pool
        _emitBridged(dstChainId, recipient, amount);
    }

    function claim() external nonReentrant {
        uint256 amt = claimable[msg.sender];
        if (amt == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amt;
        (bool ok, ) = msg.sender.call{value: amt}("");
        require(ok, "send failed");
        emit Claimed(msg.sender, amt);
    }

    // ---------------------------------------------------------------- relayer

    function release(
        uint256 srcChainId,
        uint256 nonce_,
        address recipient,
        uint256 amount,
        bool asNative
    ) external onlyRelayer whenNotPaused nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (!supportedChain[srcChainId]) revert UnsupportedChain();
        bytes32 id = messageId(srcChainId, nonce_);
        _markProcessed(id);
        if (address(this).balance < amount + totalClaimable) revert InsufficientLiquidity();

        if (asNative) {
            (bool ok, ) = recipient.call{value: amount}("");
            if (!ok) {
                claimable[recipient] += amount; // never let a bad recipient block the queue
                totalClaimable += amount;
                emit ClaimableCredited(recipient, amount);
            }
        } else {
            wqms.deposit{value: amount}();
            IERC20(address(wqms)).safeTransfer(recipient, amount);
        }
        emit Delivered(id, recipient, amount);
    }

    // ------------------------------------------------------------------ owner

    /// @notice Testnet convenience: move pool liquidity out (e.g. to migrate). Funds backing claimable are protected.
    function withdrawLiquidity(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        require(address(this).balance >= amount + totalClaimable, "protects claimable");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "send failed");
        emit LiquidityWithdrawn(to, amount);
    }

    // --------------------------------------------------------------- internal

    function _checkDeposit(uint256 dstChainId, address recipient, uint256 amount) internal view {
        if (!supportedChain[dstChainId]) revert UnsupportedChain();
        if (recipient == address(0)) revert ZeroAddress();
        _checkAmount(amount);
    }

    function _emitBridged(uint256 dstChainId, address recipient, uint256 amount) internal {
        (uint256 n, bytes32 id) = _newTransfer();
        emit Bridged(id, dstChainId, msg.sender, recipient, amount, n, false);
    }
}
