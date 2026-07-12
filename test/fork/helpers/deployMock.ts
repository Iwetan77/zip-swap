import type { Address, PublicClient, WalletClient } from "viem";
import FEE_ON_TRANSFER_ARTIFACT from "../../../contracts/out/FeeOnTransferToken.sol/FeeOnTransferToken.json" with { type: "json" };
import HONEYPOT_ARTIFACT from "../../../contracts/out/HoneypotToken.sol/HoneypotToken.json" with { type: "json" };

export async function deployFeeOnTransferToken(
  publicClient: PublicClient,
  walletClient: WalletClient,
  deployer: Address,
  initialSupply: bigint,
  feeBps: bigint,
  feeSink: Address,
): Promise<Address> {
  const hash = await walletClient.deployContract({
    chain: null,
    account: deployer,
    abi: FEE_ON_TRANSFER_ARTIFACT.abi,
    bytecode: FEE_ON_TRANSFER_ARTIFACT.bytecode.object as `0x${string}`,
    args: [initialSupply, feeBps, feeSink],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("FeeOnTransferToken deployment failed");
  return receipt.contractAddress;
}

export async function deployHoneypotToken(
  publicClient: PublicClient,
  walletClient: WalletClient,
  deployer: Address,
  initialSupply: bigint,
): Promise<Address> {
  const hash = await walletClient.deployContract({
    chain: null,
    account: deployer,
    abi: HONEYPOT_ARTIFACT.abi,
    bytecode: HONEYPOT_ARTIFACT.bytecode.object as `0x${string}`,
    args: [initialSupply],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("HoneypotToken deployment failed");
  return receipt.contractAddress;
}
