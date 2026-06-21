/// On-chain identity + staked bond for every agent (workers and the auditor).
///
/// Generic over the stablecoin type `T` so the same package works with real testnet
/// USDC or `vouch::mock_usdc` without recompiling — pick the type at the call site.
///
/// `Agent<T>` is a SHARED object: resolution (driven by the auditor, not the agent's
/// owner) mutates it (job counters, bond slashing), so it must be shared.
///
/// Trust anchor: anyone may `register_agent` (a worker, with a bond). Only the holder
/// of `AdminCap` may `register_auditor` — that is what makes `is_auditor` trustworthy,
/// since `resolver` gates settlement on it.
module vouch::agent_registry {
    use std::string::String;
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::table::{Self, Table};
    use sui::event;

    /// Bond is below the minimum stake.
    const EBondTooLow: u64 = 1;
    /// Caller is not the agent owner.
    const ENotOwner: u64 = 2;

    /// Minimum bond: 1 USDC (6 decimals). Tune for the demo.
    const MIN_BOND: u64 = 1_000_000;

    /// Held by the deployer; gates auditor registration.
    public struct AdminCap has key, store { id: UID }

    /// Shared discovery anchor.
    public struct AgentRegistry has key {
        id: UID,
        agent_count: u64,
        /// agent object id -> owner address
        registered: Table<ID, address>,
    }

    /// Agent identity + staked bond. Shared object.
    public struct Agent<phantom T> has key, store {
        id: UID,
        owner: address,
        name: String,
        /// task-class this agent serves, e.g. b"clause" (auditor uses b"*")
        task_class: vector<u8>,
        is_auditor: bool,
        bond: Balance<T>,
        /// fallback reliability for display (bps); live value comes from the market
        reliability_cached: u64,
        jobs_total: u64,
        jobs_failed: u64,
    }

    public struct AgentRegistered has copy, drop {
        agent_id: ID,
        owner: address,
        task_class: vector<u8>,
        is_auditor: bool,
        bond: u64,
        reliability_cached: u64,
    }

    public struct BondSlashed has copy, drop {
        agent_id: ID,
        amount: u64,
        remaining: u64,
    }

    fun init(ctx: &mut TxContext) {
        transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
        transfer::share_object(AgentRegistry {
            id: object::new(ctx),
            agent_count: 0,
            registered: table::new(ctx),
        });
    }

    /// Register a worker agent, staking `bond`. Permissionless; owner = caller.
    public fun register_agent<T>(
        registry: &mut AgentRegistry,
        name: String,
        task_class: vector<u8>,
        bond: Coin<T>,
        reliability_bps: u64,
        ctx: &mut TxContext,
    ) {
        let owner = ctx.sender();
        new_agent<T>(registry, name, task_class, false, bond, reliability_bps, owner, ctx);
    }

    /// Register the auditor (the on-chain resolution oracle). Admin-gated, but the
    /// auditor agent is owned by `operator` — the dedicated auditor keypair that will
    /// sign `resolve`. AdminCap authorizes creation; operator authorizes settlement.
    public fun register_auditor<T>(
        _admin: &AdminCap,
        registry: &mut AgentRegistry,
        name: String,
        operator: address,
        bond: Coin<T>,
        ctx: &mut TxContext,
    ) {
        new_agent<T>(registry, name, b"*", true, bond, 10_000, operator, ctx);
    }

    /// Owner adds more bond.
    public fun top_up_bond<T>(agent: &mut Agent<T>, more: Coin<T>, ctx: &mut TxContext) {
        assert!(ctx.sender() == agent.owner, ENotOwner);
        balance::join(&mut agent.bond, coin::into_balance(more));
    }

    fun new_agent<T>(
        registry: &mut AgentRegistry,
        name: String,
        task_class: vector<u8>,
        is_auditor: bool,
        bond: Coin<T>,
        reliability_bps: u64,
        owner: address,
        ctx: &mut TxContext,
    ) {
        assert!(coin::value(&bond) >= MIN_BOND, EBondTooLow);
        let id = object::new(ctx);
        let agent_id = object::uid_to_inner(&id);
        let agent = Agent<T> {
            id,
            owner,
            name,
            task_class,
            is_auditor,
            bond: coin::into_balance(bond),
            reliability_cached: reliability_bps,
            jobs_total: 0,
            jobs_failed: 0,
        };
        let bond_val = balance::value(&agent.bond);
        table::add(&mut registry.registered, agent_id, owner);
        registry.agent_count = registry.agent_count + 1;
        event::emit(AgentRegistered {
            agent_id,
            owner,
            task_class,
            is_auditor,
            bond: bond_val,
            reliability_cached: reliability_bps,
        });
        transfer::share_object(agent);
    }

    // ---- package-internal mutations (called by vouch::resolver) ----

    /// Slash up to `amount` from the bond; returns the slashed balance (-> reserve).
    public(package) fun slash_bond<T>(agent: &mut Agent<T>, amount: u64): Balance<T> {
        let avail = balance::value(&agent.bond);
        let take = if (amount > avail) avail else amount;
        let slashed = balance::split(&mut agent.bond, take);
        event::emit(BondSlashed {
            agent_id: object::uid_to_inner(&agent.id),
            amount: take,
            remaining: balance::value(&agent.bond),
        });
        slashed
    }

    /// Record a completed job and refresh the cached reliability (from the market).
    public(package) fun record_job<T>(agent: &mut Agent<T>, failed: bool, new_reliability_bps: u64) {
        agent.jobs_total = agent.jobs_total + 1;
        if (failed) {
            agent.jobs_failed = agent.jobs_failed + 1;
        };
        agent.reliability_cached = new_reliability_bps;
    }

    // ---- read accessors ----

    public fun is_auditor<T>(agent: &Agent<T>): bool { agent.is_auditor }
    public fun owner<T>(agent: &Agent<T>): address { agent.owner }
    public fun bond_value<T>(agent: &Agent<T>): u64 { balance::value(&agent.bond) }
    public fun reliability_bps<T>(agent: &Agent<T>): u64 { agent.reliability_cached }
    public fun task_class<T>(agent: &Agent<T>): vector<u8> { agent.task_class }
    public fun jobs_total<T>(agent: &Agent<T>): u64 { agent.jobs_total }
    public fun jobs_failed<T>(agent: &Agent<T>): u64 { agent.jobs_failed }
    public fun agent_id<T>(agent: &Agent<T>): ID { object::uid_to_inner(&agent.id) }
    public fun agent_count(registry: &AgentRegistry): u64 { registry.agent_count }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }
}
