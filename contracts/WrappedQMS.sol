// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice wQMS on a remote chain. Only the bridge (spoke) contract can mint or burn.
contract WrappedQMS is ERC20 {
    address public immutable bridge;

    error OnlyBridge();

    constructor(address bridge_) ERC20("Wrapped QMS", "wQMS") {
        bridge = bridge_;
    }

    modifier onlyBridge() {
        if (msg.sender != bridge) revert OnlyBridge();
        _;
    }

    function bridgeMint(address to, uint256 amount) external onlyBridge {
        _mint(to, amount);
    }

    function bridgeBurn(address from, uint256 amount) external onlyBridge {
        _burn(from, amount);
    }
}
