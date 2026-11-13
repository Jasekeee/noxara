//! $BOUNTY: NEP-141 + NEP-145 + NEP-148, held in the game contract so every mint, burn, entry,
//! prize and bounty settles atomically with the game rule that caused it.
//!
//! Storage (NEP-145): a player must be registered before `start_match`. Registration costs a fixed
//! `STORAGE_DEPOSIT` (min = max), which pays for the player's FT account, player record and one
//! pending match. Guests can't attach deposits (function-call keys), so the relayer prepays it with
//! `storage_deposit({account_id: <guest>})` right after creating the guest account. The contract
//! itself only pays for bounded data: the 9 slots, the last `RECENT_MATCHES` settled matches, the
//! leaderboard and one record per retired bot.
use crate::{Contract, ContractExt, PlayerV1, STORAGE_DEPOSIT};
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::FtBurn;
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, log, near, require, AccountId, NearToken, Promise, PromiseOrValue};

/// A gold coin with a crosshair.
const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%23b8751f'/%3E%3Ccircle cx='16' cy='16' r='12.5' fill='%23f2b53c'/%3E%3Ccircle cx='16' cy='16' r='7' fill='none' stroke='%23241a2e' stroke-width='2.5'/%3E%3Cpath d='M16 4v7M16 21v7M4 16h7M21 16h7' stroke='%23241a2e' stroke-width='2.5'/%3E%3C/svg%3E";

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
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
        if self.load_player(&account).is_some() {
            if !amount.is_zero() {
                let _ = Promise::new(payer).transfer(amount);
            }
            return paid_balance();
        }
        require!(amount >= STORAGE_DEPOSIT, format!("attach at least {} yoctoNEAR", STORAGE_DEPOSIT.as_yoctonear()));
        let guest = self.is_guest(&account);
        self.save_player(&account, PlayerV1 { guest, storage_paid: U128(STORAGE_DEPOSIT.as_yoctonear()), ..Default::default() });
        self.ensure_registered(&account);
        let refund = amount.saturating_sub(STORAGE_DEPOSIT);
        if !refund.is_zero() {
            let _ = Promise::new(payer).transfer(refund);
        }
        paid_balance()
    }

    /// Nothing is ever withdrawable (min = max): use `storage_unregister` to leave.
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        require!(self.load_player(&id).is_some(), "not registered");
        require!(amount.is_none_or(|a| a.is_zero()), "nothing to withdraw");
        paid_balance()
    }

    /// Leave: refunds the storage deposit. Needs no pending match; a non-zero $BOUNTY balance is
    /// burned only with `force: true`.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        let Some(p) = self.load_player(&id) else { return false };
        require!(p.pending.is_none(), "finish or abandon your match first");
        require!(self.sponsoring.get(&id).is_none_or(|v| v.is_empty()), "withdraw your sponsorships first");
        let bal = self.balance(&id);
        require!(bal == 0 || force.unwrap_or(false), "non-zero $BOUNTY balance: pass force=true to burn it");
        self.burn(&id, bal, "unregistered");
        self.players.remove(&id);
        self.token.accounts.remove(&id);
        self.xp.remove(&id);
        self.history.remove(&id);
        let _ = Promise::new(id).transfer(NearToken::from_yoctonear(p.storage_paid.0));
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
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

fn paid_balance() -> StorageBalance {
    StorageBalance { total: STORAGE_DEPOSIT, available: NearToken::from_yoctonear(0) }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Bounty".to_string(),
            symbol: "BOUNTY".to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }
}

impl Contract {
    pub(crate) fn ensure_registered(&mut self, a: &AccountId) {
        if !self.token.accounts.contains_key(a) {
            self.token.internal_register_account(a);
        }
    }
}
