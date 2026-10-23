// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Shared pieces: relayer role, pause, per-transfer limits, replay protection.
/// A transfer is identified by id = keccak256(abi.encode(sourceChainId, nonce)).
/// The destination contract marks the id as processed exactly once.
abstract contract BridgeBase is Ownable, Pausable, ReentrancyGuard {
    address public relayer;
    uint256 public minAmount = 1e14; // 0.0001
    uint256 public maxAmount = 1000 ether;
    uint256 public nonce;
    mapping(bytes32 => bool) public processed;

    event Bridged(
        bytes32 indexed id,
        uint256 indexed dstChainId,
        address indexed sender,
        address recipient,
        uint256 amount,
        uint256 nonce,
        bool asNative
    );
    event Delivered(bytes32 indexed id, address indexed recipient, uint256 amount);
    event RelayerChanged(address indexed relayer);
    event LimitsChanged(uint256 minAmount, uint256 maxAmount);

    error OnlyRelayer();
    error AmountOutOfRange();
    error ZeroAddress();
    error AlreadyProcessed();

    constructor(address owner_, address relayer_) Ownable(owner_) {
        if (relayer_ == address(0)) revert ZeroAddress();
        relayer = relayer_;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer();
        _;
    }

    function setRelayer(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        relayer = r;
        emit RelayerChanged(r);
    }

    function setLimits(uint256 min_, uint256 max_) external onlyOwner {
        require(min_ > 0 && min_ <= max_, "bad limits");
        minAmount = min_;
        maxAmount = max_;
        emit LimitsChanged(min_, max_);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function messageId(uint256 srcChainId, uint256 nonce_) public pure returns (bytes32) {
        return keccak256(abi.encode(srcChainId, nonce_));
    }

    function _checkAmount(uint256 amount) internal view {
        if (amount < minAmount || amount > maxAmount) revert AmountOutOfRange();
    }

    function _markProcessed(bytes32 id) internal {
        if (processed[id]) revert AlreadyProcessed();
        processed[id] = true;
    }

    function _newTransfer() internal returns (uint256 n, bytes32 id) {
        n = ++nonce;
        id = messageId(block.chainid, n);
    }
}
