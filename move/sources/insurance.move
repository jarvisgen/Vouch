/// Parametric completion-guarantee policies + the shared reserve pool that pays them.
///
/// Money model (per project decision): the DeepBook market PRICES the premium
/// (premium = f(1 - YES_price) * coverage, computed off-chain); a separate `ReservePool`
/// FUNDS payouts. Premiums flow into the reserve; slashed bonds top it up; on PASS the
/// premium is retained. This keeps market P&L and insurance solvency decoupled.
///
/// `Policy<T>` is a SHARED object so `resolver` (driven by the auditor keypair, not the
/// policy holder) can settle it. Generic over stablecoin `T`.
module vouch::insurance {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::event;

    /// Policy is no longer active.
    const EAlreadyClosed: u64 = 1;
    /// Reserve cannot cover the payout.
    const EReserveInsufficient: u64 = 2;

    // Policy status.
    const ACTIVE: u8 = 0;
    const PAID_OUT: u8 = 1;
    const EXPIRED: u8 = 2;

    /// Shared pool that backs all payouts for a given stablecoin `T`.
    public struct ReservePool<phantom T> has key {
        id: UID,
        funds: Balance<T>,
    }

    /// A completion guarantee bought at hire time. Shared.
    public struct Policy<phantom T> has key {
        id: UID,
        holder: address,
        agent_id: ID,
        task_class: vector<u8>,
        coverage: u64,
        premium_paid: u64,
        status: u8,
    }

    public struct ReserveCreated has copy, drop { reserve_id: ID }
    public struct PolicyBought has copy, drop {
        policy_id: ID,
        holder: address,
        agent_id: ID,
        coverage: u64,
        premium: u64,
    }
    public struct PolicyPaidOut has copy, drop { policy_id: ID, holder: address, amount: u64 }

    /// Create the (empty) reserve for stablecoin `T`. Called once at publish/seed time;
    /// `init` can't be generic, so this picks the concrete stablecoin type.
    public fun create_reserve<T>(ctx: &mut TxContext) {
        let id = object::new(ctx);
        event::emit(ReserveCreated { reserve_id: object::uid_to_inner(&id) });
        transfer::share_object(ReservePool<T> { id, funds: balance::zero<T>() });
    }

    /// Seed/donate funds into the reserve (used by the seed script for initial solvency).
    public fun deposit<T>(reserve: &mut ReservePool<T>, funds: Coin<T>) {
        balance::join(&mut reserve.funds, coin::into_balance(funds));
    }

    /// Buy a guarantee: premium flows into the reserve, a shared Policy is created.
    public fun buy_policy<T>(
        reserve: &mut ReservePool<T>,
        agent_id: ID,
        task_class: vector<u8>,
        coverage: u64,
        premium: Coin<T>,
        ctx: &mut TxContext,
    ) {
        let premium_paid = coin::value(&premium);
        balance::join(&mut reserve.funds, coin::into_balance(premium));
        let id = object::new(ctx);
        let policy_id = object::uid_to_inner(&id);
        let holder = ctx.sender();
        event::emit(PolicyBought { policy_id, holder, agent_id, coverage, premium: premium_paid });
        transfer::share_object(Policy<T> {
            id,
            holder,
            agent_id,
            task_class,
            coverage,
            premium_paid,
            status: ACTIVE,
        });
    }

    // ---- package-internal settlement (called by vouch::resolver) ----

    /// FAIL branch: pay `coverage` out of the reserve; returns the coin to route to the holder.
    public(package) fun payout<T>(
        reserve: &mut ReservePool<T>,
        policy: &mut Policy<T>,
        ctx: &mut TxContext,
    ): Coin<T> {
        assert!(policy.status == ACTIVE, EAlreadyClosed);
        assert!(balance::value(&reserve.funds) >= policy.coverage, EReserveInsufficient);
        policy.status = PAID_OUT;
        event::emit(PolicyPaidOut {
            policy_id: object::uid_to_inner(&policy.id),
            holder: policy.holder,
            amount: policy.coverage,
        });
        coin::take(&mut reserve.funds, policy.coverage, ctx)
    }

    /// PASS branch: close the policy; premium stays in the reserve.
    public(package) fun expire<T>(policy: &mut Policy<T>) {
        assert!(policy.status == ACTIVE, EAlreadyClosed);
        policy.status = EXPIRED;
    }

    /// Top the reserve up with slashed-bond funds.
    public(package) fun fund_reserve<T>(reserve: &mut ReservePool<T>, funds: Balance<T>) {
        balance::join(&mut reserve.funds, funds);
    }

    // ---- read accessors ----

    public fun reserve_balance<T>(reserve: &ReservePool<T>): u64 { balance::value(&reserve.funds) }
    public fun holder<T>(policy: &Policy<T>): address { policy.holder }
    public fun agent_id<T>(policy: &Policy<T>): ID { policy.agent_id }
    public fun coverage<T>(policy: &Policy<T>): u64 { policy.coverage }
    public fun premium_paid<T>(policy: &Policy<T>): u64 { policy.premium_paid }
    public fun task_class<T>(policy: &Policy<T>): vector<u8> { policy.task_class }
    public fun status<T>(policy: &Policy<T>): u8 { policy.status }
    public fun policy_id<T>(policy: &Policy<T>): ID { object::uid_to_inner(&policy.id) }
    public fun is_active<T>(policy: &Policy<T>): bool { policy.status == ACTIVE }
    public fun is_paid_out<T>(policy: &Policy<T>): bool { policy.status == PAID_OUT }
    public fun is_expired<T>(policy: &Policy<T>): bool { policy.status == EXPIRED }
}
