// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test fixture only: charges a fixed bps fee on every transfer, sent to `feeSink`.
/// Used by GATE 2.5(b) to prove zip-swap's safety module detects real transfer tax.
contract FeeOnTransferToken {
    string public constant name = "Fee On Transfer Mock";
    string public constant symbol = "FOTM";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    uint256 public immutable feeBps;
    address public immutable feeSink;
    address public immutable owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply, uint256 _feeBps, address _feeSink) {
        feeBps = _feeBps;
        feeSink = _feeSink;
        owner = msg.sender;
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "insufficient allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "insufficient balance");
        // Owner-originated transfers (liquidity seeding) are exempt, mirroring real
        // fee-on-transfer tokens that exempt their own LP deposits. Sells routed
        // through the Simulator (never the owner) are taxed in full.
        uint256 fee = from == owner ? 0 : (amount * feeBps) / 10_000;
        uint256 net = amount - fee;
        balanceOf[from] -= amount;
        balanceOf[to] += net;
        if (fee > 0) {
            balanceOf[feeSink] += fee;
            emit Transfer(from, feeSink, fee);
        }
        emit Transfer(from, to, net);
    }
}
