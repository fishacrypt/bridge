// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev test helper: a recipient that refuses native transfers until `open` is set
contract RejectingReceiver {
    bool public open;
    function setOpen(bool v) external { open = v; }
    function pull(address hub) external { (bool ok, ) = hub.call(abi.encodeWithSignature("claim()")); require(ok, "claim failed"); }
    receive() external payable { require(open, "closed"); }
}
