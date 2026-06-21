/// Mock testnet stablecoin used as a FALLBACK when the real testnet USDC faucet is
/// throttled. Selected via STABLECOIN_MODE=mock. Flagged as a mock in the README.
///
/// 6 decimals to mirror real USDC. The deployer receives the TreasuryCap; the public
/// `faucet` lets the demo mint coins to any address.
module vouch::mock_usdc {
    use sui::coin::{Self, TreasuryCap};

    /// One-time witness.
    public struct MOCK_USDC has drop {}

    // create_currency is fine for a demo mock; the newer coin_registry API is heavier
    // than this fallback coin warrants.
    #[allow(deprecated_usage)]
    fun init(witness: MOCK_USDC, ctx: &mut TxContext) {
        let (treasury, metadata) = coin::create_currency(
            witness,
            6,
            b"mUSDC",
            b"Mock USDC",
            b"Demo stablecoin for Vouch (fallback for testnet USDC)",
            option::none(),
            ctx,
        );
        transfer::public_freeze_object(metadata);
        transfer::public_transfer(treasury, ctx.sender());
    }

    /// Public faucet for the demo: mint `amount` (base units, 6 dp) to `to`.
    public fun faucet(
        cap: &mut TreasuryCap<MOCK_USDC>,
        amount: u64,
        to: address,
        ctx: &mut TxContext,
    ) {
        coin::mint_and_transfer(cap, amount, to, ctx);
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(MOCK_USDC {}, ctx)
    }
}
