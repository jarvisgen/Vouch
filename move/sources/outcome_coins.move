/// YES/NO outcome coin types — one pair per task-class. These are STATIC: Move can't
/// mint coin types at runtime, so each task-class declares its pair at publish (and a
/// new task-class means republishing — the documented scaling limit).
///
/// Each module's `init` mints its TreasuryCap to the deployer, who hands the YES+NO caps
/// to `market::new_market` when creating that task-class's market. The YES coin is what
/// trades on the real DeepBook YES/USDC pool. 6 decimals to match USDC.
///
/// One one-time-witness per module (Move constraint), so each coin is its own module;
/// they share this file. `create_currency` is fine for these utility tokens.

module vouch::yes_clause {
    use sui::coin;
    public struct YES_CLAUSE has drop {}
    #[allow(deprecated_usage)]
    fun init(w: YES_CLAUSE, ctx: &mut TxContext) {
        let (cap, meta) = coin::create_currency(w, 6, b"yCLAUSE", b"Vouch YES: Clause", b"YES outcome for the clause task-class market", option::none(), ctx);
        transfer::public_freeze_object(meta);
        transfer::public_transfer(cap, ctx.sender());
    }
}

module vouch::no_clause {
    use sui::coin;
    public struct NO_CLAUSE has drop {}
    #[allow(deprecated_usage)]
    fun init(w: NO_CLAUSE, ctx: &mut TxContext) {
        let (cap, meta) = coin::create_currency(w, 6, b"nCLAUSE", b"Vouch NO: Clause", b"NO outcome for the clause task-class market", option::none(), ctx);
        transfer::public_freeze_object(meta);
        transfer::public_transfer(cap, ctx.sender());
    }
}

module vouch::yes_invoice {
    use sui::coin;
    public struct YES_INVOICE has drop {}
    #[allow(deprecated_usage)]
    fun init(w: YES_INVOICE, ctx: &mut TxContext) {
        let (cap, meta) = coin::create_currency(w, 6, b"yINVOICE", b"Vouch YES: Invoice", b"YES outcome for the invoice task-class market", option::none(), ctx);
        transfer::public_freeze_object(meta);
        transfer::public_transfer(cap, ctx.sender());
    }
}

module vouch::no_invoice {
    use sui::coin;
    public struct NO_INVOICE has drop {}
    #[allow(deprecated_usage)]
    fun init(w: NO_INVOICE, ctx: &mut TxContext) {
        let (cap, meta) = coin::create_currency(w, 6, b"nINVOICE", b"Vouch NO: Invoice", b"NO outcome for the invoice task-class market", option::none(), ctx);
        transfer::public_freeze_object(meta);
        transfer::public_transfer(cap, ctx.sender());
    }
}

module vouch::yes_citation {
    use sui::coin;
    public struct YES_CITATION has drop {}
    #[allow(deprecated_usage)]
    fun init(w: YES_CITATION, ctx: &mut TxContext) {
        let (cap, meta) = coin::create_currency(w, 6, b"yCITE", b"Vouch YES: Citation", b"YES outcome for the citation task-class market", option::none(), ctx);
        transfer::public_freeze_object(meta);
        transfer::public_transfer(cap, ctx.sender());
    }
}

module vouch::no_citation {
    use sui::coin;
    public struct NO_CITATION has drop {}
    #[allow(deprecated_usage)]
    fun init(w: NO_CITATION, ctx: &mut TxContext) {
        let (cap, meta) = coin::create_currency(w, 6, b"nCITE", b"Vouch NO: Citation", b"NO outcome for the citation task-class market", option::none(), ctx);
        transfer::public_freeze_object(meta);
        transfer::public_transfer(cap, ctx.sender());
    }
}
