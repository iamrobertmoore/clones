//! The market town.
//!
//! A player sends up to three clones (`clone-1.<player>`, `clone-2.<player>`, `clone-3.<player>`)
//! into town. Each clone signs with a function-call key that can only call `trade` on this
//! contract, and a function-call key can never attach a deposit or send NEAR. So a clone's cash
//! lives here, in this ledger: the player funds it with `register_clone`, the clone trades it with
//! `trade`, and only the player can `settle` it, which sells what it holds and pays the cash out
//! to the clone account just before the merge.
//!
//! Every number lives here. The clones choose orders; this contract decides what they get, using
//! the rules in `clones-core`: the merchant's stock, the price it quotes, every fill and fee.
//! Amounts inside the town are in milliNEAR.
//!
//! A night: the keeper opens it (`open_night`), then rings twelve hours (`advance_round`). In each
//! hour every clone may make one `trade` call, cleared at the merchant's quote for that hour.
//! After the twelfth hour it is dawn: no trading until the next night, and players settle the
//! clones that are due home.

use clones_core as rules;
use near_sdk::json_types::U64;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

/// Clone names a player may use. Three clones, no more.
pub const CLONE_NAMES: [&str; 3] = ["clone-1", "clone-2", "clone-3"];

/// Most clones the town holds at once, to bound storage and the keeper's work.
pub const MAX_CLONES_IN_TOWN: u32 = 60;

/// Settlements remembered per player.
pub const RESULTS_KEPT: usize = 9;

/// Settlements remembered for the whole town (the morning board).
pub const RECENT_KEPT: u32 = 40;

/// Smallest and largest stake a clone can be sent in with, in milliNEAR.
pub const MIN_STAKE_MILLI: u64 = 100;
pub const MAX_STAKE_MILLI: u64 = 2_000;

/// Most orders in one clone's turn.
pub const MAX_ORDERS_PER_TURN: usize = 6;

const YOCTO_PER_MILLI: u128 = 1_000_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Temperament {
    Cautious,
    Greedy,
    Loyal,
}

impl From<Temperament> for rules::Temperament {
    fn from(t: Temperament) -> Self {
        match t {
            Temperament::Cautious => rules::Temperament::Cautious,
            Temperament::Greedy => rules::Temperament::Greedy,
            Temperament::Loyal => rules::Temperament::Loyal,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

impl From<Side> for rules::Side {
    fn from(s: Side) -> Self {
        match s {
            Side::Buy => rules::Side::Buy,
            Side::Sell => rules::Side::Sell,
        }
    }
}

/// One order in a clone's turn. `price` is the clone's limit per unit, in milliNEAR.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderIn {
    pub good: String,
    pub side: Side,
    pub qty: u32,
    pub price: u64,
}

/// One order a player shouts to a clone for the next hour, once a night. The runner obeys it
/// instead of the clone's temperament for that hour.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Whisper {
    Hold,
    SellAll,
    Buy { good: String },
}

/// The mood of a night's market (see `clones_core::Regime`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mood {
    Blight,
    Boom,
    Slump,
    Wild,
}

impl From<rules::Regime> for Mood {
    fn from(r: rules::Regime) -> Self {
        match r {
            rules::Regime::Blight => Mood::Blight,
            rules::Regime::Boom => Mood::Boom,
            rules::Regime::Slump => Mood::Slump,
            rules::Regime::Wild => Mood::Wild,
        }
    }
}

impl From<Mood> for rules::Regime {
    fn from(m: Mood) -> Self {
        match m {
            Mood::Blight => rules::Regime::Blight,
            Mood::Boom => rules::Regime::Boom,
            Mood::Slump => rules::Regime::Slump,
            Mood::Wild => rules::Regime::Wild,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloneRecord {
    pub player: AccountId,
    pub temperament: Temperament,
    pub stake: u64,
    pub cash: u64,
    pub stock: [u32; 5],
    pub orders_placed: u32,
    /// Nights the player sent it out for, and nights it has played.
    pub nights: u32,
    pub nights_played: u32,
    /// The first night it plays (it never joins a night already under way).
    pub from_night: u32,
    /// The (night, hour) of its last turn: one turn per hour.
    pub last_turn: Option<(u32, u32)>,
    /// What it held and how many orders it had placed when the current night opened, so anyone
    /// can recompute the night's answer key from chain state alone.
    pub dusk_cash: u64,
    pub dusk_stock: [u32; 5],
    pub dusk_orders: u32,
    /// A whisper for (night, hour), and the last night it was whispered to.
    pub whisper: Option<(u32, u32, Whisper)>,
    pub whispered_night: u32,
}

impl CloneRecord {
    fn ledger(&self) -> rules::Ledger {
        rules::Ledger {
            cash: self.cash,
            stock: self.stock,
        }
    }
}

/// A clone as the outside world sees it. Amounts in milliNEAR.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloneView {
    pub player: AccountId,
    pub temperament: Temperament,
    pub stake: u64,
    pub cash: u64,
    pub stock: [u32; 5],
    pub orders_placed: u32,
    /// What it would be paid if it sold everything to the merchant now.
    pub worth: u64,
    pub broke: bool,
    pub nights: u32,
    pub nights_played: u32,
    pub from_night: u32,
    /// At dawn: whether it comes home now (its last night is over, or it is broke).
    pub due_home: bool,
    /// The (night, hour) of its last turn.
    pub last_turn: Option<(u32, u32)>,
    /// What it held, and its order count, when the current night opened.
    pub dusk_cash: u64,
    pub dusk_stock: [u32; 5],
    pub dusk_orders: u32,
    /// The whisper waiting for it as (night, hour, order), if any, and whether its player has
    /// whispered to it tonight.
    pub whisper: Option<(u32, u32, Whisper)>,
    pub whispered_tonight: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: u32,
    pub night: u32,
    pub round: u32,
    pub clone: AccountId,
    pub good: String,
    pub side: Side,
    pub qty: u32,
    pub price: u64,
    pub fee: u64,
}

/// What a clone brought home, remembered on chain.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub player: AccountId,
    pub clone: AccountId,
    pub temperament: Temperament,
    pub night: u32,
    pub seed: U64,
    pub stake: u64,
    pub paid_out: u64,
    pub broke: bool,
    pub orders_placed: u32,
    pub nights_played: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TownView {
    pub keeper: AccountId,
    pub night: u32,
    pub seed: U64,
    pub round: u32,
    pub rounds: u32,
    /// True between nights (dawn and day): no trading, clones can be settled.
    pub asleep: bool,
    pub goods: Vec<String>,
    /// The board: one unit's price at the merchant this hour.
    pub prices: [u64; 5],
    /// Last hour's board (at dusk, the same as this hour's).
    pub prev_prices: [u64; 5],
    /// The merchant's stock now, the stock the hour's prices were set from, and its normal stock.
    pub stock: [i64; 5],
    pub hour_stock: [i64; 5],
    pub normal_stock: [i64; 5],
    /// The merchant's stock when the current night opened.
    pub dusk_stock: [i64; 5],
    /// Tonight's mood and tomorrow's (posted a night ahead).
    pub mood: Mood,
    pub omen: Mood,
    /// True when each hour's prices are drawn from the chain's block randomness as the hour is
    /// rung, so nobody can know them in advance (the hosted town). False: prices follow the seed.
    pub chain_dice: bool,
    /// The usual price of each good at every hour rung so far tonight.
    pub hours: Vec<[u64; 5]>,
    /// The index of tonight's first order in `get_orders`.
    pub dusk_order: u32,
    /// Fees taken tonight so far: the crown's pot.
    pub night_fees: u64,
    /// The last crown: (clone, pot in milliNEAR, night).
    pub crowned: Option<(AccountId, u64, u32)>,
    pub fees_collected: u64,
    pub clones_in_town: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    keeper: AccountId,
    seed: u64,
    round: u32,
    fees: u64,
    night: u32,
    /// The merchant's stock now, and when the current hour began (the hour's prices).
    stock: rules::Stock,
    hour_stock: rules::Stock,
    dusk_stock: rules::Stock,
    prev_prices: [u64; 5],
    usual: [u64; 5],
    hours: Vec<[u64; 5]>,
    mood: Mood,
    omen: Mood,
    chain_dice: bool,
    dusk_order: u32,
    night_fees: u64,
    crowned: Option<(AccountId, u64, u32)>,
    clones: IterableMap<AccountId, CloneRecord>,
    orders: Vector<Order>,
    results: LookupMap<AccountId, Vec<Settlement>>,
    recent: Vector<Settlement>,
    recent_count: u32,
    /// When set, only players under this account (`<guest>.<house>`) may send clones in.
    guests_under: Option<AccountId>,
}

/// A random u64 from the chain's block randomness, mixed with `salt`.
fn random_u64(salt: u64) -> u64 {
    let b = env::random_seed();
    let mut x = 0u64;
    for (i, byte) in b.iter().take(8).enumerate() {
        x |= (*byte as u64) << (8 * i);
    }
    rules::mix(x ^ salt)
}

/// If `clone` is `clone-N.<player>` with N in 1..=3, return the player.
pub fn player_of(clone: &str) -> Option<&str> {
    let (name, parent) = clone.split_once('.')?;
    if CLONE_NAMES.contains(&name) && !parent.is_empty() {
        Some(parent)
    } else {
        None
    }
}

#[near]
impl Market {
    /// The caller becomes the town keeper, who opens nights and rings the hours. The town starts
    /// asleep with the merchant at normal stock. With `guests_under`, only that account's
    /// sub-accounts may play (the hosted town: the house runs every guest's clones, so nobody can
    /// trade on foresight of the seeded prices).
    #[init]
    pub fn new(seed: U64, guests_under: Option<AccountId>, chain_dice: Option<bool>) -> Self {
        let chain_dice = chain_dice.unwrap_or(false);
        let omen = if chain_dice {
            rules::regime_of(random_u64(0))
        } else {
            rules::regime_of(seed.0)
        };
        Self {
            keeper: env::predecessor_account_id(),
            seed: seed.0,
            round: rules::ROUNDS,
            fees: 0,
            night: 0,
            stock: rules::NORMAL_STOCK,
            hour_stock: rules::NORMAL_STOCK,
            dusk_stock: rules::NORMAL_STOCK,
            prev_prices: rules::BASE_PRICE,
            usual: rules::BASE_PRICE,
            hours: vec![rules::BASE_PRICE],
            mood: omen.into(),
            omen: omen.into(),
            chain_dice,
            dusk_order: 0,
            night_fees: 0,
            crowned: None,
            clones: IterableMap::new(b"c"),
            orders: Vector::new(b"o"),
            results: LookupMap::new(b"r"),
            recent: Vector::new(b"t"),
            recent_count: 0,
            guests_under,
        }
    }

    fn only_keeper(&self) {
        require!(
            env::predecessor_account_id() == self.keeper,
            "only the town keeper can do that"
        );
    }

    fn book(&self) -> rules::Book {
        rules::Book {
            usual: self.usual,
            stock: self.hour_stock,
        }
    }

    fn asleep(&self) -> bool {
        self.round >= rules::ROUNDS
    }

    /// Open night number `night` (the next one) with a new seed. The merchant restocks halfway
    /// back to normal overnight. Refused while a night is under way, so two keepers can never
    /// both open one.
    pub fn open_night(&mut self, seed: U64, night: u32) {
        self.only_keeper();
        require!(self.asleep(), "a night is already under way");
        require!(night == self.night + 1, "that is not the next night");
        self.night = night;
        self.seed = seed.0;
        self.round = 0;
        if self.chain_dice {
            // Tonight's mood is usually the omen posted last night; omens lie three nights in ten.
            // The chain draws whether it lies, and tomorrow's omen.
            let roll = random_u64(night as u64 ^ 0x6C6965);
            self.mood = if roll % 10 < rules::OMEN_TRUE_IN_TEN {
                self.omen
            } else {
                let o: rules::Regime = self.omen.into();
                let others: Vec<rules::Regime> =
                    rules::REGIMES.iter().copied().filter(|r| *r != o).collect();
                others[((roll / 10) % 3) as usize].into()
            };
            self.omen = rules::regime_of(random_u64(night as u64)).into();
        } else {
            self.mood = rules::regime_of(seed.0).into();
            self.omen = self.mood;
        }
        self.usual = rules::BASE_PRICE;
        self.hours = vec![self.usual];
        self.dusk_order = self.orders.len();
        self.night_fees = 0;
        self.stock = rules::restock(&self.stock);
        self.hour_stock = self.stock;
        self.dusk_stock = self.stock;
        self.prev_prices = self.book().board();
        for (_, rec) in self.clones.iter_mut() {
            rec.dusk_cash = rec.cash;
            rec.dusk_stock = rec.stock;
            rec.dusk_orders = rec.orders_placed;
        }
    }

    /// Close hour `round` and ring the next. The merchant's stock now sets the new hour's prices.
    /// After the last hour it is dawn and every clone that played has one more night behind it.
    pub fn advance_round(&mut self, round: u32) -> u32 {
        self.only_keeper();
        require!(!self.asleep(), "the town is asleep");
        require!(round == self.round, "that hour has already been rung");
        self.prev_prices = self.book().board();
        self.round += 1;
        let regime: rules::Regime = self.mood.into();
        for g in 0..5 {
            let h = if self.chain_dice {
                random_u64(((self.round as u64) << 8) ^ g as u64)
            } else {
                rules::seeded_draw(self.seed, self.round, g)
            };
            self.usual[g] = rules::step_with(h, regime, self.round, g, self.usual[g]);
        }
        self.hours.push(self.usual);
        self.hour_stock = self.stock;
        if self.asleep() {
            let night = self.night;
            for (_, rec) in self.clones.iter_mut() {
                if rec.from_night <= night {
                    rec.nights_played += 1;
                }
            }
            self.crown();
        }
        self.round
    }

    /// At dawn the night's fees go to the clone with the best return on its stake.
    fn crown(&mut self) {
        if self.night_fees == 0 {
            return;
        }
        let book = self.book();
        let night = self.night;
        let entries: Vec<(String, u64, u64)> = self
            .clones
            .iter()
            .filter(|(_, r)| r.from_night <= night)
            .map(|(id, r)| (id.to_string(), r.ledger().worth(&book), r.stake))
            .collect();
        let refs: Vec<(&str, u64, u64)> = entries
            .iter()
            .map(|(n, w, s)| (n.as_str(), *w, *s))
            .collect();
        if let Some(w) = rules::crown_winner(&refs) {
            let id: AccountId = entries[w].0.parse().unwrap();
            let pot = self.night_fees;
            if let Some(rec) = self.clones.get_mut(&id) {
                rec.cash += pot;
            }
            env::log_str(&format!("crowned {id}: {pot} mNEAR"));
            self.crowned = Some((id, pot, night));
            self.night_fees = 0;
        }
    }

    /// Called by the player with the clone's stake attached. The clone account must be a direct
    /// sub-account of the caller named `clone-1`, `clone-2` or `clone-3`. It plays from the next
    /// night, for `nights` nights (1 to 3, default 1), unless it goes broke first.
    #[payable]
    pub fn register_clone(
        &mut self,
        clone_id: AccountId,
        temperament: Temperament,
        nights: Option<u32>,
    ) {
        let player = env::predecessor_account_id();
        require!(
            player_of(clone_id.as_str()) == Some(player.as_str()),
            "a clone must be clone-1, clone-2 or clone-3 under the caller's own account"
        );
        if let Some(house) = &self.guests_under {
            require!(
                player.as_str().ends_with(&format!(".{house}")),
                "this town only takes guests of its house"
            );
        }
        require!(
            !self.clones.contains_key(&clone_id),
            "that clone is already in town"
        );
        require!(
            self.clones.len() < MAX_CLONES_IN_TOWN,
            "the town is full tonight"
        );
        let nights = nights.unwrap_or(1);
        require!(
            (1..=rules::MAX_NIGHTS).contains(&nights),
            "send a clone out for 1 to 3 nights"
        );
        let stake = (env::attached_deposit().as_yoctonear() / YOCTO_PER_MILLI) as u64;
        require!(
            stake >= MIN_STAKE_MILLI,
            "send a clone in with at least 0.1 NEAR"
        );
        require!(
            stake <= MAX_STAKE_MILLI,
            "send a clone in with at most 2 NEAR"
        );
        self.clones.insert(
            clone_id,
            CloneRecord {
                player,
                temperament,
                stake,
                cash: stake,
                stock: [0; 5],
                orders_placed: 0,
                nights,
                nights_played: 0,
                from_night: self.night + 1,
                last_turn: None,
                dusk_cash: stake,
                dusk_stock: [0; 5],
                dusk_orders: 0,
                whisper: None,
                whispered_night: 0,
            },
        );
    }

    /// A clone's turn for hour `round`, signed with its function-call key. Every order is quoted
    /// from the merchant's stock when the hour began; the turn clears whole or not at all. One
    /// turn per clone per hour. Returns the order ids.
    pub fn trade(&mut self, round: u32, orders: Vec<OrderIn>) -> Vec<u32> {
        require!(!self.asleep(), "the town is asleep; trading starts at dusk");
        require!(round == self.round, "that hour is over");
        require!(
            !orders.is_empty() && orders.len() <= MAX_ORDERS_PER_TURN,
            "a turn is 1 to 6 orders"
        );
        let book = self.book();
        let (night, hour) = (self.night, self.round);
        let clone = env::predecessor_account_id();
        let rec = self
            .clones
            .get_mut(&clone)
            .unwrap_or_else(|| env::panic_str("only a clone in town can trade"));
        require!(
            rec.from_night <= night,
            "this clone starts trading next night"
        );
        require!(
            rec.last_turn != Some((night, hour)),
            "this clone has already traded this hour"
        );
        let intents: Vec<rules::Intent> = orders
            .iter()
            .map(|o| rules::Intent {
                good: rules::good_index(&o.good).unwrap_or_else(|| env::panic_str("unknown good")),
                side: o.side.into(),
                qty: o.qty,
                limit: o.price,
            })
            .collect();
        let mut ledger = rec.ledger();
        let fills = rules::apply_turn(&mut ledger, &mut self.stock, &book, &intents)
            .unwrap_or_else(|e| env::panic_str(e));
        rec.cash = ledger.cash;
        rec.stock = ledger.stock;
        rec.orders_placed += fills.len() as u32;
        rec.last_turn = Some((night, hour));
        let mut ids = Vec::new();
        for (o, f) in orders.into_iter().zip(fills) {
            self.fees += f.fee;
            self.night_fees += f.fee;
            let id = self.orders.len();
            self.orders.push(Order {
                id,
                night,
                round: hour,
                clone: clone.clone(),
                good: o.good,
                side: o.side,
                qty: o.qty,
                price: f.price,
                fee: f.fee,
            });
            ids.push(id);
        }
        ids
    }

    /// Called by the player during a night: one order for the clone's next hour, once a night.
    /// The night runner obeys it instead of the clone's temperament for that hour.
    pub fn whisper(&mut self, clone_id: AccountId, whisper: Whisper) {
        require!(!self.asleep(), "whisper while the night is on");
        let (night, next) = (self.night, self.round + 1);
        require!(
            next < rules::ROUNDS,
            "too late tonight: the last hour has begun"
        );
        if let Whisper::Buy { good } = &whisper {
            require!(rules::good_index(good).is_some(), "unknown good");
        }
        let rec = self
            .clones
            .get_mut(&clone_id)
            .unwrap_or_else(|| env::panic_str("no such clone in town"));
        require!(
            rec.player == env::predecessor_account_id(),
            "only the player who sent this clone can whisper to it"
        );
        require!(
            rec.from_night <= night,
            "this clone starts trading next night"
        );
        require!(
            rec.whispered_night != night,
            "you have already whispered to this clone tonight"
        );
        rec.whisper = Some((night, next, whisper));
        rec.whispered_night = night;
    }

    /// Called by the player between nights: change a clone's temperament for the nights it has
    /// left.
    pub fn retrain(&mut self, clone_id: AccountId, temperament: Temperament) {
        require!(self.asleep(), "retrain between nights, not during one");
        let rec = self
            .clones
            .get_mut(&clone_id)
            .unwrap_or_else(|| env::panic_str("no such clone in town"));
        require!(
            rec.player == env::predecessor_account_id(),
            "only the player who sent this clone can retrain it"
        );
        rec.temperament = temperament;
    }

    /// Called by the player between nights. Sells everything the clone holds to the merchant,
    /// pays the cash out to the clone account and takes the clone out of town. The player then
    /// merges the clone (see the leash contract).
    pub fn settle(&mut self, clone_id: AccountId) -> Promise {
        require!(
            self.asleep(),
            "clones come home at dawn, not during the night"
        );
        let rec = self
            .clones
            .get(&clone_id)
            .unwrap_or_else(|| env::panic_str("no such clone in town"))
            .clone();
        require!(
            rec.player == env::predecessor_account_id(),
            "only the player who sent this clone can settle it"
        );
        let book = self.book();
        let mut ledger = rec.ledger();
        self.fees += rules::liquidate(&mut ledger, &book);
        for (g, q) in rec.stock.iter().enumerate() {
            rules::move_stock(&mut self.stock, g, rules::Side::Sell, *q);
        }
        let broke = rules::is_broke(ledger.cash, rec.stake);
        env::log_str(&format!(
            "settled {clone_id}: staked {} mNEAR, paid out {} mNEAR{}",
            rec.stake,
            ledger.cash,
            if broke { ", broke" } else { "" }
        ));
        self.clones.remove(&clone_id);
        let settlement = Settlement {
            player: rec.player.clone(),
            clone: clone_id.clone(),
            temperament: rec.temperament,
            night: self.night,
            seed: U64(self.seed),
            stake: rec.stake,
            paid_out: ledger.cash,
            broke,
            orders_placed: rec.orders_placed,
            nights_played: rec.nights_played,
        };
        let mut kept = self.results.get(&rec.player).cloned().unwrap_or_default();
        kept.push(settlement.clone());
        if kept.len() > RESULTS_KEPT {
            kept.remove(0);
        }
        self.results.insert(rec.player.clone(), kept);
        if self.recent.len() < RECENT_KEPT {
            self.recent.push(settlement);
        } else {
            self.recent
                .replace(self.recent_count % RECENT_KEPT, settlement);
        }
        self.recent_count += 1;
        let amount = NearToken::from_yoctonear(ledger.cash as u128 * YOCTO_PER_MILLI);
        Promise::new(clone_id.clone()).transfer(amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(40))
                .after_payout(rec.player, clone_id, amount),
        )
    }

    /// After the payout: ask the clone to merge home (its leash allows this market if the player
    /// bound it, and always pays the player). If the clone account was already gone, the payout
    /// bounced back here: send it to the player instead, so nothing is stranded in the market.
    #[private]
    pub fn after_payout(
        &mut self,
        player: AccountId,
        clone: AccountId,
        amount: NearToken,
    ) -> Option<Promise> {
        match env::promise_result_checked(0, 0) {
            Ok(_) => {
                // Scheduled on its own: a clone that was never bound to this market refuses, and
                // that leaves the settlement itself untouched.
                let _ = Promise::new(clone).function_call(
                    "merge",
                    Vec::new(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(20),
                );
                None
            }
            Err(_) => {
                env::log_str(&format!(
                    "clone account was gone; paid {amount} to {player}"
                ));
                Some(Promise::new(player).transfer(amount))
            }
        }
    }

    pub fn get_clone(&self, clone_id: AccountId) -> Option<CloneView> {
        self.clones.get(&clone_id).map(|r| self.view_of(r))
    }

    /// Every clone in town, in a stable order.
    pub fn list_clones(&self, from: u32, limit: u32) -> Vec<(AccountId, CloneView)> {
        self.clones
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .map(|(id, r)| (id.clone(), self.view_of(r)))
            .collect()
    }

    /// What this player's clones brought home, most recent last.
    pub fn get_results(&self, player: AccountId) -> Vec<Settlement> {
        self.results.get(&player).cloned().unwrap_or_default()
    }

    /// The last settlements in the whole town (up to 40), oldest first: the morning board.
    pub fn get_recent(&self) -> Vec<Settlement> {
        let n = self.recent.len();
        let start = if self.recent_count > n {
            self.recent_count % n
        } else {
            0
        };
        (0..n)
            .map(|i| self.recent[(start + i) % n].clone())
            .collect()
    }

    fn view_of(&self, r: &CloneRecord) -> CloneView {
        let worth = r.ledger().worth(&self.book());
        let broke = rules::is_broke(worth, r.stake);
        CloneView {
            player: r.player.clone(),
            temperament: r.temperament,
            stake: r.stake,
            cash: r.cash,
            stock: r.stock,
            orders_placed: r.orders_placed,
            worth,
            broke,
            nights: r.nights,
            nights_played: r.nights_played,
            from_night: r.from_night,
            due_home: self.asleep()
                && r.from_night <= self.night
                && (broke || r.nights_played >= r.nights),
            last_turn: r.last_turn,
            dusk_cash: r.dusk_cash,
            dusk_stock: r.dusk_stock,
            dusk_orders: r.dusk_orders,
            whisper: r.whisper.clone(),
            whispered_tonight: r.whispered_night == self.night && self.night > 0,
        }
    }

    pub fn get_town(&self) -> TownView {
        TownView {
            keeper: self.keeper.clone(),
            night: self.night,
            seed: U64(self.seed),
            round: self.round,
            rounds: rules::ROUNDS,
            asleep: self.asleep(),
            goods: rules::GOODS.iter().map(|g| g.to_string()).collect(),
            prices: self.book().board(),
            prev_prices: self.prev_prices,
            stock: self.stock,
            hour_stock: self.hour_stock,
            normal_stock: rules::NORMAL_STOCK,
            dusk_stock: self.dusk_stock,
            mood: self.mood,
            omen: self.omen,
            chain_dice: self.chain_dice,
            hours: self.hours.clone(),
            dusk_order: self.dusk_order,
            night_fees: self.night_fees,
            crowned: self.crowned.clone(),
            fees_collected: self.fees,
            clones_in_town: self.clones.len(),
        }
    }

    /// The town and every clone in it, read in one call (so from one block): what a night runner
    /// needs to play an hour.
    pub fn get_state(&self) -> (TownView, Vec<(AccountId, CloneView)>) {
        (self.get_town(), self.list_clones(0, MAX_CLONES_IN_TOWN))
    }

    pub fn get_orders(&self, from: u32, limit: u32) -> Vec<Order> {
        self.orders
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const SEED: u64 = 853;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn as_caller(who: &str, deposit: NearToken) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(acc(who))
            .attached_deposit(deposit)
            .build();
        testing_env!(ctx);
    }

    fn zero() -> NearToken {
        NearToken::from_yoctonear(0)
    }

    fn open(m: &mut Market) {
        as_caller("keeper.testnet", zero());
        let n = m.get_town().night + 1;
        m.open_night(U64(SEED), n);
    }

    fn ring_to_dawn(m: &mut Market) {
        as_caller("keeper.testnet", zero());
        while !m.get_town().asleep {
            let r = m.get_town().round;
            m.advance_round(r);
        }
    }

    /// A town with alice's greedy clone in it and the first night open.
    fn town_with_clone() -> Market {
        as_caller("keeper.testnet", zero());
        let mut m = Market::new(U64(SEED), None, None);
        as_caller("alice.testnet", NearToken::from_near(2));
        m.register_clone(acc("clone-1.alice.testnet"), Temperament::Greedy, None);
        open(&mut m);
        m
    }

    fn order(good: &str, side: Side, qty: u32, price: u64) -> OrderIn {
        OrderIn {
            good: good.into(),
            side,
            qty,
            price,
        }
    }

    fn as_clone() {
        as_caller("clone-1.alice.testnet", zero());
    }

    #[test]
    fn a_new_town_is_asleep_at_normal_stock() {
        as_caller("keeper.testnet", zero());
        let m = Market::new(U64(SEED), None, None);
        let t = m.get_town();
        assert!(t.asleep);
        assert_eq!((t.night, t.stock), (0, rules::NORMAL_STOCK));
    }

    #[test]
    #[should_panic(expected = "only takes guests of its house")]
    fn a_hosted_town_refuses_outsiders() {
        as_caller("keeper.testnet", zero());
        let mut m = Market::new(U64(SEED), Some(acc("house.testnet")), None);
        as_caller("mallory.testnet", NearToken::from_near(1));
        m.register_clone(acc("clone-1.mallory.testnet"), Temperament::Greedy, None);
    }

    #[test]
    fn a_hosted_town_takes_its_guests() {
        as_caller("keeper.testnet", zero());
        let mut m = Market::new(U64(SEED), Some(acc("house.testnet")), None);
        as_caller("g1.house.testnet", NearToken::from_near(1));
        m.register_clone(acc("clone-1.g1.house.testnet"), Temperament::Greedy, None);
        assert_eq!(m.get_town().clones_in_town, 1);
    }

    #[test]
    fn lists_the_clones_in_town() {
        let mut m = town_with_clone();
        as_caller("bob.testnet", NearToken::from_near(1));
        m.register_clone(acc("clone-2.bob.testnet"), Temperament::Loyal, Some(2));
        let all = m.list_clones(0, 10);
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].0, acc("clone-2.bob.testnet"));
        assert_eq!((all[1].1.nights, all[1].1.from_night), (2, 2));
    }

    #[test]
    #[should_panic(expected = "a night is already under way")]
    fn only_one_night_at_a_time() {
        let mut m = town_with_clone();
        as_caller("keeper.testnet", zero());
        m.open_night(U64(9), 2);
    }

    #[test]
    #[should_panic(expected = "not the next night")]
    fn nights_open_in_order() {
        as_caller("keeper.testnet", zero());
        let mut m = Market::new(U64(SEED), None, None);
        m.open_night(U64(9), 2);
    }

    #[test]
    #[should_panic(expected = "already been rung")]
    fn an_hour_is_rung_once() {
        let mut m = town_with_clone();
        as_caller("keeper.testnet", zero());
        m.advance_round(0);
        m.advance_round(0);
    }

    #[test]
    fn a_new_night_restocks_and_counts_up() {
        let mut m = town_with_clone();
        as_clone();
        let q = 12;
        let p = m.get_town().prices[4];
        let quote = rules::Book::at(SEED, 0, rules::NORMAL_STOCK).quote(4, rules::Side::Buy, q);
        assert!(quote >= p);
        m.trade(0, vec![order("amber", Side::Buy, q, quote)]);
        ring_to_dawn(&mut m);
        assert_eq!(m.get_town().stock[4], rules::NORMAL_STOCK[4] - 12);
        as_caller("keeper.testnet", zero());
        m.open_night(U64(9), 2);
        let t = m.get_town();
        assert_eq!((t.round, t.night, t.seed.0), (0, 2, 9));
        assert_eq!(t.stock[4], rules::NORMAL_STOCK[4] - 6, "restocked halfway");
    }

    #[test]
    fn the_chain_keeps_what_the_answer_key_needs() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 3, 30)]);
        let p0 = m.get_town().prices;
        as_caller("keeper.testnet", zero());
        m.advance_round(0);
        let t = m.get_town();
        assert_eq!(t.prev_prices, p0);
        assert_eq!(t.dusk_stock, rules::NORMAL_STOCK);
        let c = m.get_clone(acc("clone-1.alice.testnet")).unwrap();
        assert_eq!(
            (c.dusk_cash, c.dusk_orders, c.last_turn),
            (2000, 0, Some((1, 0)))
        );
        ring_to_dawn(&mut m);
        as_caller("keeper.testnet", zero());
        m.open_night(U64(9), 2);
        let c = m.get_clone(acc("clone-1.alice.testnet")).unwrap();
        assert_eq!(
            (c.dusk_cash, c.dusk_stock, c.dusk_orders),
            (2000 - 92 + 2, [0, 3, 0, 0, 0], 1),
            "cash includes last night's crown"
        );
    }

    #[test]
    fn seeded_prices_follow_the_rules_hour_by_hour() {
        let mut m = town_with_clone();
        as_caller("keeper.testnet", zero());
        for r in 0..rules::ROUNDS {
            assert_eq!(m.get_town().hours[r as usize], rules::prices_at(SEED, r));
            m.advance_round(r);
        }
        assert_eq!(m.get_town().hours.len() as u32, rules::ROUNDS + 1);
        assert_eq!(m.get_town().mood, Mood::from(rules::regime_of(SEED)));
    }

    #[test]
    fn a_hosted_town_draws_prices_and_tomorrows_omen_from_the_chain() {
        as_caller("keeper.testnet", zero());
        let mut m = Market::new(U64(SEED), None, Some(true));
        let posted = m.get_town().omen;
        as_caller("keeper.testnet", zero());
        m.open_night(U64(1), 1);
        assert_eq!(
            m.get_town().mood,
            posted,
            "tonight's mood is the omen posted yesterday"
        );
        assert!(m.get_town().chain_dice);
        m.advance_round(0);
        let h = m.get_town().hours;
        assert_eq!(h.len(), 2);
        assert!(h[1].iter().all(|p| *p >= 1));
    }

    #[test]
    fn a_whisper_is_for_the_next_hour_once_a_night() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        m.whisper(acc("clone-1.alice.testnet"), Whisper::SellAll);
        let c = m.get_clone(acc("clone-1.alice.testnet")).unwrap();
        assert_eq!(c.whisper, Some((1, 1, Whisper::SellAll)));
        assert!(c.whispered_tonight);
    }

    #[test]
    #[should_panic(expected = "already whispered to this clone tonight")]
    fn only_one_whisper_a_night() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        m.whisper(acc("clone-1.alice.testnet"), Whisper::Hold);
        m.whisper(acc("clone-1.alice.testnet"), Whisper::SellAll);
    }

    #[test]
    #[should_panic(expected = "only the player who sent this clone can whisper")]
    fn strangers_cannot_whisper() {
        let mut m = town_with_clone();
        as_caller("mallory.testnet", zero());
        m.whisper(acc("clone-1.alice.testnet"), Whisper::Hold);
    }

    #[test]
    #[should_panic(expected = "unknown good")]
    fn a_whisper_names_a_real_good() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        m.whisper(
            acc("clone-1.alice.testnet"),
            Whisper::Buy {
                good: "gold".into(),
            },
        );
    }

    #[test]
    fn retrain_between_nights() {
        let mut m = town_with_clone();
        ring_to_dawn(&mut m);
        as_caller("alice.testnet", zero());
        m.retrain(acc("clone-1.alice.testnet"), Temperament::Loyal);
        assert_eq!(
            m.get_clone(acc("clone-1.alice.testnet"))
                .unwrap()
                .temperament,
            Temperament::Loyal
        );
    }

    #[test]
    #[should_panic(expected = "between nights")]
    fn no_retraining_mid_night() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        m.retrain(acc("clone-1.alice.testnet"), Temperament::Loyal);
    }

    #[test]
    fn the_nights_fees_crown_the_best_return() {
        let mut m = town_with_clone();
        as_caller("bob.testnet", NearToken::from_near(1));
        m.register_clone(acc("clone-1.bob.testnet"), Temperament::Loyal, None);
        // Bob's clone joins next night; tonight only alice trades and pays fees.
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 3, 30)]);
        let fees = m.get_town().night_fees;
        assert_eq!(fees, 2);
        ring_to_dawn(&mut m);
        let t = m.get_town();
        assert_eq!(t.crowned, Some((acc("clone-1.alice.testnet"), 2, 1)));
        assert_eq!(t.night_fees, 0);
        assert_eq!(
            m.get_clone(acc("clone-1.alice.testnet")).unwrap().cash,
            2000 - 92 + 2
        );
    }

    #[test]
    fn player_of_accepts_only_the_three_clone_names() {
        assert_eq!(player_of("clone-1.alice.testnet"), Some("alice.testnet"));
        assert_eq!(player_of("clone-3.bob.near"), Some("bob.near"));
        assert_eq!(player_of("clone-4.alice.testnet"), None);
        assert_eq!(player_of("thief.alice.testnet"), None);
        assert_eq!(player_of("clone-1"), None);
    }

    #[test]
    fn register_credits_the_stake_in_millinear() {
        let m = town_with_clone();
        let c = m.get_clone(acc("clone-1.alice.testnet")).unwrap();
        assert_eq!(c.player, acc("alice.testnet"));
        assert_eq!((c.cash, c.stake, c.nights), (2000, 2000, 1));
        assert_eq!(c.temperament, Temperament::Greedy);
        assert!(!c.broke);
    }

    #[test]
    #[should_panic(expected = "under the caller's own account")]
    fn cannot_register_someone_elses_clone() {
        as_caller("mallory.testnet", NearToken::from_near(1));
        let mut m = Market::new(U64(SEED), None, None);
        m.register_clone(acc("clone-1.alice.testnet"), Temperament::Loyal, None);
    }

    #[test]
    #[should_panic(expected = "already in town")]
    fn cannot_register_twice() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", NearToken::from_near(1));
        m.register_clone(acc("clone-1.alice.testnet"), Temperament::Loyal, None);
    }

    #[test]
    #[should_panic(expected = "at least 0.1 NEAR")]
    fn stake_has_a_floor() {
        as_caller("alice.testnet", NearToken::from_millinear(10));
        let mut m = Market::new(U64(SEED), None, None);
        m.register_clone(acc("clone-2.alice.testnet"), Temperament::Cautious, None);
    }

    #[test]
    #[should_panic(expected = "at most 2 NEAR")]
    fn stake_has_a_ceiling() {
        as_caller("alice.testnet", NearToken::from_near(3));
        let mut m = Market::new(U64(SEED), None, None);
        m.register_clone(acc("clone-2.alice.testnet"), Temperament::Cautious, None);
    }

    #[test]
    #[should_panic(expected = "1 to 3 nights")]
    fn nights_are_one_to_three() {
        as_caller("alice.testnet", NearToken::from_near(1));
        let mut m = Market::new(U64(SEED), None, None);
        m.register_clone(acc("clone-2.alice.testnet"), Temperament::Cautious, Some(4));
    }

    #[test]
    fn a_turn_clears_at_the_merchants_quote() {
        let mut m = town_with_clone();
        as_clone();
        // Salt: 3 of 900 bought leaves the merchant at 897, so the quote is still 30.
        let ids = m.trade(0, vec![order("salt", Side::Buy, 3, 30)]);
        assert_eq!(ids, vec![0]);
        let c = m.get_clone(acc("clone-1.alice.testnet")).unwrap();
        assert_eq!(c.cash, 2000 - 92);
        assert_eq!(c.stock, [0, 3, 0, 0, 0]);
        assert_eq!(m.get_town().fees_collected, 2);
        assert_eq!(m.get_town().stock[1], 897);
        let o = &m.get_orders(0, 10)[0];
        assert_eq!((o.price, o.fee, o.round, o.night), (30, 2, 0, 1));
    }

    #[test]
    fn buying_raises_next_hours_price() {
        let mut m = town_with_clone();
        as_clone();
        let book = rules::Book::at(SEED, 0, rules::NORMAL_STOCK);
        let q = rules::affordable(2000, &book, 4);
        m.trade(
            0,
            vec![order(
                "amber",
                Side::Buy,
                q,
                book.quote(4, rules::Side::Buy, q),
            )],
        );
        as_caller("keeper.testnet", zero());
        m.advance_round(0);
        let quiet = rules::Book::at(SEED, 1, rules::NORMAL_STOCK).board()[4];
        assert!(m.get_town().prices[4] > quiet);
    }

    #[test]
    #[should_panic(expected = "already traded this hour")]
    fn one_turn_per_hour() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 1, 30)]);
        m.trade(0, vec![order("salt", Side::Buy, 1, 30)]);
    }

    #[test]
    #[should_panic(expected = "that hour is over")]
    fn a_late_turn_is_refused() {
        let mut m = town_with_clone();
        as_caller("keeper.testnet", zero());
        m.advance_round(0);
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 1, 30)]);
    }

    #[test]
    #[should_panic(expected = "not enough cash")]
    fn a_turn_is_whole_or_nothing() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(
            0,
            vec![
                order("salt", Side::Buy, 1, 30),
                order("amber", Side::Buy, 40, 1000),
            ],
        );
    }

    #[test]
    #[should_panic(expected = "starts trading next night")]
    fn a_clone_never_joins_a_night_under_way() {
        let mut m = town_with_clone();
        as_caller("bob.testnet", NearToken::from_near(1));
        m.register_clone(acc("clone-1.bob.testnet"), Temperament::Loyal, None);
        as_caller("clone-1.bob.testnet", zero());
        m.trade(0, vec![order("salt", Side::Buy, 1, 30)]);
    }

    #[test]
    #[should_panic(expected = "the town is asleep")]
    fn no_trading_at_dawn() {
        let mut m = town_with_clone();
        ring_to_dawn(&mut m);
        as_clone();
        m.trade(rules::ROUNDS, vec![order("salt", Side::Buy, 1, 1000)]);
    }

    #[test]
    #[should_panic(expected = "only a clone in town")]
    fn strangers_cannot_trade() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        m.trade(0, vec![order("salt", Side::Buy, 1, 30)]);
    }

    #[test]
    #[should_panic(expected = "unknown good")]
    fn unknown_goods_are_refused() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(0, vec![order("gold", Side::Buy, 1, 30)]);
    }

    #[test]
    #[should_panic(expected = "below the merchant's price")]
    fn a_low_limit_does_not_fill() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 1, 29)]);
    }

    #[test]
    #[should_panic(expected = "only the town keeper")]
    fn only_the_keeper_rings_the_hour() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        m.advance_round(0);
    }

    #[test]
    #[should_panic(expected = "only the player who sent this clone")]
    fn only_the_player_can_settle() {
        let mut m = town_with_clone();
        ring_to_dawn(&mut m);
        as_clone();
        let _ = m.settle(acc("clone-1.alice.testnet"));
    }

    #[test]
    #[should_panic(expected = "not during the night")]
    fn no_settling_mid_night() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        let _ = m.settle(acc("clone-1.alice.testnet"));
    }

    #[test]
    fn dawn_counts_the_night_and_marks_who_is_due_home() {
        let mut m = town_with_clone();
        as_caller("bob.testnet", NearToken::from_near(1));
        m.register_clone(acc("clone-1.bob.testnet"), Temperament::Loyal, Some(2));
        ring_to_dawn(&mut m);
        let a = m.get_clone(acc("clone-1.alice.testnet")).unwrap();
        assert_eq!((a.nights_played, a.due_home), (1, true));
        let b = m.get_clone(acc("clone-1.bob.testnet")).unwrap();
        assert_eq!(
            (b.nights_played, b.due_home),
            (0, false),
            "bob's clone joined late"
        );
    }

    #[test]
    fn settle_sells_everything_and_takes_the_clone_out_of_town() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 3, 30)]);
        ring_to_dawn(&mut m);
        let dawn = m.get_clone(acc("clone-1.alice.testnet")).unwrap().worth;
        as_caller("alice.testnet", zero());
        let _ = m.settle(acc("clone-1.alice.testnet"));
        assert!(m.get_clone(acc("clone-1.alice.testnet")).is_none());
        let r = m.get_results(acc("alice.testnet"));
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].stake, r[0].paid_out, r[0].night), (2000, dawn, 1));
        assert_eq!(m.get_recent().len(), 1);
        assert_eq!(
            m.get_town().stock[1],
            900,
            "the merchant took the salt back"
        );
    }

    #[test]
    fn the_town_board_keeps_the_last_forty() {
        as_caller("keeper.testnet", zero());
        let mut m = Market::new(U64(SEED), None, None);
        for i in 0..45 {
            let player = format!("p{i}.testnet");
            as_caller(&player, NearToken::from_millinear(100 + i));
            m.register_clone(acc(&format!("clone-1.{player}")), Temperament::Loyal, None);
            as_caller(&player, zero());
            let _ = m.settle(acc(&format!("clone-1.{player}")));
        }
        let board = m.get_recent();
        assert_eq!(board.len(), 40);
        assert_eq!(board[0].stake, 105, "oldest kept first");
        assert_eq!(board[39].stake, 144);
    }
}
