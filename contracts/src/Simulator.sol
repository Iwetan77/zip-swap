// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Probe {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// Deployed on-the-fly via eth_call state override (`code` override at a scratch
/// address). Never actually deployed on-chain — it exists only inside a single
/// simulated call so zip-swap can probe token behavior without holding funds.
contract Simulator {
    function probeBalance(address token, uint256 expectedAmount) external view returns (bool ok, uint256 balance) {
        balance = IERC20Probe(token).balanceOf(address(this));
        ok = balance == expectedAmount;
    }

    /// Attempts a direct transfer into the pool address itself — the closest
    /// generic analog to "attempt a sell" without needing full swap machinery.
    /// Reverts exactly when a real sell would revert (honeypot-style blocks
    /// keyed on the pool/pair as recipient).
    function probeTransferToPool(address token, address pool, uint256 amount) external returns (uint256 received) {
        uint256 before = IERC20Probe(token).balanceOf(pool);
        IERC20Probe(token).transfer(pool, amount);
        received = IERC20Probe(token).balanceOf(pool) - before;
    }

    function simulateTransferTax(
        address token,
        address recipient,
        uint256 amount
    ) external returns (uint256 sent, uint256 received) {
        uint256 before = IERC20Probe(token).balanceOf(recipient);
        IERC20Probe(token).transfer(recipient, amount);
        uint256 afterBal = IERC20Probe(token).balanceOf(recipient);
        sent = amount;
        received = afterBal - before;
    }
}
