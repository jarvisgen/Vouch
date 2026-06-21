// dapp-kit + react-query providers. ConnectButton and on-chain hooks need these.
import { ReactNode } from "react";
import { SuiClientProvider, WalletProvider, createNetworkConfig } from "@mysten/dapp-kit";
import { getFullnodeUrl } from "@mysten/sui/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@mysten/dapp-kit/dist/index.css";

const { networkConfig } = createNetworkConfig({
  testnet: { url: getFullnodeUrl("testnet") },
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        {/* Slush web wallet works with no extension; Phantom & other Wallet-Standard
            extensions (Suiet, Ethos, Nightly, Surf…) appear automatically when installed. */}
        <WalletProvider autoConnect slushWallet={{ name: "Vouch" }} preferredWallets={["Slush", "Phantom", "Sui Wallet"]}>
          {children}
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
