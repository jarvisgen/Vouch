# Vouch — a tradable trust layer for the AI‑agent economy

> Hire an autonomous AI agent for a real task, **insure the result**, and let an
> **independent on‑chain auditor verify it**. The agent's live **DeepBook** market price
> *is* its reliability; evidence lives on **Walrus**; payments settle in USDC.

Built for **Sui Overflow 2026** — targeting **Agentic Web · DeFi & Payments · DeepBook · Walrus**.
Everything below is **live on Sui testnet**.

---

## The problem

An AI agent can do paid work, but you have no way to know if it got it right — and no
recourse if it didn't. Vouch makes agent reliability **measurable, insurable, and tradable**:

- Agents register on‑chain with a **staked bond** and serve **objective** task‑classes.
- You hire one, optionally buying a **completion guarantee**. Your fee is **escrowed**.
- The agent does the work; an **independent auditor** re‑derives the answer from chain
  state (or, for open‑ended tasks, an independent judge model grades it).
- The full evidence bundle is stored on **Walrus**.
- Resolution settles atomically: **PASS →** the agent is paid; **FAIL →** you're refunded,
  the agent earns nothing and its **bond is slashed**.
- Each agent's reliability is the **YES mid‑price of a real DeepBook pool**, re‑anchored to
  its on‑chain track record after every job.

---

## The loop

```
HIRE (PTB #1)                WORK                AUDIT + RESOLVE (PTB #2)
─────────────            ────────────        ─────────────────────────────
parse request (NL→target)   agent (Groq or     auditor re‑derives ground truth
fee ESCROWED                 external endpoint) │   on‑chain / judge model
premium → reserve            produces output    ▼
platform fee → treasury        │            evidence bundle → Walrus (blobId)
  ▼                            ▼                resolve():
Policy created            output streamed        PASS → release fee to agent, keep premium
                          to terminal live       FAIL → refund user, agent $0, slash bond
                                                  reliability ← Beta(pass‑rate) → re‑quote DeepBook pool
```

Two PTBs, each internally atomic. The terminal narrates every real step live (SSE stream).

---

## Four‑track mapping (for judges)

| Track | Where | Why it's load‑bearing |
|---|---|---|
| **Agentic Web** | `agents/`, `move/sources/agent_registry.move`, `resolver.move` | Agents have on‑chain identity + **slashable bonds**; an independent **auditor agent** resolves; anyone can **import an external agent** by endpoint and earn a tradable reputation. |
| **DeepBook** | `agents/src/deepbook.ts`, `scripts`/`make-market` | A real **DeepBook v3 pool per task‑class** trades each agent's YES coin; the **mid‑price = the agent's live reliability**; users place **real limit orders** (price + size); performance re‑quotes it each job. |
| **DeFi & Payments** | `move/sources/insurance.move`, `agents/src/chain.ts` | Fee **escrow**, parametric **insurance** (reserve + premiums), **bond slashing**, and a protocol **take‑rate** — all real testnet‑USDC transfers in atomic PTBs. |
| **Walrus** | `agents/src/walrus.ts` | Every job's **evidence bundle** (input hash, output, auditor verdict) is stored on Walrus testnet; the resolution references the blob. |

**Primary track: Agentic Web** — a trust/insurance/reputation layer for autonomous agents;
the other three are the infrastructure that makes it real, used together in one coherent loop.

---

## Live testnet deployment

| Object | ID |
|---|---|
| Vouch package | `0x9a346250e43b40729748c2819fe6ee1497f9addac1584293b24c7ac05172fbb6` |
| AgentRegistry (shared) | `0xbe5dd6b7ada9ed044be961cfe53083fbe37313444166e4a70edc367481b057d3` |
| Insurance ReservePool | `0x1bdc87df990f9fd87d958f9fab07c4b4676850d41bb8a977ab8d5a3979eae456` |
| Mock USDC type | `0x9a346250…::mock_usdc::MOCK_USDC` |
| Protocol treasury (take‑rate) | `0xdace7baf8b72ae53024ffa374148b2dbe9547d6617b226b21c548da46675b6d5` |
| DeepBook pool — clause | `0xb7ef81d97bd543cb3de1a18974104515bfda1a50b4ea849fa6d0825b6fc7b2cc` |
| DeepBook pool — invoice | `0x8f9afca99fcb43a98f619d4ea1d72f9a7899a7074e01064b1bab8a1bca485fc7` |
| DeepBook pool — citation | `0x30688ce75e3591e6023a4eaa5a92487cd8edb1aab029ee36a0ea88a7e531f660` |
| DeepBook balance manager | `0x142bfb506bc04067c129942a30d0be0c8754fee90e36641209e71918d787f6d4` |
| DeepBook v3 (testnet) package | `0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c` |

Full map (per‑task coin types, caps, agent/market ids): `deployments/testnet.json`.

---

## The agents

| Agent | Task‑class | What it does | Verified by |
|---|---|---|---|
| **MovePackageAuditor** | `move-audit` | Fetches a package's on‑chain modules, flags ungated privileged functions | Auditor re‑fetches modules on‑chain, re‑derives the list |
| **CoinSafetyChecker** | `coin-safety` | Reads a coin's package → freezable? publicly mintable? | Auditor re‑reads on‑chain |
| **RouteOptimizer** | `route` | Best fee‑adjusted swap route across candidate pools | Auditor recomputes every pool's output |
| **NaiveRouter** | `route` | *Deliberately flawed* (ignores fees) — the bad‑agent demo | Same recompute → reliably caught |
| **GeneralBot** | `general` | Open‑ended Q&A (like normal gen‑AI) | **Independent stronger judge LLM** (best‑effort, not a proof) |

Workers run on **Groq** (`llama-3.1-8b` / `llama-3.3-70b`) behind the **import‑an‑agent**
interface (`POST {taskClass, input} → {result}`); built‑ins are dogfooded through it.

---

## Revenue model

The protocol earns from two streams, shown live in the header chip:

1. **Marketplace take‑rate** — **10%** of every task fee → the treasury address (a real,
   segregated on‑chain transfer).
2. **Underwriting margin** — premiums carry a **+20% load** (`premium = (1−reliability)×coverage×1.2`),
   collected into the reserve. Net = **premiums − payouts + recovered bonds**.

Because a bonded agent's **own bond covers its claims**, a covered failure costs the
protocol ~nothing — premiums are near‑pure margin; the protocol only takes a loss when an
agent's bond is exhausted (which is why bonds + suspension matter). Future levers: reserve
float yield, listing fees, reputation‑as‑an‑oracle API.

---

## Trust model

- **Objective task‑classes** (`move-audit`, `coin-safety`, `route`): the auditor re‑derives
  ground truth from chain state / recomputation, so the verdict is **provable**.
- **General task‑class**: no ground truth → an **independent, stronger judge model** grades
  the answer. **Best‑effort verification, not a proof** (e.g. unreliable for arithmetic — use
  the objective agents for that). The UI states this explicitly.
- **Auditor authority (MVP):** a single registered auditor keypair gates `resolve()`.
  Production needs multi‑auditor staking + a dispute window.

---

## Repo layout

```
move/      Sui Move package — agent_registry, market, insurance, resolver, mock_usdc, outcome_coins (+ tests)
agents/    TS backend — worker/auditor (tasks.ts), Groq (anthropic.ts), Walrus, on‑chain reads (onchain.ts),
           DeepBook (deepbook.ts), chain layer (chain.ts), server (server.ts, SSE), make-market.ts
web/       React + Vite + @mysten/dapp-kit dashboard (terminal + agents + hire + DeepBook + revenue)
scripts/   publish + seed
deployments/testnet.json   live object ids
```

---

## Deploy

**Backend → Render (free).** One‑click Blueprint (reads `render.yaml`):

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jarvisgen/Vouch)

1. Click the button → authorize GitHub → Render creates the `vouch-backend` web service (free, single instance).
2. Set the two **secret** env vars in the Render dashboard: `SUI_MNEMONIC`, `GROQ_API_KEY`.
3. Deploy → you get `https://vouch-backend.onrender.com`; check `…/api/health`.
   *(Free tier sleeps after ~15 min idle — hit `/api/health` once to warm it before a demo.)*

**Frontend → Vercel.** Uses the root `vercel.json` (builds `web` → `web/dist`). Set one env var:
- `VITE_API` = your Render backend URL (e.g. `https://vouch-backend.onrender.com`), then redeploy.

## Setup

```bash
# toolchain (macOS)
brew install sui            # or download the testnet binary
brew install node && corepack enable && corepack prepare pnpm@latest --activate

pnpm install
cp .env.example .env        # set SUI_MNEMONIC, GROQ_API_KEY (or ANTHROPIC_API_KEY), Walrus endpoints
```

Wallet/keys live in `.env` (gitignored). Worker LLM: `LLM_PROVIDER=groq` + `GROQ_API_KEY`
(or `anthropic`). Auditor‑for‑general uses `llama-3.3-70b`.

### Build / test the Move package
```bash
sui move test --path move     # 8 unit tests
sui move build --path move
```

### Publish + seed (already done on testnet — see addresses above)
```bash
sui client publish move --json --skip-dependency-verification   # → packageId
pnpm tsx scripts/seed.ts        # reserve, auditor, agents, markets
pnpm --filter @vouch/agents make-market   # DeepBook pools + liquidity (needs ~500 testnet DEEP per pool)
```

### Run
```bash
pnpm agents     # backend on :8787  (hire→work→audit→Walrus→resolve, streamed)
pnpm web        # dapp on :5173
```

---

## Demo script (for judges)

1. **Open the dashboard.** Header shows `● live · testnet`, the protocol‑revenue chip, and a
   live **terminal**. Left = agents, middle = Hire + Reliability, right = DeepBook market.
2. **Genuine success:** select **MovePackageAuditor** → type *"audit 0x36dbef…"* (or click an
   example) → **Hire & run**. Watch the terminal stream `PARSE → HIRE → WORK → AUDIT → WALRUS →
   RESOLVE`. The result shows the readable audit + **✓ verified**, fee released to the agent.
3. **Natural language:** select **CoinSafetyChecker** → *"is DEEP safe to hold?"* → it resolves
   to the coin type and returns freezable/mintable flags. Try a fuzzy name → it **asks you to
   confirm** the interpretation before running.
4. **The money shot (failure + insurance):** select **NaiveRouter** → load the route example →
   it picks the wrong pool → **auditor FAIL** → terminal shows *"your fee refunded · agent
   earned $0 · bond slashed"*; **reliability drops**, the **DeepBook pool re‑quotes down**, and
   the **protocol‑revenue chip** updates.
5. **Trade reliability:** in the DeepBook panel, place a **Buy/Sell YES** limit order (price +
   size) and watch the live mid move; open the **pool on Suiscan**.
6. **Open market:** click **+ Import agent** to list an external agent (endpoint + bond + price).
7. **General agent:** select **GeneralBot**, ask anything → answer graded by the independent
   judge (note: best‑effort, not a proof).

---

## Test cases

**Move unit tests** (`sui move test`, 8/8 passing):
- register worker stakes bond; admin registers auditor; bond‑below‑minimum aborts
- bond slash clamps to balance; job/record updates
- market mint‑set → settle → redeem; resolve **fail** (payout + slash + reliability) and
  **pass** (premium retained); **non‑auditor cannot resolve**

**End‑to‑end (manual / verified live):**
- MovePackageAuditor on a real package → PASS, on‑chain re‑verified
- CoinSafetyChecker NL input ("is DEEP safe?") → resolves + PASS; unknown coin → "confirm?" / help
- NaiveRouter on the fee‑trap → deterministic FAIL → refund + slash + reliability drop + pool re‑quote
- RouteOptimizer clean → PASS; performance pricing climbs on PASS, falls on FAIL (verified)
- DeepBook limit order (price+size) moves the live mid; sweep handled gracefully
- concurrent trade + hire serialize cleanly (tx queue) — no gas‑coin equivocation
- revenue chip accrues take‑rate + net insurance; goes negative when an unbonded agent fails

---

## Known limitations / honest notes

- **DeepBook is hand‑rolled, not the SDK.** We call the DeepBook v3 Move package directly via
  PTBs (constants/scaling mirrored from the SDK source), because the official SDK 1.x requires
  `@mysten/sui@2.x` — a full client‑API rewrite of the backend. Migrating to the SDK is a
  documented future hardening step (a `git tag rollback-pre-sui2` snapshot exists from the attempt).
- **Single‑auditor oracle** (MVP). Production: multi‑auditor staking + disputes.
- **General agent** verdicts are model‑judged (best‑effort), not provable.
- **Revenue tally is in‑memory** for the session (the take‑rate transfer itself is real on‑chain).
- **Mock USDC** stands in for testnet USDC for reproducibility; DeepBook pools/liquidity are
  seeded by a scripted market‑maker.
- New task‑classes reuse existing DeepBook pools; brand‑new pools cost ~500 DEEP each.

---

## Roadmap

Multi‑auditor staking + disputes · migrate to the official DeepBook SDK (sui 2.x) ·
on‑chain agent pricing + min‑bond enforcement / auto‑suspend · reputation oracle API ·
per‑user wallet signing for hire/trade/publish.
