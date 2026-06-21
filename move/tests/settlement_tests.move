/// Integration tests for market + insurance + resolver, end to end.
/// Uses local test coin types (USD stablecoin, YES/NO outcomes) so it doesn't depend on
/// the concrete outcome_coins modules.
#[test_only]
module vouch::settlement_tests {
    use std::string;
    use sui::test_scenario as ts;
    use sui::coin::{Self, Coin};
    use vouch::agent_registry::{Self as reg, AgentRegistry, AdminCap, Agent};
    use vouch::insurance::{Self, ReservePool, Policy};
    use vouch::market::{Self, Market};

    public struct USD has drop {}
    public struct YES has drop {}
    public struct NO has drop {}

    const ADMIN: address = @0xA;
    const WORKER: address = @0xB;
    const AUDITOR: address = @0xC;
    const HIRER: address = @0xD;

    const RESERVE_SEED: u64 = 100_000_000; // 100 USDC
    const WORKER_BOND: u64 = 10_000_000;   // 10 USDC
    const AUDITOR_BOND: u64 = 2_000_000;   // 2 USDC
    const COVERAGE: u64 = 5_000_000;       // 5 USDC
    const PREMIUM: u64 = 200_000;          // 0.2 USDC

    fun usd(amount: u64, sc: &mut ts::Scenario): Coin<USD> {
        coin::mint_for_testing<USD>(amount, ts::ctx(sc))
    }

    /// Stand up registry, reserve (seeded), auditor, worker, market, and a bought policy.
    /// Leaves the scenario on a HIRER tx.
    fun setup(sc: &mut ts::Scenario) {
        reg::init_for_testing(ts::ctx(sc));
        insurance::create_reserve<USD>(ts::ctx(sc));

        // ADMIN: seed reserve + register auditor (operated by AUDITOR).
        ts::next_tx(sc, ADMIN);
        {
            let mut reserve = ts::take_shared<ReservePool<USD>>(sc);
            let seed = usd(RESERVE_SEED, sc);
            insurance::deposit<USD>(&mut reserve, seed);
            ts::return_shared(reserve);

            let mut registry = ts::take_shared<AgentRegistry>(sc);
            let cap = ts::take_from_sender<AdminCap>(sc);
            let abond = usd(AUDITOR_BOND, sc);
            reg::register_auditor<USD>(&cap, &mut registry, string::utf8(b"AuditorBot"), AUDITOR, abond, ts::ctx(sc));
            ts::return_to_sender(sc, cap);
            ts::return_shared(registry);
        };

        // WORKER: register the worker (shared after the auditor → most recent).
        ts::next_tx(sc, WORKER);
        {
            let mut registry = ts::take_shared<AgentRegistry>(sc);
            let wbond = usd(WORKER_BOND, sc);
            reg::register_agent<USD>(&mut registry, string::utf8(b"ClauseBot"), b"clause", wbond, 9_200, ts::ctx(sc));
            ts::return_shared(registry);
        };

        // ADMIN: create the clause market with fresh outcome treasuries.
        ts::next_tx(sc, ADMIN);
        {
            let yes_cap = coin::create_treasury_cap_for_testing<YES>(ts::ctx(sc));
            let no_cap = coin::create_treasury_cap_for_testing<NO>(ts::ctx(sc));
            let pool_id = object::id_from_address(@0xFEED);
            market::new_market<USD, YES, NO>(b"clause", pool_id, yes_cap, no_cap, ts::ctx(sc));
        };

        // HIRER: buy the completion guarantee.
        ts::next_tx(sc, HIRER);
        {
            let worker = ts::take_shared<Agent<USD>>(sc); // most recent = worker
            let aid = reg::agent_id(&worker);
            ts::return_shared(worker);

            let mut reserve = ts::take_shared<ReservePool<USD>>(sc);
            let premium = usd(PREMIUM, sc);
            insurance::buy_policy<USD>(&mut reserve, aid, b"clause", COVERAGE, premium, ts::ctx(sc));
            ts::return_shared(reserve);
        };
    }

    /// Take (worker, auditor) handling the two shared Agent<USD> objects by recency.
    fun take_agents(sc: &ts::Scenario): (Agent<USD>, Agent<USD>) {
        let worker = ts::take_shared<Agent<USD>>(sc);  // most recent
        let auditor = ts::take_shared<Agent<USD>>(sc);
        assert!(!reg::is_auditor(&worker), 90);
        assert!(reg::is_auditor(&auditor), 91);
        (worker, auditor)
    }

    #[test]
    fun market_mint_set_and_redeem() {
        let mut sc = ts::begin(ADMIN);
        {
            let yes_cap = coin::create_treasury_cap_for_testing<YES>(ts::ctx(&mut sc));
            let no_cap = coin::create_treasury_cap_for_testing<NO>(ts::ctx(&mut sc));
            let pool_id = object::id_from_address(@0xFEED);
            market::new_market<USD, YES, NO>(b"clause", pool_id, yes_cap, no_cap, ts::ctx(&mut sc));
        };

        ts::next_tx(&mut sc, ADMIN);
        {
            let mut m = ts::take_shared<Market<USD, YES, NO>>(&sc);
            let stake = usd(10_000_000, &mut sc);
            let (yes, no) = market::mint_set<USD, YES, NO>(&mut m, stake, ts::ctx(&mut sc));
            assert!(market::escrow_value(&m) == 10_000_000, 0);

            // agent succeeds ⇒ YES wins
            market::settle<USD, YES, NO>(&mut m, true);
            let won = market::redeem_yes<USD, YES, NO>(&mut m, yes, ts::ctx(&mut sc));
            assert!(coin::value(&won) == 10_000_000, 1);
            assert!(market::escrow_value(&m) == 0, 2);
            coin::burn_for_testing(won);
            market::burn_no<USD, YES, NO>(&mut m, no); // losing side, worthless
            ts::return_shared(m);
        };
        ts::end(sc);
    }

    #[test]
    fun resolve_failure_pays_user_and_slashes_bond() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        ts::next_tx(&mut sc, AUDITOR);
        {
            let mut policy = ts::take_shared<Policy<USD>>(&sc);
            let mut reserve = ts::take_shared<ReservePool<USD>>(&sc);
            let (mut worker, auditor) = take_agents(&sc);

            vouch::resolver::resolve<USD>(
                &mut policy, &mut reserve, &mut worker, &auditor,
                false, b"walrus-blob-fail", 7_000, ts::ctx(&mut sc),
            );

            assert!(insurance::is_paid_out(&policy), 1);
            assert!(reg::jobs_total(&worker) == 1 && reg::jobs_failed(&worker) == 1, 2);
            assert!(reg::reliability_bps(&worker) == 7_000, 3);
            // bond 10 - coverage 5 = 5
            assert!(reg::bond_value(&worker) == WORKER_BOND - COVERAGE, 4);
            // reserve = seed + premium - payout + slashed
            assert!(insurance::reserve_balance(&reserve) == RESERVE_SEED + PREMIUM - COVERAGE + COVERAGE, 5);

            ts::return_shared(policy);
            ts::return_shared(reserve);
            ts::return_shared(worker);
            ts::return_shared(auditor);
        };

        // HIRER received the payout.
        ts::next_tx(&mut sc, HIRER);
        {
            let pay = ts::take_from_sender<Coin<USD>>(&sc);
            assert!(coin::value(&pay) == COVERAGE, 6);
            coin::burn_for_testing(pay);
        };
        ts::end(sc);
    }

    #[test]
    fun resolve_success_expires_policy() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        ts::next_tx(&mut sc, AUDITOR);
        {
            let mut policy = ts::take_shared<Policy<USD>>(&sc);
            let mut reserve = ts::take_shared<ReservePool<USD>>(&sc);
            let (mut worker, auditor) = take_agents(&sc);

            vouch::resolver::resolve<USD>(
                &mut policy, &mut reserve, &mut worker, &auditor,
                true, b"walrus-blob-pass", 9_500, ts::ctx(&mut sc),
            );

            assert!(insurance::is_expired(&policy), 1);
            assert!(reg::jobs_total(&worker) == 1 && reg::jobs_failed(&worker) == 0, 2);
            assert!(reg::bond_value(&worker) == WORKER_BOND, 3); // unslashed
            assert!(insurance::reserve_balance(&reserve) == RESERVE_SEED + PREMIUM, 4); // premium retained

            ts::return_shared(policy);
            ts::return_shared(reserve);
            ts::return_shared(worker);
            ts::return_shared(auditor);
        };
        ts::end(sc);
    }

    #[test]
    #[expected_failure(abort_code = vouch::resolver::ENotAuditor)]
    fun non_auditor_cannot_resolve() {
        let mut sc = ts::begin(ADMIN);
        setup(&mut sc);

        // Signed by WORKER, not the auditor operator → must abort.
        ts::next_tx(&mut sc, WORKER);
        {
            let mut policy = ts::take_shared<Policy<USD>>(&sc);
            let mut reserve = ts::take_shared<ReservePool<USD>>(&sc);
            let (mut worker, auditor) = take_agents(&sc);

            vouch::resolver::resolve<USD>(
                &mut policy, &mut reserve, &mut worker, &auditor,
                false, b"blob", 5_000, ts::ctx(&mut sc),
            );

            ts::return_shared(policy);
            ts::return_shared(reserve);
            ts::return_shared(worker);
            ts::return_shared(auditor);
        };
        ts::end(sc);
    }
}
