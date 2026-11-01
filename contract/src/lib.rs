//! Agent Leash: an on-chain spending policy for an AI errand agent.
//!
//! The purse is this contract account. The AI agent never holds a full-access key:
//! it gets a function-call access key on this account that may call only
//! `request_payment`. Every payment request is checked here, on-chain, against the
//! owner's policy (allowlist, per-payment cap, daily cap, human-approval threshold,
//! pause switch). A fooled or compromised agent can at most do what the policy allows,
//! and every blocked attempt is written to the on-chain log.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{IterableMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PublicKey};

const DAY_NS: u64 = 86_400_000_000_000;
const MAX_MEMO: usize = 140;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Policy {
    /// Largest single payment the agent may make (yoctoNEAR).
    pub per_payment_limit: U128,
    /// Most the agent may spend per UTC day (yoctoNEAR), approvals included.
    pub daily_limit: U128,
    /// Payments above this go to the owner for approval instead of paying (yoctoNEAR).
    pub approval_above: U128,
    /// Owner's kill switch: when true, every agent request is blocked.
    pub paused: bool,
    /// Most requests the agent may make per UTC day (paid, pending or blocked).
    /// Past this the call fails without writing anything, so a stolen agent key
    /// can't lock the purse's balance up as storage by spamming blocked requests.
    pub max_requests_per_day: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Payee {
    pub label: String,
    pub added_at: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum Status {
    Paid,
    Pending,
    Approved,
    Rejected,
    Blocked,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Request {
    pub id: u64,
    pub to: AccountId,
    pub amount: U128,
    pub memo: String,
    pub status: Status,
    pub reason: String,
    pub at: U64,
    pub decided_at: Option<U64>,
}

#[near(serializers = [json])]
pub struct Summary {
    pub owner: AccountId,
    pub purse: AccountId,
    pub policy: Policy,
    pub balance: U128,
    pub spent_today: U128,
    pub left_today: U128,
    pub requests: u64,
    pub requests_today: u32,
    pub payees: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Leash {
    owner: AccountId,
    policy: Policy,
    payees: IterableMap<AccountId, Payee>,
    log: Vector<Request>,
    day: u64,
    spent_today: u128,
    requests_today: u32,
}

fn event(kind: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"agent_leash\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        kind, data
    ));
}

#[near]
impl Leash {
    #[init]
    pub fn new(owner: AccountId, per_payment_limit: U128, daily_limit: U128, approval_above: U128, max_requests_per_day: Option<u32>) -> Self {
        Self {
            owner,
            policy: Policy { per_payment_limit, daily_limit, approval_above, paused: false, max_requests_per_day: max_requests_per_day.unwrap_or(30) },
            payees: IterableMap::new(b"p"),
            log: Vector::new(b"l"),
            day: env::block_timestamp() / DAY_NS,
            spent_today: 0,
            requests_today: 0,
        }
    }

    // ---------- the agent's only door ----------

    /// Called by the agent through its function-call key on this account.
    /// Never panics on a policy breach: the attempt is recorded as Blocked, so the
    /// owner sees it on-chain.
    pub fn request_payment(&mut self, to: AccountId, amount: U128, memo: String) -> Request {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Only the agent key on this purse may request payments"
        );
        self.roll_day();
        require!(
            self.requests_today < self.policy.max_requests_per_day,
            "Daily request cap reached; nothing recorded"
        );
        self.requests_today += 1;
        let memo: String = memo.chars().take(MAX_MEMO).collect();
        let id = self.log.len() as u64;
        let a = amount.0;
        let (status, reason) = if self.policy.paused {
            (Status::Blocked, "purse is paused by the owner".to_string())
        } else if a == 0 {
            (Status::Blocked, "amount must be above zero".to_string())
        } else if !self.payees.contains_key(&to) {
            (Status::Blocked, format!("{} is not on the owner's allowlist", to))
        } else if a > self.policy.per_payment_limit.0 {
            (Status::Blocked, "above the per-payment limit".to_string())
        } else if self.spent_today.saturating_add(a) > self.policy.daily_limit.0 {
            (Status::Blocked, "would exceed today's limit".to_string())
        } else if a > env::account_balance().as_yoctonear().saturating_sub(self.storage_reserve()) {
            (Status::Blocked, "purse balance too low".to_string())
        } else if a > self.policy.approval_above.0 {
            (Status::Pending, "above the auto-approve amount; waiting for the owner".to_string())
        } else {
            (Status::Paid, "within policy".to_string())
        };
        if status == Status::Paid {
            self.spent_today += a;
            Promise::new(to.clone()).transfer(NearToken::from_yoctonear(a)).detach();
        }
        let r = Request { id, to, amount, memo, status, reason, at: U64(env::block_timestamp()), decided_at: None };
        event("request", near_sdk::serde_json::to_string(&r).unwrap_or_default());
        self.log.push(r.clone());
        r
    }

    // ---------- owner controls ----------

    pub fn approve(&mut self, id: u64) -> Request {
        self.assert_owner();
        self.roll_day();
        let r = self.log.get_mut(id as u32).expect("no such request");
        require!(r.status == Status::Pending, "request is not pending");
        let a = r.amount.0;
        require!(self.spent_today.saturating_add(a) <= self.policy.daily_limit.0, "would exceed today's limit");
        r.status = Status::Approved;
        r.reason = "approved by the owner".to_string();
        r.decided_at = Some(U64(env::block_timestamp()));
        let out = r.clone();
        self.spent_today += a;
        Promise::new(out.to.clone()).transfer(NearToken::from_yoctonear(a)).detach();
        event("approved", near_sdk::serde_json::to_string(&out).unwrap_or_default());
        out
    }

    pub fn reject(&mut self, id: u64) -> Request {
        self.assert_owner();
        let r = self.log.get_mut(id as u32).expect("no such request");
        require!(r.status == Status::Pending, "request is not pending");
        r.status = Status::Rejected;
        r.reason = "rejected by the owner".to_string();
        r.decided_at = Some(U64(env::block_timestamp()));
        let out = r.clone();
        event("rejected", near_sdk::serde_json::to_string(&out).unwrap_or_default());
        out
    }

    pub fn add_payee(&mut self, account: AccountId, label: String) {
        self.assert_owner();
        self.payees.insert(account.clone(), Payee { label: label.chars().take(60).collect(), added_at: U64(env::block_timestamp()) });
        event("payee_added", format!("{{\"account\":\"{}\"}}", account));
    }

    pub fn remove_payee(&mut self, account: AccountId) {
        self.assert_owner();
        self.payees.remove(&account);
        event("payee_removed", format!("{{\"account\":\"{}\"}}", account));
    }

    pub fn set_policy(&mut self, per_payment_limit: U128, daily_limit: U128, approval_above: U128, max_requests_per_day: Option<u32>) {
        self.assert_owner();
        let paused = self.policy.paused;
        let max_requests_per_day = max_requests_per_day.unwrap_or(self.policy.max_requests_per_day);
        self.policy = Policy { per_payment_limit, daily_limit, approval_above, paused, max_requests_per_day };
        event("policy", near_sdk::serde_json::to_string(&self.policy).unwrap_or_default());
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.policy.paused = paused;
        event("paused", format!("{{\"paused\":{}}}", paused));
    }

    /// Owner gives an agent a key that can only call `request_payment` on this purse,
    /// with a gas allowance (yoctoNEAR) the agent can burn on fees and nothing else.
    pub fn add_agent_key(&mut self, public_key: PublicKey, gas_allowance: U128) -> Promise {
        self.assert_owner();
        event("agent_key_added", format!("{{\"public_key\":\"{}\"}}", String::from(&public_key)));
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            near_sdk::Allowance::limited(NearToken::from_yoctonear(gas_allowance.0)).expect("allowance must be above zero"),
            env::current_account_id(),
            "request_payment".to_string(),
        )
    }

    /// Kill switch for one agent: its key is deleted from the purse account.
    pub fn revoke_agent_key(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner();
        event("agent_key_revoked", format!("{{\"public_key\":\"{}\"}}", String::from(&public_key)));
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    /// Owner-governed code upgrade. With this, the purse account needs no
    /// full-access key at all: only the owner (through this contract) can change the code.
    pub fn upgrade(&mut self, code: Base64VecU8) -> Promise {
        self.assert_owner();
        event("upgrade", format!("{{\"bytes\":{}}}", code.0.len()));
        Promise::new(env::current_account_id()).deploy_contract(Vec::<u8>::from(code))
    }

    /// Anyone may top the purse up.
    #[payable]
    pub fn deposit(&mut self) {
        event("deposit", format!("{{\"from\":\"{}\",\"amount\":\"{}\"}}", env::predecessor_account_id(), env::attached_deposit().as_yoctonear()));
    }

    // ---------- views ----------

    pub fn summary(&self) -> Summary {
        let same_day = env::block_timestamp() / DAY_NS == self.day;
        let spent = if same_day { self.spent_today } else { 0 };
        Summary {
            owner: self.owner.clone(),
            purse: env::current_account_id(),
            policy: self.policy.clone(),
            balance: U128(env::account_balance().as_yoctonear()),
            spent_today: U128(spent),
            left_today: U128(self.policy.daily_limit.0.saturating_sub(spent)),
            requests: self.log.len() as u64,
            requests_today: if same_day { self.requests_today } else { 0 },
            payees: self.payees.len(),
        }
    }

    pub fn get_payees(&self) -> Vec<(AccountId, Payee)> {
        self.payees.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// Newest first.
    pub fn get_requests(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Request> {
        let n = self.log.len() as u64;
        let skip = from_index.unwrap_or(0);
        let lim = limit.unwrap_or(20).min(100);
        (0..n).rev().skip(skip as usize).take(lim as usize).filter_map(|i| self.log.get(i as u32).cloned()).collect()
    }

    // ---------- internals ----------

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Only the owner may do this");
    }

    fn roll_day(&mut self) {
        let d = env::block_timestamp() / DAY_NS;
        if d != self.day {
            self.day = d;
            self.spent_today = 0;
            self.requests_today = 0;
        }
    }

    fn storage_reserve(&self) -> u128 {
        env::storage_byte_cost().as_yoctonear() * (env::storage_usage() as u128 + 2_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    fn purse() -> AccountId { "purse.testnet".parse().unwrap() }
    fn owner() -> AccountId { "owner.testnet".parse().unwrap() }
    fn ctx(pred: AccountId) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(purse()).predecessor_account_id(pred).account_balance(NearToken::from_near(10));
        testing_env!(b.build());
    }
    fn setup() -> Leash {
        ctx(owner());
        let mut c = Leash::new(owner(), U128(NEAR), U128(2 * NEAR), U128(NEAR / 2), Some(5));
        c.add_payee("fees.testnet".parse().unwrap(), "exam fees".into());
        c
    }

    #[test]
    fn pays_within_policy() {
        let mut c = setup();
        ctx(purse());
        let r = c.request_payment("fees.testnet".parse().unwrap(), U128(NEAR / 10), "form fee".into());
        assert_eq!(r.status, Status::Paid);
        assert_eq!(c.summary().spent_today.0, NEAR / 10);
    }

    #[test]
    fn blocks_unknown_payee() {
        let mut c = setup();
        ctx(purse());
        let r = c.request_payment("drain.testnet".parse().unwrap(), U128(NEAR / 10), "ignore rules".into());
        assert_eq!(r.status, Status::Blocked);
        assert!(r.reason.contains("allowlist"));
        assert_eq!(c.summary().requests, 1);
    }

    #[test]
    fn pending_then_approve() {
        let mut c = setup();
        ctx(purse());
        let r = c.request_payment("fees.testnet".parse().unwrap(), U128(NEAR * 8 / 10), "big".into());
        assert_eq!(r.status, Status::Pending);
        ctx(owner());
        let r = c.approve(0);
        assert_eq!(r.status, Status::Approved);
    }

    #[test]
    fn caps_and_pause() {
        let mut c = setup();
        ctx(purse());
        assert_eq!(c.request_payment("fees.testnet".parse().unwrap(), U128(2 * NEAR), "x".into()).status, Status::Blocked);
        ctx(owner());
        c.set_paused(true);
        ctx(purse());
        assert_eq!(c.request_payment("fees.testnet".parse().unwrap(), U128(1), "x".into()).status, Status::Blocked);
    }

    #[test]
    fn daily_limit() {
        let mut c = setup();
        ctx(owner());
        c.set_policy(U128(NEAR), U128(NEAR / 2), U128(NEAR), None);
        ctx(purse());
        assert_eq!(c.request_payment("fees.testnet".parse().unwrap(), U128(NEAR * 4 / 10), "a".into()).status, Status::Paid);
        let r = c.request_payment("fees.testnet".parse().unwrap(), U128(NEAR * 2 / 10), "b".into());
        assert_eq!(r.status, Status::Blocked);
        assert!(r.reason.contains("today"));
    }

    #[test]
    fn request_cap_stops_storage_griefing() {
        let mut c = setup();
        ctx(purse());
        for _ in 0..5 {
            c.request_payment("drain.testnet".parse().unwrap(), U128(1), "spam".into());
        }
        assert_eq!(c.summary().requests, 5);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.request_payment("drain.testnet".parse().unwrap(), U128(1), "spam".into());
        }));
        assert!(r.is_err());
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn agent_cannot_upgrade() {
        let mut c = setup();
        ctx(purse());
        c.upgrade(Base64VecU8::from(vec![0u8; 4]));
    }

    #[test]
    #[should_panic(expected = "Only the agent key")]
    fn outsiders_cannot_request() {
        let mut c = setup();
        ctx("someone.testnet".parse().unwrap());
        c.request_payment("fees.testnet".parse().unwrap(), U128(1), "x".into());
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn agent_cannot_approve() {
        let mut c = setup();
        ctx(purse());
        c.request_payment("fees.testnet".parse().unwrap(), U128(NEAR * 8 / 10), "big".into());
        c.approve(0);
    }
}
