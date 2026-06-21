/// Binary prediction market per task-class: "will agent X correctly complete task-class Y?"
///
/// Design — complete sets, traded on DeepBook:
///   - 1 USDC mints a complete set: 1 YES + 1 NO, with the USDC held in escrow.
///   - The YES coin trades on a REAL DeepBook YES/USDC pool (created + seeded off-chain
///     by scripts/make-market.ts). The YES mid-price ∈ [0,1] = implied success
///     probability = the agent's live reliability score.
///   - On resolution: agent succeeds ⇒ YES wins (redeems 1 USDC, NO → 0); agent fails
///     ⇒ NO wins. Escrow is always exactly funded because every set deposited 1 USDC and
///     exactly one side per set redeems.
///
/// DeepBook is NOT a Move dependency here: it operates on our YES coin from the TS SDK.
/// This module only handles issuance, settlement, and redemption of the outcome claims.
///
/// Generic over `Stable` (the stablecoin) and the per-task-class `Yes`/`No` coin types
/// declared in outcome_coins.move. `Market` is a SHARED object.
module vouch::market {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::event;

    /// Market already resolved.
    const EAlreadyResolved: u64 = 1;
    /// Market not resolved yet.
    const ENotResolved: u64 = 2;
    /// Redeeming the losing side, or wrong side for the outcome.
    const EWrongOutcome: u64 = 3;
    /// YES and NO amounts must match when burning/unwinding a set.
    const EAmountMismatch: u64 = 4;

    public struct Market<phantom Stable, phantom Yes, phantom No> has key {
        id: UID,
        task_class: vector<u8>,
        /// the DeepBook YES/Stable pool id (reference; pool lives in DeepBook)
        pool_id: ID,
        escrow: Balance<Stable>,
        yes_treasury: TreasuryCap<Yes>,
        no_treasury: TreasuryCap<No>,
        resolved: bool,
        yes_wins: bool,
    }

    public struct MarketCreated has copy, drop {
        market_id: ID,
        task_class: vector<u8>,
        pool_id: ID,
    }
    public struct MarketSettled has copy, drop { market_id: ID, yes_wins: bool }

    /// Create a market. Caller supplies the YES/NO treasuries (from outcome_coins init)
    /// and the id of the DeepBook pool that will trade the YES coin.
    public fun new_market<Stable, Yes, No>(
        task_class: vector<u8>,
        pool_id: ID,
        yes_treasury: TreasuryCap<Yes>,
        no_treasury: TreasuryCap<No>,
        ctx: &mut TxContext,
    ) {
        let id = object::new(ctx);
        event::emit(MarketCreated {
            market_id: object::uid_to_inner(&id),
            task_class,
            pool_id,
        });
        transfer::share_object(Market<Stable, Yes, No> {
            id,
            task_class,
            pool_id,
            escrow: balance::zero<Stable>(),
            yes_treasury,
            no_treasury,
            resolved: false,
            yes_wins: false,
        });
    }

    /// Mint a complete set: deposit `usdc`, receive equal-value YES and NO coins.
    public fun mint_set<Stable, Yes, No>(
        market: &mut Market<Stable, Yes, No>,
        usdc: Coin<Stable>,
        ctx: &mut TxContext,
    ): (Coin<Yes>, Coin<No>) {
        assert!(!market.resolved, EAlreadyResolved);
        let v = coin::value(&usdc);
        balance::join(&mut market.escrow, coin::into_balance(usdc));
        let yes = coin::mint(&mut market.yes_treasury, v, ctx);
        let no = coin::mint(&mut market.no_treasury, v, ctx);
        (yes, no)
    }

    /// Unwind a complete set before resolution: burn equal YES+NO, reclaim the USDC.
    public fun burn_set<Stable, Yes, No>(
        market: &mut Market<Stable, Yes, No>,
        yes: Coin<Yes>,
        no: Coin<No>,
        ctx: &mut TxContext,
    ): Coin<Stable> {
        assert!(!market.resolved, EAlreadyResolved);
        let v = coin::value(&yes);
        assert!(coin::value(&no) == v, EAmountMismatch);
        coin::burn(&mut market.yes_treasury, yes);
        coin::burn(&mut market.no_treasury, no);
        coin::take(&mut market.escrow, v, ctx)
    }

    /// Resolve the market. `yes_wins` == agent succeeded. Called only by vouch::resolver.
    public(package) fun settle<Stable, Yes, No>(
        market: &mut Market<Stable, Yes, No>,
        yes_wins: bool,
    ) {
        assert!(!market.resolved, EAlreadyResolved);
        market.resolved = true;
        market.yes_wins = yes_wins;
        event::emit(MarketSettled { market_id: object::uid_to_inner(&market.id), yes_wins });
    }

    /// Redeem winning YES coins for USDC (1:1). Aborts unless resolved and YES won.
    public fun redeem_yes<Stable, Yes, No>(
        market: &mut Market<Stable, Yes, No>,
        yes: Coin<Yes>,
        ctx: &mut TxContext,
    ): Coin<Stable> {
        assert!(market.resolved, ENotResolved);
        assert!(market.yes_wins, EWrongOutcome);
        let v = coin::value(&yes);
        coin::burn(&mut market.yes_treasury, yes);
        coin::take(&mut market.escrow, v, ctx)
    }

    /// Redeem winning NO coins for USDC (1:1). Aborts unless resolved and NO won.
    public fun redeem_no<Stable, Yes, No>(
        market: &mut Market<Stable, Yes, No>,
        no: Coin<No>,
        ctx: &mut TxContext,
    ): Coin<Stable> {
        assert!(market.resolved, ENotResolved);
        assert!(!market.yes_wins, EWrongOutcome);
        let v = coin::value(&no);
        coin::burn(&mut market.no_treasury, no);
        coin::take(&mut market.escrow, v, ctx)
    }

    /// Burn worthless losing coins (cleanup). No payout.
    public fun burn_yes<Stable, Yes, No>(market: &mut Market<Stable, Yes, No>, yes: Coin<Yes>) {
        coin::burn(&mut market.yes_treasury, yes);
    }
    public fun burn_no<Stable, Yes, No>(market: &mut Market<Stable, Yes, No>, no: Coin<No>) {
        coin::burn(&mut market.no_treasury, no);
    }

    // ---- read accessors ----

    public fun task_class<Stable, Yes, No>(m: &Market<Stable, Yes, No>): vector<u8> { m.task_class }
    public fun pool_id<Stable, Yes, No>(m: &Market<Stable, Yes, No>): ID { m.pool_id }
    public fun is_resolved<Stable, Yes, No>(m: &Market<Stable, Yes, No>): bool { m.resolved }
    public fun yes_wins<Stable, Yes, No>(m: &Market<Stable, Yes, No>): bool { m.yes_wins }
    public fun escrow_value<Stable, Yes, No>(m: &Market<Stable, Yes, No>): u64 { balance::value(&m.escrow) }
    public fun market_id<Stable, Yes, No>(m: &Market<Stable, Yes, No>): ID { object::uid_to_inner(&m.id) }
}
