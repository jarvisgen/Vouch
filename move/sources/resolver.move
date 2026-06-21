/// Settlement entrypoint (PTB #2). Reads the auditor verdict + Walrus blob id and
/// settles the per-job state in one atomic flow: policy payout/expire, bond slash, and
/// the agent's reliability update.
///
/// Per-job resolution is DECOUPLED from market settlement on purpose: a standing
/// prediction market on an agent's ongoing reliability must not terminally settle after
/// a single job (and that would make repeated jobs abort). `resolve` updates reliability
/// every job; `settle_market` is a separate, explicit action for when a market actually
/// expires.
///
/// Trust model (MVP): both entrypoints assert the caller is the registered auditor
/// agent's operator (single-keypair oracle). Production would use multi-auditor staking.
module vouch::resolver {
    use sui::balance;
    use sui::coin;
    use sui::event;
    use vouch::agent_registry::{Self, Agent};
    use vouch::insurance::{Self, ReservePool, Policy};
    use vouch::market::{Self, Market};

    /// Caller is not the registered auditor operator (or the agent isn't an auditor).
    const ENotAuditor: u64 = 1;
    /// Worker agent and policy refer to different task-classes.
    const ETaskClassMismatch: u64 = 2;

    public struct Resolved has copy, drop {
        agent_id: ID,
        policy_id: ID,
        verdict_pass: bool,
        walrus_blob_id: vector<u8>,
        payout: u64,
        slashed: u64,
        new_reliability_bps: u64,
    }

    /// Settle a job. `verdict_pass` == the worker correctly completed the task.
    /// `new_reliability_bps` is the agent's updated reliability (read off the market /
    /// recomputed by the agent service). Repeatable across many jobs.
    public fun resolve<Stable>(
        policy: &mut Policy<Stable>,
        reserve: &mut ReservePool<Stable>,
        agent: &mut Agent<Stable>,
        auditor: &Agent<Stable>,
        verdict_pass: bool,
        walrus_blob_id: vector<u8>,
        new_reliability_bps: u64,
        ctx: &mut TxContext,
    ) {
        assert!(agent_registry::is_auditor(auditor), ENotAuditor);
        assert!(ctx.sender() == agent_registry::owner(auditor), ENotAuditor);
        assert!(insurance::task_class(policy) == agent_registry::task_class(agent), ETaskClassMismatch);

        let mut payout_amt = 0;
        let mut slashed_amt = 0;
        if (!verdict_pass) {
            let pay = insurance::payout(reserve, policy, ctx);
            payout_amt = coin::value(&pay);
            transfer::public_transfer(pay, insurance::holder(policy));
            let slashed = agent_registry::slash_bond(agent, insurance::coverage(policy));
            slashed_amt = balance::value(&slashed);
            insurance::fund_reserve(reserve, slashed);
        } else {
            insurance::expire(policy);
        };

        agent_registry::record_job(agent, !verdict_pass, new_reliability_bps);

        event::emit(Resolved {
            agent_id: agent_registry::agent_id(agent),
            policy_id: insurance::policy_id(policy),
            verdict_pass,
            walrus_blob_id,
            payout: payout_amt,
            slashed: slashed_amt,
            new_reliability_bps,
        });
    }

    /// Explicitly settle a market (e.g. at expiry). Separate from per-job resolution.
    /// Auditor-gated. After this, YES/NO redemption is enabled in `market`.
    public fun settle_market<Stable, Yes, No>(
        market: &mut Market<Stable, Yes, No>,
        auditor: &Agent<Stable>,
        yes_wins: bool,
        ctx: &mut TxContext,
    ) {
        assert!(agent_registry::is_auditor(auditor), ENotAuditor);
        assert!(ctx.sender() == agent_registry::owner(auditor), ENotAuditor);
        market::settle(market, yes_wins);
    }
}
