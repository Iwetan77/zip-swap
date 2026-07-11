import { type ChildProcess, spawn } from "node:child_process";

export interface AnvilInstance {
  rpcUrl: string;
  process: ChildProcess;
  stop(): void;
}

export async function startAnvilFork(port: number): Promise<AnvilInstance> {
  const forkUrl = process.env.MONAD_RPC_URL ?? "https://rpc.monad.xyz";
  const proc = spawn(
    "anvil",
    ["--fork-url", forkUrl, "--port", String(port), "--silent"],
    { stdio: "ignore" },
  );

  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      });
      if (res.ok) {
        return {
          rpcUrl,
          process: proc,
          stop: () => proc.kill(),
        };
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  proc.kill();
  throw new Error(`anvil did not become ready on port ${port} within timeout`);
}
