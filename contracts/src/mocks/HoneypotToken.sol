// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test fixture only: transfers to `pair` revert unless sent by `owner`, i.e. buys
/// (and liquidity seeding) work but sells revert. Used by GATE 2.5(c) to prove
/// zip-swap's safety module classifies a true honeypot as `blocked`.
contract HoneypotToken {
    string public constant name = "Honeypot Mock";
    string public constant symbol = "HPOT";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    address public immutable owner;
    address public pair;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        owner = msg.sender;
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function setPair(address _pair) external {
        require(msg.sender == owner, "only owner");
        pair = _pair;
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
        if (to == pair && from != owner) {
            revert("honeypot: sells disabled");
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
