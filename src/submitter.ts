import type { Address, Hex, WalletClient } from "viem";

export interface SubmittableTx {
  to: Address;
  data: Hex;
  value: bigint;
}

/**
 * Pluggable so protected/encrypted submission lanes (e.g. future BTX-era
 * endpoints) can be added later without touching router or builder code.
 */
export interface TxSubmitter {
  submit(wallet: WalletClient, tx: SubmittableTx): Promise<Hex>;
}

export const defaultSubmitter: TxSubmitter = {
  async submit(wallet, tx) {
    return wallet.sendTransaction({
      chain: null,
      account: wallet.account!,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
  },
};
