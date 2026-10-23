// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev WETH9-style wrapper used only in tests and local runs.
contract MockWQMS {
    string public name = "Wrapped QMS";
    string public symbol = "WQMS";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    receive() external payable { deposit(); }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "bal");
        balanceOf[msg.sender] -= wad;
        (bool ok, ) = msg.sender.call{value: wad}("");
        require(ok, "send");
        emit Transfer(msg.sender, address(0), wad);
    }

    function totalSupply() external view returns (uint256) { return address(this).balance; }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) { return _t(msg.sender, to, v); }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        if (f != msg.sender && allowance[f][msg.sender] != type(uint256).max) {
            require(allowance[f][msg.sender] >= v, "allow");
            allowance[f][msg.sender] -= v;
        }
        return _t(f, to, v);
    }

    function _t(address f, address to, uint256 v) internal returns (bool) {
        require(balanceOf[f] >= v, "bal");
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
        return true;
    }
}
