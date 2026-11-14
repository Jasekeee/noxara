//! $NOX (formerly $BOUNTY): NEP-141 + NEP-145 + NEP-148, held in the game contract so every mint, burn, entry,
//! prize and bounty settles atomically with the game rule that caused it.
//!
//! Storage (NEP-145): a player must be registered before `start_match`. Registration costs a fixed
//! `STORAGE_DEPOSIT` (min = max), which pays for the player's FT account, player record and one
//! pending match. Guests can't attach deposits (function-call keys), so the relayer prepays it with
//! `storage_deposit({account_id: <guest>})` right after creating the guest account. The contract
//! itself only pays for bounded data: the 9 slots, the last `RECENT_MATCHES` settled matches, the
//! leaderboard and one record per retired bot.
use crate::{Contract, ContractExt, PlayerV2, GUEST_STORAGE_DEPOSIT, STORAGE_DEPOSIT};
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::FtBurn;
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, log, near, require, AccountId, NearToken, Promise, PromiseOrValue};

/// A dark coin with a gold ring and an "N" (NOXARA).
const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%23e3b341'/%3E%3Ccircle cx='16' cy='16' r='12.5' fill='%231b1028'/%3E%3Cpath d='M11 22V10l10 12V10' fill='none' stroke='%23e3b341' stroke-width='2.6' stroke-linejoin='round'/%3E%3C/svg%3E";

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.refuse_game_wallet(&receiver_id);
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.refuse_game_wallet(&receiver_id);
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            log!("Account @{} burned {}", sender_id, burned);
            self.total_burned += burned;
            FtBurn { owner_id: &sender_id, amount: U128(burned), memo: Some("unregistered") }.emit();
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    /// Register a player (fixed deposit; any excess is refunded). Already registered: the whole
    /// deposit is refunded.
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = registration_only;
        let amount = env::attached_deposit();
        let payer = env::predecessor_account_id();
        let account = account_id.unwrap_or_else(|| payer.clone());
        if let Some(p) = self.load_player(&account) {
            if !amount.is_zero() {
                let _ = Promise::new(payer).transfer(amount);
            }
            return paid_balance(p.storage_paid.0);
        }
        let guest = self.is_guest(&account);
        // guests need less (measured: player + FT account + one pending match + XP, +20%)
        let need = if guest { GUEST_STORAGE_DEPOSIT } else { STORAGE_DEPOSIT };
        require!(amount >= need, "attach the storage deposit (see storage_balance_bounds)");
        // a deposit paid by someone else (the relayer) is refunded to THEM on unregister, never to the account
        let deposit_payer = (payer != account).then(|| payer.clone());
        self.save_player(&account, PlayerV2 { guest, storage_paid: U128(need.as_yoctonear()), deposit_payer, ..Default::default() });
        self.ensure_registered(&account);
        if !guest {
            // the login reward counts the account's age from its first registration (daily.rs)
            self.note_registration(&account);
        }
        // the one-time welcome credit: only when the account registers itself or via the trusted relayer
        // (a third party registering someone else grants nothing and never touches the daily cap)
        if !guest && (payer == account || payer == self.guest_parent) {
            self.grant_welcome(&account, payer == self.guest_parent);
        }
        let refund = amount.saturating_sub(need);
        if !refund.is_zero() {
            let _ = Promise::new(payer).transfer(refund);
        }
        paid_balance(need.as_yoctonear())
    }

    /// Nothing is ever withdrawable (min = max): use `storage_unregister` to leave.
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        require!(self.load_player(&id).is_some(), "not registered");
        require!(amount.is_none_or(|a| a.is_zero()), "nothing to withdraw");
        paid_balance(self.load_player(&id).map(|p| p.storage_paid.0).unwrap_or(0))
    }

    /// Leave: refunds the storage deposit to whoever paid it (the relayer for subsidised accounts). Needs no pending match; a non-zero $BOUNTY balance is
    /// burned only with `force: true`.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        let Some(p) = self.load_player(&id) else { return false };
        require!(p.pending.is_none(), "finish or abandon your match first");
        if self.is_season_ending() {
            // the season is ending: open sponsorships are closed at their current value
            self.close_all_sponsorships(&id);
        }
        require!(self.sponsoring.get(&id).is_none_or(|v| v.is_empty()), "withdraw your sponsorships first (from the season's end: wait until your bots are out of their match)");
        self.release_player_econ(&id, force.unwrap_or(false));
        let bal = self.balance(&id);
        require!(bal == 0 || force.unwrap_or(false), "non-zero $NOX balance: pass force=true to burn it");
        self.burn(&id, bal, "unregistered");
        self.players.remove(&id);
        self.token.accounts.remove(&id);
        self.xp.remove(&id);
        self.history.remove(&id);
        // the permanent "welcomed" record outlives the registration: its storage stays paid from the deposit
        let kept = if self.is_welcomed(&id) { crate::WELCOME_RECORD_NEAR.as_yoctonear() } else { 0 } + self.daily_row_near(&id);
        self.set_welcome_credit(&id, 0);
        let refund_to = p.deposit_payer.clone().unwrap_or(id);
        let _ = Promise::new(refund_to).transfer(NearToken::from_yoctonear(p.storage_paid.0.saturating_sub(kept)));
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        // what a self-registering account must pay; the smaller guest price is internal to the relayer
        // path (get_config.guest_storage_deposit)
        StorageBalanceBounds { min: STORAGE_DEPOSIT, max: Some(STORAGE_DEPOSIT) }
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        if let Some(p) = self.load_player(&account_id) {
            return Some(StorageBalance { total: NearToken::from_yoctonear(p.storage_paid.0), available: NearToken::from_yoctonear(0) });
        }
        // bots, the house and the escrow are registered at the contract's own expense
        self.token
            .accounts
            .contains_key(&account_id)
            .then(|| StorageBalance { total: NearToken::from_yoctonear(0), available: NearToken::from_yoctonear(0) })
    }
}

fn paid_balance(total: u128) -> StorageBalance {
    StorageBalance { total: NearToken::from_yoctonear(total), available: NearToken::from_yoctonear(0) }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Nox".to_string(),
            symbol: "NOX".to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }
}

impl Contract {
    /// The game's own wallets (this contract, the house, every bot and rookie: all sub-accounts of the
    /// contract) only receive $NOX through game rules. A plain transfer — and above all an
    /// ft_transfer_call, whose refund lands LATER — would let anyone inflate a bot's wallet or the
    /// house for one receipt (valuing sponsorships / passing the house floor) and take it back.
    pub(crate) fn refuse_game_wallet(&self, receiver: &AccountId) {
        let me = env::current_account_id();
        let sub = receiver.as_str().strip_suffix(me.as_str()).is_some_and(|p| p.ends_with('.'));
        require!(receiver != &me && !sub && receiver != &self.house && self.fighters.get(receiver).is_none(), "game wallets only receive $NOX through the game");
    }

    pub(crate) fn ensure_registered(&mut self, a: &AccountId) {
        if !self.token.accounts.contains_key(a) {
            self.token.internal_register_account(a);
        }
    }
}
