// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BridgeBase} from "./BridgeBase.sol";
import {WrappedQMS} from "./WrappedQMS.sol";

/// @notice Lives on each remote chain (Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia).
/// The relayer mints wQMS against QMS locked on the hub; users burn wQMS to get QMS back.
contract QmsBridgeSpoke is BridgeBase {
    WrappedQMS public immutable token;
    uint256 public immutable hubChainId;

    error WrongSource();

    constructor(uint256 hubChainId_, address owner_, address relayer_) BridgeBase(owner_, relayer_) {
        hubChainId = hubChainId_;
        token = new WrappedQMS(address(this));
    }

    /// @notice Burn wQMS here; receive native QMS (asNative) or WQMS on the QMS chain.
    function bridgeBack(uint256 amount, address recipient, bool asNative) external whenNotPaused nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        _checkAmount(amount);
        token.bridgeBurn(msg.sender, amount);
        (uint256 n, bytes32 id) = _newTransfer();
        emit Bridged(id, hubChainId, msg.sender, recipient, amount, n, asNative);
    }

    function mint(uint256 srcChainId, uint256 nonce_, address recipient, uint256 amount)
        external
        onlyRelayer
        whenNotPaused
        nonReentrant
    {
        if (srcChainId != hubChainId) revert WrongSource();
        bytes32 id = messageId(srcChainId, nonce_);
        _markProcessed(id);
        token.bridgeMint(recipient, amount);
        emit Delivered(id, recipient, amount);
    }
}
