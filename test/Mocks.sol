// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockRouter {
    uint256 public numerator = 1;
    uint256 public denominator = 1;
    function setRate(uint256 n, uint256 d) external { numerator = n; denominator = d; }
    function swapExactTokensForTokens(uint256 input, uint256 minimum, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "expired");
        uint256 output = input * numerator / denominator;
        require(output >= minimum, "slippage");
        require(MockToken(path[0]).transferFrom(msg.sender, address(this), input));
        require(MockToken(path[1]).transfer(to, output));
        amounts = new uint256[](2);
        amounts[0] = input;
        amounts[1] = output;
    }
}
