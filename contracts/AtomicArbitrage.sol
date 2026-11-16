// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract AtomicArbitrage {
    address public immutable owner;
    IERC20 public immutable wxdai;
    IERC20 public immutable gno;
    address public immutable honeyswap;
    address public immutable sushiswap;
    bool private entered;

    event RoundTrip(address indexed buyRouter, address indexed sellRouter, uint256 amountIn, uint256 amountOut);

    constructor(address wxdai_, address gno_, address honeyswap_, address sushiswap_) {
        require(wxdai_.code.length > 0 && gno_.code.length > 0, "Invalid token");
        require(honeyswap_.code.length > 0 && sushiswap_.code.length > 0, "Invalid router");
        require(wxdai_ != gno_ && honeyswap_ != sushiswap_, "Duplicate address");
        owner = msg.sender;
        wxdai = IERC20(wxdai_);
        gno = IERC20(gno_);
        honeyswap = honeyswap_;
        sushiswap = sushiswap_;
    }

    function execute(
        address buyRouter,
        address sellRouter,
        uint256 amountIn,
        uint256 minimumProfit,
        uint256 deadline,
        uint256 maximumGasPrice
    ) external {
        require(msg.sender == owner, "Not owner");
        require(!entered, "Reentrant");
        require(
            (buyRouter == honeyswap && sellRouter == sushiswap) ||
            (buyRouter == sushiswap && sellRouter == honeyswap),
            "Invalid route"
        );
        require(amountIn > 0 && minimumProfit > 0, "Invalid amounts");
        require(block.timestamp <= deadline, "Expired");
        require(tx.gasprice <= maximumGasPrice, "Gas price too high");
        entered = true;

        uint256 initialWxdai = wxdai.balanceOf(address(this));
        uint256 initialGno = gno.balanceOf(address(this));
        require(wxdai.transferFrom(owner, address(this), amountIn), "Pull failed");
        require(wxdai.balanceOf(address(this)) == initialWxdai + amountIn, "Unexpected input");
        require(wxdai.approve(buyRouter, amountIn), "Buy approval failed");

        address[] memory path = new address[](2);
        path[0] = address(wxdai);
        path[1] = address(gno);
        IV2Router(buyRouter).swapExactTokensForTokens(amountIn, 1, path, address(this), deadline);
        require(wxdai.approve(buyRouter, 0), "Reset buy approval failed");
        uint256 acquired = gno.balanceOf(address(this)) - initialGno;
        require(acquired > 0, "No GNO received");
        require(gno.approve(sellRouter, acquired), "Sell approval failed");
        path[0] = address(gno);
        path[1] = address(wxdai);
        IV2Router(sellRouter).swapExactTokensForTokens(acquired, amountIn + minimumProfit, path, address(this), deadline);
        require(gno.approve(sellRouter, 0), "Reset sell approval failed");
        require(gno.balanceOf(address(this)) == initialGno, "GNO remaining");
        uint256 amountOut = wxdai.balanceOf(address(this)) - initialWxdai;
        require(amountOut >= amountIn + minimumProfit, "Insufficient profit");
        require(wxdai.transfer(owner, amountOut), "Payout failed");
        entered = false;
        emit RoundTrip(buyRouter, sellRouter, amountIn, amountOut);
    }
}
