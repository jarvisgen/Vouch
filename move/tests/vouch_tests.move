/// Unit tests for the implemented modules (mock_usdc + agent_registry).
/// Market / insurance / resolver tests are added as those modules land (step 3).
#[test_only]
module vouch::vouch_tests {
    use std::string;
    use sui::test_scenario as ts;
    use sui::coin;
    use sui::balance;
    use vouch::agent_registry::{Self as registry, AgentRegistry, AdminCap, Agent};
    use vouch::mock_usdc::MOCK_USDC;

    const ADMIN: address = @0xA;
    const WORKER: address = @0xB;
    const AUDITOR: address = @0xC;

    fun bond(amount: u64, scenario: &mut ts::Scenario): coin::Coin<MOCK_USDC> {
        coin::mint_for_testing<MOCK_USDC>(amount, ts::ctx(scenario))
    }

    #[test]
    fun register_worker_stakes_bond() {
        let mut scenario = ts::begin(ADMIN);
        registry::init_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, WORKER);
        {
            let mut reg = ts::take_shared<AgentRegistry>(&scenario);
            let b = bond(2_000_000, &mut scenario);
            registry::register_agent<MOCK_USDC>(
                &mut reg,
                string::utf8(b"ClauseBot"),
                b"clause",
                b,
                9_200,
                ts::ctx(&mut scenario),
            );
            assert!(registry::agent_count(&reg) == 1, 0);
            ts::return_shared(reg);
        };

        ts::next_tx(&mut scenario, WORKER);
        {
            let agent = ts::take_shared<Agent<MOCK_USDC>>(&scenario);
            assert!(registry::bond_value(&agent) == 2_000_000, 1);
            assert!(!registry::is_auditor(&agent), 2);
            assert!(registry::owner(&agent) == WORKER, 3);
            assert!(registry::reliability_bps(&agent) == 9_200, 4);
            assert!(registry::task_class(&agent) == b"clause", 5);
            ts::return_shared(agent);
        };

        ts::end(scenario);
    }

    #[test]
    fun admin_registers_auditor() {
        let mut scenario = ts::begin(ADMIN);
        registry::init_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ADMIN);
        {
            let mut reg = ts::take_shared<AgentRegistry>(&scenario);
            let cap = ts::take_from_sender<AdminCap>(&scenario);
            let b = bond(5_000_000, &mut scenario);
            registry::register_auditor<MOCK_USDC>(
                &cap,
                &mut reg,
                string::utf8(b"AuditorBot"),
                AUDITOR,
                b,
                ts::ctx(&mut scenario),
            );
            ts::return_to_sender(&scenario, cap);
            ts::return_shared(reg);
        };

        ts::next_tx(&mut scenario, ADMIN);
        {
            let agent = ts::take_shared<Agent<MOCK_USDC>>(&scenario);
            assert!(registry::is_auditor(&agent), 0);
            assert!(registry::task_class(&agent) == b"*", 1);
            ts::return_shared(agent);
        };

        ts::end(scenario);
    }

    #[test]
    fun slash_and_record_job() {
        let mut scenario = ts::begin(ADMIN);
        registry::init_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, WORKER);
        {
            let mut reg = ts::take_shared<AgentRegistry>(&scenario);
            let b = bond(2_000_000, &mut scenario);
            registry::register_agent<MOCK_USDC>(
                &mut reg, string::utf8(b"ClauseBot"), b"clause", b, 9_200, ts::ctx(&mut scenario),
            );
            ts::return_shared(reg);
        };

        ts::next_tx(&mut scenario, WORKER);
        {
            let mut agent = ts::take_shared<Agent<MOCK_USDC>>(&scenario);

            // top up
            let extra = bond(1_000_000, &mut scenario);
            registry::top_up_bond<MOCK_USDC>(&mut agent, extra, ts::ctx(&mut scenario));
            assert!(registry::bond_value(&agent) == 3_000_000, 0);

            // slash (resolver-path mutation)
            let slashed = registry::slash_bond<MOCK_USDC>(&mut agent, 1_200_000);
            assert!(balance::value(&slashed) == 1_200_000, 1);
            assert!(registry::bond_value(&agent) == 1_800_000, 2);
            balance::destroy_for_testing(slashed);

            // slash more than available clamps to remaining
            let rest = registry::slash_bond<MOCK_USDC>(&mut agent, 999_000_000);
            assert!(balance::value(&rest) == 1_800_000, 3);
            assert!(registry::bond_value(&agent) == 0, 4);
            balance::destroy_for_testing(rest);

            // record a failed job
            registry::record_job<MOCK_USDC>(&mut agent, true, 8_800);
            assert!(registry::jobs_total(&agent) == 1, 5);
            assert!(registry::jobs_failed(&agent) == 1, 6);
            assert!(registry::reliability_bps(&agent) == 8_800, 7);

            ts::return_shared(agent);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = vouch::agent_registry::EBondTooLow)]
    fun bond_below_minimum_aborts() {
        let mut scenario = ts::begin(ADMIN);
        registry::init_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, WORKER);
        {
            let mut reg = ts::take_shared<AgentRegistry>(&scenario);
            let b = bond(1, &mut scenario); // below MIN_BOND
            registry::register_agent<MOCK_USDC>(
                &mut reg, string::utf8(b"Cheapskate"), b"clause", b, 5_000, ts::ctx(&mut scenario),
            );
            ts::return_shared(reg);
        };

        ts::end(scenario);
    }
}
