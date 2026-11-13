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
//!
//! The merchant's five goods are NEP-245 multi-tokens, so wallets and indexers can see what each
//! clone holds. The token ids are the good names (`grain`, `salt`, `wool`, `iron`, `amber`). A
//! clone's balance is its holding in this ledger, and the supply of a good is what the clones in
//! town hold between them; the merchant's own stock is not a token balance. Every buy logs an
//! `mt_mint` event to the clone and every sell, and every settlement, an `mt_burn`, so the supply
//! is always the mints less the burns. The views (balances, supply, enumeration, metadata) follow
//! the standard. The transfers do not: every `mt_*transfer*` method refuses, because a good that
//! could leave the market would be a way for a clone to hand its value away from its player.

use clones_core as rules;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

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

/// Longest instruction a possessed clone can carry, in bytes.
pub const MAX_INSTRUCTION: usize = 160;

/// Whispers a player may send each clone each night.
pub const WHISPERS_A_NIGHT: u32 = 3;

/// Most orders in one clone's turn.
pub const MAX_ORDERS_PER_TURN: usize = 6;

/// Nights in a season. At the first dusk after one, the player with the best season takes the
/// season crown and the standings start again.
pub const SEASON_NIGHTS: u32 = 7;

/// Players remembered in a season's standings (a bound on storage). Later newcomers still play;
/// they are not ranked until the next season.
pub const SEASON_PLAYERS: u32 = 200;

/// Season champions remembered.
pub const CHAMPIONS_KEPT: u32 = 20;

const YOCTO_PER_MILLI: u128 = 1_000_000_000_000_000_000_000;

/// NEP-245 metadata: the contract's spec and name, and the one base metadata every good shares.
pub const MT_SPEC: &str = "mt-1.0.0";
pub const MT_NAME: &str = "Clones market goods";
pub const MT_SYMBOL: &str = "GOODS";
pub const MT_BASE_ID: &str = "goods";

/// Each good's title, in the order of `clones_core::GOODS`.
pub const GOOD_TITLES: [&str; 5] = ["Grain", "Salt", "Wool", "Iron", "Amber"];

/// Why every NEP-245 transfer is refused.
pub const GOODS_STAY: &str = "goods stay at the market: a clone can only trade them";

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Temperament {
    Cautious,
    Greedy,
    Loyal,
    Possessed,
}

impl From<Temperament> for rules::Temperament {
    fn from(t: Temperament) -> Self {
        match t {
            Temperament::Cautious => rules::Temperament::Cautious,
            Temperament::Greedy => rules::Temperament::Greedy,
            Temperament::Loyal => rules::Temperament::Loyal,
            Temperament::Possessed => rules::Temperament::Possessed,
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

/// One order a player shouts to a clone for the next hour, up to WHISPERS_A_NIGHT a night. The runner obeys it
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
    /// (night, whispers used that night).
    pub whispers: (u32, u32),
    /// Every whisper of the current night as (night, hour, order), so the night can be replayed
    /// from chain state after it is over.
    pub whisper_log: Vec<(u32, u32, Whisper)>,
    /// A possessed clone's instruction from its player, public on chain.
    pub instruction: Option<String>,
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
    /// The whisper waiting for it as (night, hour, order), if any, and how many whispers its
    /// player has left for it tonight.
    pub whisper: Option<(u32, u32, Whisper)>,
    pub whispers_left: u32,
    /// Every whisper of the current night, as (night, hour, order).
    pub whispers_tonight: Vec<(u32, u32, Whisper)>,
    /// A possessed clone's instruction from its player.
    pub instruction: Option<String>,
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
    /// What it held at the last dusk, the first night it played, the nights it was sent for, and
    /// its whispers that night: with the orders, enough to replay its last night after it is gone.
    pub from_night: u32,
    pub nights: u32,
    pub dusk_cash: u64,
    pub dusk_stock: [u32; 5],
    pub dusk_orders: u32,
    pub whispers: Vec<(u32, u32, Whisper)>,
}

/// One player's season so far. Amounts in milliNEAR.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SeasonRow {
    /// Paid out less staked, summed over every clone settled this season (crowns included).
    pub net: i64,
    pub staked: u64,
    pub clones: u32,
    /// Night crowns its clones took this season.
    pub crowns: u32,
}

/// A season's winner: the player with the best net when the season closed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Champion {
    pub season: u32,
    pub player: AccountId,
    pub net: i64,
    pub crowns: u32,
    /// The last night of that season.
    pub night: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeasonView {
    pub season: u32,
    /// The first night of this season, and the last.
    pub started_night: u32,
    pub ends_night: u32,
    pub players: u32,
    /// A page of this season's standings, in the order players joined it.
    pub rows: Vec<(AccountId, SeasonRow)>,
    /// Past seasons' champions, oldest first.
    pub champions: Vec<Champion>,
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
    /// Who holds the merchant's deed (the player whose clone took the last crown): they are paid
    /// a quarter of each night's fees at dawn.
    pub deed: Option<AccountId>,
    /// The last deed share paid: (player, milliNEAR, night).
    pub deed_paid: Option<(AccountId, u64, u32)>,
    /// The good the deed holder has ordered fully restocked at the next dusk, if any.
    pub restock_order: Option<String>,
    /// Tonight's fee on every trade, in basis points, and the fee the deed holder has set for the
    /// next night (the standard 200 if none).
    pub fee_bps: u64,
    pub next_fee_bps: Option<u64>,
    /// The current season and the night it started.
    pub season: u32,
    pub season_started_night: u32,
    pub fees_collected: u64,
    pub clones_in_town: u32,
}

/// NEP-245 contract metadata (`mt_metadata_contract`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MtContractMetadata {
    pub spec: String,
    pub name: String,
}

/// NEP-245 base metadata, shared by all five goods (id `goods`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MtBaseTokenMetadata {
    pub name: String,
    pub id: String,
    pub symbol: Option<String>,
    pub icon: Option<String>,
    pub decimals: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub copies: Option<u64>,
    pub reference_hash: Option<String>,
}

/// NEP-245 per-token metadata: one per good.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MtTokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MtTokenMetadataAll {
    pub base: MtBaseTokenMetadata,
    pub token: MtTokenMetadata,
}

/// A NEP-245 token: one good. Goods are fungible and many clones hold each, so `owner_id` is
/// always null.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
    pub token_metadata: Option<MtTokenMetadata>,
    pub base_metadata_id: String,
}

fn good_or_panic(token_id: &str) -> usize {
    rules::good_index(token_id).unwrap_or_else(|| env::panic_str("unknown good"))
}

fn mt_base_metadata() -> MtBaseTokenMetadata {
    MtBaseTokenMetadata {
        name: MT_NAME.to_string(),
        id: MT_BASE_ID.to_string(),
        symbol: Some(MT_SYMBOL.to_string()),
        icon: None,
        decimals: Some("0".to_string()),
        base_uri: None,
        reference: None,
        copies: None,
        reference_hash: None,
    }
}

fn mt_token_metadata(g: usize) -> MtTokenMetadata {
    MtTokenMetadata {
        title: Some(GOOD_TITLES[g].to_string()),
        description: Some(format!(
            "{}, a good of the Clones market town. Clones buy it from the merchant and sell it back; it never leaves the market.",
            GOOD_TITLES[g]
        )),
        media: None,
        media_hash: None,
        issued_at: None,
        expires_at: None,
        starts_at: None,
        updated_at: None,
        extra: None,
        reference: None,
        reference_hash: None,
    }
}

fn mt_token_of(g: usize) -> Token {
    Token {
        token_id: rules::GOODS[g].to_string(),
        owner_id: None,
        token_metadata: Some(mt_token_metadata(g)),
        base_metadata_id: MT_BASE_ID.to_string(),
    }
}

/// A page of `goods` (indices into `clones_core::GOODS`) as NEP-245 enumeration returns it.
fn mt_page(
    goods: impl Iterator<Item = usize>,
    from_index: Option<U128>,
    limit: Option<u32>,
) -> Vec<Token> {
    let from = from_index.map_or(0, |f| f.0.min(rules::GOODS.len() as u128) as usize);
    goods
        .skip(from)
        .take(limit.map_or(usize::MAX, |l| l as usize))
        .map(mt_token_of)
        .collect()
}

/// Log one NEP-245 event (`mt_mint` or `mt_burn`) for `owner_id`, batching every good with a
/// non-zero amount into one entry. Nothing is logged when every amount is zero. Account ids and
/// good names never need JSON escaping.
fn log_mt_event(event: &str, owner_id: &AccountId, amounts: &[u64; 5]) {
    let goods: Vec<usize> = (0..5).filter(|g| amounts[*g] > 0).collect();
    if goods.is_empty() {
        return;
    }
    let quoted = |f: &dyn Fn(usize) -> String| {
        goods
            .iter()
            .map(|g| format!("\"{}\"", f(*g)))
            .collect::<Vec<_>>()
            .join(",")
    };
    let ids = quoted(&|g| rules::GOODS[g].to_string());
    let qty = quoted(&|g| amounts[g].to_string());
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"{event}\",\"data\":[{{\"owner_id\":\"{owner_id}\",\"token_ids\":[{ids}],\"amounts\":[{qty}]}}]}}"
    ));
}

#[near(
    contract_state,
    contract_metadata(standard(standard = "nep245", version = "1.0.0"))
)]
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
    deed: Option<AccountId>,
    deed_paid: Option<(AccountId, u64, u32)>,
    restock_order: Option<u8>,
    fee_bps: u64,
    next_fee_bps: Option<u64>,
    season: u32,
    season_started_night: u32,
    season_rows: IterableMap<AccountId, SeasonRow>,
    champions: Vector<Champion>,
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
            deed: None,
            deed_paid: None,
            restock_order: None,
            fee_bps: rules::FEE_BPS,
            next_fee_bps: None,
            season: 1,
            season_started_night: 1,
            season_rows: IterableMap::new(b"s"),
            champions: Vector::new(b"h"),
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
            fee_bps: self.fee_bps,
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
        // Tonight's fee: what the deed holder set, or the standard one.
        self.fee_bps = self.next_fee_bps.take().unwrap_or(rules::FEE_BPS);
        if night >= self.season_started_night + SEASON_NIGHTS {
            self.close_season(night - 1);
        }
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
        // The deed holder's order: one good back to the merchant's full normal stock.
        if let Some(g) = self.restock_order.take() {
            self.stock[g as usize] = self.stock[g as usize].max(rules::NORMAL_STOCK[g as usize]);
        }
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
            // The deed holder's share first, paid straight to the player's account.
            let share = if self.deed.is_some() {
                self.night_fees * rules::DEED_PCT / 100
            } else {
                0
            };
            if let (Some(holder), true) = (self.deed.clone(), share > 0) {
                let _ = Promise::new(holder.clone())
                    .transfer(NearToken::from_yoctonear(share as u128 * YOCTO_PER_MILLI));
                env::log_str(&format!("deed {holder}: {share} mNEAR"));
                self.deed_paid = Some((holder, share, night));
            }
            let pot = self.night_fees - share;
            let winner_player = self.clones.get(&id).map(|r| r.player.clone());
            if let Some(p) = &winner_player {
                if let Some(row) = self.season_row(p) {
                    row.crowns += 1;
                }
            }
            if let Some(rec) = self.clones.get_mut(&id) {
                rec.cash += pot;
            }
            env::log_str(&format!("crowned {id}: {pot} mNEAR"));
            self.crowned = Some((id, pot, night));
            self.deed = winner_player;
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
        instruction: Option<String>,
    ) {
        require!(
            instruction
                .as_ref()
                .is_none_or(|i| i.len() <= MAX_INSTRUCTION),
            "an instruction is at most 160 characters"
        );
        let instruction = if temperament == Temperament::Possessed {
            instruction
        } else {
            None
        };
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
                whispers: (0, 0),
                whisper_log: Vec::new(),
                instruction,
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
        // A whisper for this hour binds the turn: the contract refuses anything else.
        let whispered = matches!(&rec.whisper, Some((n, h, _)) if (*n, *h) == (night, hour));
        if !whispered {
            // Without a whisper, the clone's temperament binds it: a cautious, greedy or loyal
            // clone's turn must be exactly what its rules decide from this hour's board, and a
            // possessed clone's must be one legal move (sell everything, or one buy).
            let temperament: rules::Temperament = rec.temperament.into();
            if temperament == rules::Temperament::Possessed {
                let sell_up = intents.iter().all(|i| i.side == rules::Side::Sell)
                    && (0..5).all(|g| {
                        rec.stock[g] == 0
                            || intents.iter().any(|i| i.good == g && i.qty == rec.stock[g])
                    });
                let one_buy = intents.len() == 1 && intents[0].side == rules::Side::Buy;
                require!(
                    sell_up || one_buy,
                    "a possessed clone makes one move an hour"
                );
            } else {
                let want = rules::decide(
                    temperament,
                    &rules::View {
                        round: hour,
                        book,
                        prices: book.board(),
                        prev: self.prev_prices,
                        ledger: rec.ledger(),
                        stake: rec.stake,
                    },
                )
                .intents;
                require!(
                    want.len() == intents.len()
                        && want
                            .iter()
                            .zip(&intents)
                            .all(|(w, i)| (w.good, w.side, w.qty) == (i.good, i.side, i.qty)),
                    "that is not what this clone's temperament does this hour"
                );
            }
        }
        if let Some((n, h, w)) = &rec.whisper {
            if (*n, *h) == (night, hour) {
                match w {
                    Whisper::Hold => env::panic_str("your player said hold this hour"),
                    Whisper::SellAll => require!(
                        intents.iter().all(|i| i.side == rules::Side::Sell)
                            && (0..5).all(|g| {
                                rec.stock[g] == 0
                                    || intents.iter().any(|i| i.good == g && i.qty == rec.stock[g])
                            }),
                        "your player said sell everything this hour"
                    ),
                    Whisper::Buy { good } => require!(
                        intents.len() == 1
                            && intents[0].side == rules::Side::Buy
                            && rules::GOODS[intents[0].good] == good.as_str(),
                        "your player said buy something else this hour"
                    ),
                }
            }
        }
        let mut ledger = rec.ledger();
        let fills = rules::apply_turn(&mut ledger, &mut self.stock, &book, &intents)
            .unwrap_or_else(|e| env::panic_str(e));
        rec.cash = ledger.cash;
        rec.stock = ledger.stock;
        rec.orders_placed += fills.len() as u32;
        rec.last_turn = Some((night, hour));
        // NEP-245: what the clone bought is minted to it, what it sold is burned.
        let (mut bought, mut sold) = ([0u64; 5], [0u64; 5]);
        for i in &intents {
            match i.side {
                rules::Side::Buy => bought[i.good] += i.qty as u64,
                rules::Side::Sell => sold[i.good] += i.qty as u64,
            }
        }
        log_mt_event("mt_mint", &clone, &bought);
        log_mt_event("mt_burn", &clone, &sold);
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

    /// Called by the player during a night: one order for the clone's next hour, up to WHISPERS_A_NIGHT a night.
    /// The night runner obeys it instead of the clone's temperament for that hour.
    pub fn whisper(&mut self, clone_id: AccountId, whisper: Whisper) {
        require!(!self.asleep(), "whisper while the night is on");
        // The coming hour: the one the keeper has opened and the clones have yet to trade (a
        // whisper that lands after the clone's turn simply has no effect).
        let (night, next) = (self.night, self.round);
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
        let used = if rec.whispers.0 == night {
            rec.whispers.1
        } else {
            0
        };
        require!(
            used < WHISPERS_A_NIGHT,
            "you have used this clone's three whispers tonight"
        );
        rec.whisper_log.retain(|(n, _, _)| *n == night);
        rec.whisper_log.push((night, next, whisper.clone()));
        rec.whisper = Some((night, next, whisper));
        rec.whispers = (night, used + 1);
    }

    /// Called by the holder of the merchant's deed between nights: name one good the merchant
    /// restocks in full at the next dusk (so it opens cheap). Deed holder only.
    pub fn order_restock(&mut self, good: String) {
        require!(self.asleep(), "order the restock between nights");
        require!(
            self.deed.as_ref() == Some(&env::predecessor_account_id()),
            "only the holder of the merchant's deed can order the restock"
        );
        let g = rules::good_index(&good).unwrap_or_else(|| env::panic_str("unknown good"));
        self.restock_order = Some(g as u8);
    }

    /// Called by the holder of the merchant's deed between nights: the fee on every trade next
    /// night, 50 to 300 basis points (0.5% to 3%). The deed holder is paid a quarter of the fees,
    /// but a dear market trades less and costs their own clones too.
    pub fn set_fee(&mut self, bps: u64) {
        require!(self.asleep(), "set the fee between nights");
        require!(
            self.deed.as_ref() == Some(&env::predecessor_account_id()),
            "only the holder of the merchant's deed can set the fee"
        );
        require!(
            (rules::MIN_FEE_BPS..=rules::MAX_FEE_BPS).contains(&bps),
            "the fee is 50 to 300 basis points"
        );
        self.next_fee_bps = Some(bps);
    }

    /// This season's row for a player, made if there is room.
    fn season_row(&mut self, player: &AccountId) -> Option<&mut SeasonRow> {
        if !self.season_rows.contains_key(player) {
            if self.season_rows.len() >= SEASON_PLAYERS {
                return None;
            }
            self.season_rows
                .insert(player.clone(), SeasonRow::default());
        }
        self.season_rows.get_mut(player)
    }

    /// The season is over: the best net takes the season crown (ties go to more night crowns,
    /// then to whoever joined the season first), and the standings start again.
    fn close_season(&mut self, last_night: u32) {
        let mut best: Option<(AccountId, SeasonRow)> = None;
        for (p, r) in self.season_rows.iter() {
            let better = match &best {
                None => true,
                Some((_, b)) => (r.net, r.crowns) > (b.net, b.crowns),
            };
            if better {
                best = Some((p.clone(), r.clone()));
            }
        }
        if let Some((player, row)) = best {
            env::log_str(&format!(
                "season {} crown: {player}, {} mNEAR",
                self.season, row.net
            ));
            let champ = Champion {
                season: self.season,
                player,
                net: row.net,
                crowns: row.crowns,
                night: last_night,
            };
            if self.champions.len() < CHAMPIONS_KEPT {
                self.champions.push(champ);
            } else {
                self.champions
                    .replace((self.season - 1) % CHAMPIONS_KEPT, champ);
            }
        }
        self.season_rows.clear();
        self.season += 1;
        self.season_started_night = last_night + 1;
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
        log_mt_event("mt_burn", &clone_id, &rec.stock.map(|q| q as u64));
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
            from_night: rec.from_night,
            nights: rec.nights,
            dusk_cash: rec.dusk_cash,
            dusk_stock: rec.dusk_stock,
            dusk_orders: rec.dusk_orders,
            whispers: rec
                .whisper_log
                .iter()
                .filter(|(n, _, _)| *n == self.night)
                .cloned()
                .collect(),
        };
        if let Some(row) = self.season_row(&rec.player) {
            row.net += ledger.cash as i64 - rec.stake as i64;
            row.staked += rec.stake;
            row.clones += 1;
        }
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

    /// This season's standings, a page at a time, with past champions.
    pub fn get_season(&self, from: u32, limit: u32) -> SeasonView {
        let n = self.champions.len();
        let start = if n > 0 && self.season - 1 > n {
            (self.season - 1) % n
        } else {
            0
        };
        SeasonView {
            season: self.season,
            started_night: self.season_started_night,
            ends_night: self.season_started_night + SEASON_NIGHTS - 1,
            players: self.season_rows.len(),
            rows: self
                .season_rows
                .iter()
                .skip(from as usize)
                .take(limit.min(SEASON_PLAYERS) as usize)
                .map(|(p, r)| (p.clone(), r.clone()))
                .collect(),
            champions: (0..n)
                .map(|i| self.champions[(start + i) % n].clone())
                .collect(),
        }
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
            whispers_tonight: r
                .whisper_log
                .iter()
                .filter(|(n, _, _)| *n == self.night)
                .cloned()
                .collect(),
            instruction: r.instruction.clone(),
            whispers_left: WHISPERS_A_NIGHT
                - if r.whispers.0 == self.night {
                    r.whispers.1
                } else {
                    0
                },
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
            deed: self.deed.clone(),
            deed_paid: self.deed_paid.clone(),
            restock_order: self
                .restock_order
                .map(|g| rules::GOODS[g as usize].to_string()),
            fee_bps: self.fee_bps,
            next_fee_bps: self.next_fee_bps,
            season: self.season,
            season_started_night: self.season_started_night,
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

/// NEP-245 (multi token): the merchant's goods as tokens. Balances, supply, enumeration and
/// metadata follow the standard; transfers refuse.
#[near]
impl Market {
    /// A clone's holding of a good in this ledger; 0 for any other account.
    fn holding(&self, account_id: &AccountId, g: usize) -> u128 {
        self.clones
            .get(account_id)
            .map_or(0, |r| r.stock[g] as u128)
    }

    /// What the clones in town hold of each good, between them.
    fn supplies(&self) -> [u128; 5] {
        let mut total = [0u128; 5];
        for r in self.clones.values() {
            for (t, q) in total.iter_mut().zip(r.stock) {
                *t += q as u128;
            }
        }
        total
    }

    /// How much of a good a clone holds. Players and every other account hold none: goods only
    /// ever sit with a clone in town. Panics on an unknown good.
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.holding(&account_id, good_or_panic(&token_id)))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids
            .iter()
            .map(|t| U128(self.holding(&account_id, good_or_panic(t))))
            .collect()
    }

    /// The supply of a good: the total the clones in town hold, which is every `mt_mint` less
    /// every `mt_burn`. The merchant's own stock is not counted (see `get_town().stock`); it is
    /// not anyone's token balance. Null for an unknown good.
    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        rules::good_index(&token_id).map(|g| U128(self.supplies()[g]))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        let total = self.supplies();
        token_ids
            .iter()
            .map(|t| rules::good_index(t).map(|g| U128(total[g])))
            .collect()
    }

    /// Each token, or null for an unknown id.
    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<Token>> {
        token_ids
            .iter()
            .map(|t| rules::good_index(t).map(mt_token_of))
            .collect()
    }

    /// All five goods, a page at a time.
    pub fn mt_tokens(&self, from_index: Option<U128>, limit: Option<u32>) -> Vec<Token> {
        mt_page(0..rules::GOODS.len(), from_index, limit)
    }

    /// The goods this account holds (a clone in town; nobody else holds any), a page at a time.
    pub fn mt_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u32>,
    ) -> Vec<Token> {
        let stock = self.clones.get(&account_id).map_or([0; 5], |r| r.stock);
        mt_page(
            (0..rules::GOODS.len()).filter(|g| stock[*g] > 0),
            from_index,
            limit,
        )
    }

    pub fn mt_metadata_contract(&self) -> MtContractMetadata {
        MtContractMetadata {
            spec: MT_SPEC.to_string(),
            name: MT_NAME.to_string(),
        }
    }

    /// Panics on an unknown good, like every metadata view below.
    pub fn mt_metadata_token_all(&self, token_ids: Vec<String>) -> Vec<MtTokenMetadataAll> {
        token_ids
            .iter()
            .map(|t| MtTokenMetadataAll {
                base: mt_base_metadata(),
                token: mt_token_metadata(good_or_panic(t)),
            })
            .collect()
    }

    pub fn mt_metadata_token_by_token_id(&self, token_ids: Vec<String>) -> Vec<MtTokenMetadata> {
        token_ids
            .iter()
            .map(|t| mt_token_metadata(good_or_panic(t)))
            .collect()
    }

    pub fn mt_metadata_base_by_token_id(&self, token_ids: Vec<String>) -> Vec<MtBaseTokenMetadata> {
        token_ids
            .iter()
            .map(|t| {
                good_or_panic(t);
                mt_base_metadata()
            })
            .collect()
    }

    /// The only base metadata id is `goods`.
    pub fn mt_metadata_base_by_metadata_id(
        &self,
        base_metadata_ids: Vec<String>,
    ) -> Vec<MtBaseTokenMetadata> {
        base_metadata_ids
            .iter()
            .map(|id| {
                require!(id == MT_BASE_ID, "unknown base metadata id");
                mt_base_metadata()
            })
            .collect()
    }

    /// Every base metadata (there is one, `goods`), a page at a time.
    pub fn mt_tokens_base_metadata_all(
        &self,
        from_index: Option<U128>,
        limit: Option<u32>,
    ) -> Vec<MtBaseTokenMetadata> {
        std::iter::once(mt_base_metadata())
            .skip(from_index.map_or(0, |f| f.0.min(1) as usize))
            .take(limit.map_or(usize::MAX, |l| l as usize))
            .collect()
    }

    // The four NEP-245 transfers refuse every call. A clone's goods are its player's stake in
    // another form: if a clone could move them to any account it would have a way out of the
    // leash (it could hand its value to a stranger), and if the player could, the player could
    // take goods out of a clone mid-run and the ledger the night's audit replays would no longer
    // match the trades. Goods leave a clone only by `trade` (sold to the merchant) or `settle`
    // (sold to the merchant, cash paid out).
    //
    // They answer to the standard's names and accept its arguments, but never read them: a call
    // that is refused whatever it says needs no parsing, and parsing four argument shapes only to
    // throw them away would add a fifth to the contract's size. They are payable, so a call with
    // the standard's 1 yoctoNEAR gets this message rather than a deposit error.

    /// NEP-245 `mt_transfer(receiver_id, token_id, amount, approval, memo)`. Refused: goods stay
    /// at the market.
    #[payable]
    pub fn mt_transfer(&mut self) {
        env::panic_str(GOODS_STAY)
    }

    /// NEP-245 `mt_batch_transfer(receiver_id, token_ids, amounts, approvals, memo)`. Refused:
    /// goods stay at the market.
    #[payable]
    pub fn mt_batch_transfer(&mut self) {
        env::panic_str(GOODS_STAY)
    }

    /// NEP-245 `mt_transfer_call(receiver_id, token_id, amount, approval, memo, msg)`. Refused:
    /// goods stay at the market, so no `mt_on_transfer` is ever called and there is nothing for
    /// an `mt_resolve_transfer` to resolve.
    #[payable]
    pub fn mt_transfer_call(&mut self) -> PromiseOrValue<Vec<U128>> {
        env::panic_str(GOODS_STAY)
    }

    /// NEP-245 `mt_batch_transfer_call(receiver_id, token_ids, amounts, approvals, memo, msg)`.
    /// Refused: goods stay at the market.
    #[payable]
    pub fn mt_batch_transfer_call(&mut self) -> PromiseOrValue<Vec<U128>> {
        env::panic_str(GOODS_STAY)
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

    /// A town with alice's possessed clone in it (free to make any one legal move an hour, so the
    /// tests can choose its orders) and the first night open.
    fn town_with_clone() -> Market {
        as_caller("keeper.testnet", zero());
        let mut m = Market::new(U64(SEED), None, None);
        as_caller("alice.testnet", NearToken::from_near(2));
        m.register_clone(
            acc("clone-1.alice.testnet"),
            Temperament::Possessed,
            None,
            None,
        );
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
        m.register_clone(
            acc("clone-1.mallory.testnet"),
            Temperament::Greedy,
            None,
            None,
        );
    }

    #[test]
    fn a_hosted_town_takes_its_guests() {
        as_caller("keeper.testnet", zero());
        let mut m = Market::new(U64(SEED), Some(acc("house.testnet")), None);
        as_caller("g1.house.testnet", NearToken::from_near(1));
        m.register_clone(
            acc("clone-1.g1.house.testnet"),
            Temperament::Greedy,
            None,
            None,
        );
        assert_eq!(m.get_town().clones_in_town, 1);
    }

    #[test]
    fn lists_the_clones_in_town() {
        let mut m = town_with_clone();
        as_caller("bob.testnet", NearToken::from_near(1));
        m.register_clone(
            acc("clone-2.bob.testnet"),
            Temperament::Loyal,
            Some(2),
            None,
        );
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
        assert_eq!(c.whisper, Some((1, 0, Whisper::SellAll)));
        assert_eq!(c.whispers_left, 2);
    }

    #[test]
    #[should_panic(expected = "three whispers tonight")]
    fn three_whispers_a_night() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        for w in [
            Whisper::Hold,
            Whisper::SellAll,
            Whisper::Hold,
            Whisper::SellAll,
        ] {
            m.whisper(acc("clone-1.alice.testnet"), w);
        }
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
        m.register_clone(acc("clone-1.bob.testnet"), Temperament::Loyal, None, None);
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
            t.deed,
            Some(acc("alice.testnet")),
            "the crown's player takes the deed"
        );
        assert_eq!(t.deed_paid, None, "nobody held the deed on the first night");
        assert_eq!(
            m.get_clone(acc("clone-1.alice.testnet")).unwrap().cash,
            2000 - 92 + 2
        );
    }

    #[test]
    fn the_deed_holder_takes_a_quarter_of_the_next_nights_fees() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 3, 30)]);
        ring_to_dawn(&mut m);
        assert_eq!(m.get_town().deed, Some(acc("alice.testnet")));
        open(&mut m);
        let book = rules::Book::at(SEED, 0, m.get_town().hour_stock);
        let q = 30;
        as_clone();
        m.trade(
            0,
            vec![order(
                "grain",
                Side::Buy,
                q,
                book.quote(0, rules::Side::Buy, q),
            )],
        );
        let fees = m.get_town().night_fees;
        ring_to_dawn(&mut m);
        let t = m.get_town();
        let share = fees * rules::DEED_PCT / 100;
        assert!(share > 0);
        assert_eq!(t.deed_paid, Some((acc("alice.testnet"), share, 2)));
        assert_eq!(t.crowned.unwrap().1, fees - share);
    }

    #[test]
    fn a_possessed_clone_carries_its_players_instruction() {
        as_caller("alice.testnet", NearToken::from_near(1));
        let mut m = Market::new(U64(SEED), None, None);
        m.register_clone(
            acc("clone-1.alice.testnet"),
            Temperament::Possessed,
            None,
            Some("Buy amber when it falls".into()),
        );
        m.register_clone(
            acc("clone-2.alice.testnet"),
            Temperament::Greedy,
            None,
            Some("ignored".into()),
        );
        let c1 = m.get_clone(acc("clone-1.alice.testnet")).unwrap();
        assert_eq!(c1.instruction.as_deref(), Some("Buy amber when it falls"));
        assert_eq!(
            m.get_clone(acc("clone-2.alice.testnet"))
                .unwrap()
                .instruction,
            None
        );
    }

    #[test]
    #[should_panic(expected = "at most 160 characters")]
    fn an_instruction_is_short() {
        as_caller("alice.testnet", NearToken::from_near(1));
        let mut m = Market::new(U64(SEED), None, None);
        m.register_clone(
            acc("clone-1.alice.testnet"),
            Temperament::Possessed,
            None,
            Some("x".repeat(161)),
        );
    }

    #[test]
    #[should_panic(expected = "your player said hold this hour")]
    fn a_hold_whisper_binds_the_turn() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        m.whisper(acc("clone-1.alice.testnet"), Whisper::Hold);
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 1, 1000)]);
    }

    #[test]
    #[should_panic(expected = "said buy something else")]
    fn a_buy_whisper_binds_the_good() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        m.whisper(
            acc("clone-1.alice.testnet"),
            Whisper::Buy {
                good: "grain".into(),
            },
        );
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 1, 1000)]);
    }

    #[test]
    fn the_deed_holder_orders_a_full_restock() {
        let mut m = town_with_clone();
        as_clone();
        let book = rules::Book::at(SEED, 0, rules::NORMAL_STOCK);
        m.trade(
            0,
            vec![order(
                "amber",
                Side::Buy,
                5,
                book.quote(4, rules::Side::Buy, 5),
            )],
        );
        ring_to_dawn(&mut m);
        as_caller("alice.testnet", zero());
        m.order_restock("amber".into());
        assert_eq!(m.get_town().restock_order.as_deref(), Some("amber"));
        open(&mut m);
        assert_eq!(m.get_town().stock[4], rules::NORMAL_STOCK[4]);
        assert_eq!(m.get_town().restock_order, None);
    }

    #[test]
    #[should_panic(expected = "only the holder of the merchant's deed")]
    fn only_the_deed_holder_orders_the_restock() {
        let mut m = town_with_clone();
        ring_to_dawn(&mut m);
        as_caller("bob.testnet", zero());
        m.order_restock("amber".into());
    }

    #[test]
    fn every_whisper_of_the_night_is_kept_for_the_audit() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        m.whisper(acc("clone-1.alice.testnet"), Whisper::Hold);
        as_caller("keeper.testnet", zero());
        m.advance_round(0);
        as_caller("alice.testnet", zero());
        m.whisper(acc("clone-1.alice.testnet"), Whisper::SellAll);
        let c = m.get_clone(acc("clone-1.alice.testnet")).unwrap();
        assert_eq!(
            c.whispers_tonight,
            vec![(1, 0, Whisper::Hold), (1, 1, Whisper::SellAll)]
        );
        ring_to_dawn(&mut m);
        as_caller("alice.testnet", zero());
        let _ = m.settle(acc("clone-1.alice.testnet"));
        let s = &m.get_results(acc("alice.testnet"))[0];
        assert_eq!(s.whispers.len(), 2);
        assert_eq!((s.from_night, s.nights, s.dusk_cash), (1, 1, 2000));
    }

    #[test]
    fn the_deed_holder_sets_the_next_nights_fee() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 3, 30)]);
        ring_to_dawn(&mut m);
        assert_eq!(m.get_town().fee_bps, rules::FEE_BPS);
        as_caller("alice.testnet", zero());
        m.set_fee(300);
        assert_eq!(m.get_town().next_fee_bps, Some(300));
        open(&mut m);
        let t = m.get_town();
        assert_eq!((t.fee_bps, t.next_fee_bps), (300, None));
        // 3% of a 600 mNEAR buy is 18, where the standard fee would be 12.
        let book = rules::Book::at(SEED, 0, t.hour_stock).with_fee(300);
        let price = book.quote(0, rules::Side::Buy, 30);
        as_clone();
        m.trade(0, vec![order("grain", Side::Buy, 30, price)]);
        let orders = m.get_orders(0, 10);
        let last = orders.last().unwrap();
        assert_eq!(last.fee, rules::fee_at(price * 30, 300));
        assert!(last.fee > rules::fee(price * 30));
        // Nobody set a fee for the night after: back to the standard one.
        ring_to_dawn(&mut m);
        open(&mut m);
        assert_eq!(m.get_town().fee_bps, rules::FEE_BPS);
    }

    #[test]
    #[should_panic(expected = "50 to 300 basis points")]
    fn the_fee_is_bounded() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 3, 30)]);
        ring_to_dawn(&mut m);
        as_caller("alice.testnet", zero());
        m.set_fee(301);
    }

    #[test]
    #[should_panic(expected = "only the holder of the merchant's deed can set the fee")]
    fn only_the_deed_holder_sets_the_fee() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 3, 30)]);
        ring_to_dawn(&mut m);
        as_caller("bob.testnet", zero());
        m.set_fee(100);
    }

    #[test]
    fn a_season_ranks_players_and_crowns_the_best() {
        let mut m = town_with_clone();
        as_caller("bob.testnet", NearToken::from_near(1));
        m.register_clone(acc("clone-1.bob.testnet"), Temperament::Loyal, None, None);
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 3, 30)]);
        ring_to_dawn(&mut m);
        // Alice's clone took the night's crown and comes home after one night.
        let s = m.get_season(0, 10);
        assert_eq!(
            (s.season, s.started_night, s.ends_night),
            (1, 1, SEASON_NIGHTS)
        );
        assert_eq!(s.rows.len(), 1);
        assert_eq!(s.rows[0].1.crowns, 1);
        as_caller("alice.testnet", zero());
        let _ = m.settle(acc("clone-1.alice.testnet"));
        let alice = m.get_season(0, 10).rows[0].1.clone();
        assert_eq!(alice.clones, 1);
        assert_eq!(alice.staked, 2000);
        let paid = m.get_results(acc("alice.testnet"))[0].paid_out as i64;
        assert_eq!(alice.net, paid - 2000);
        // Play out the season; bob's loyal clone settles on night 2.
        open(&mut m);
        ring_to_dawn(&mut m);
        as_caller("bob.testnet", zero());
        let _ = m.settle(acc("clone-1.bob.testnet"));
        let bob_net = m.get_results(acc("bob.testnet"))[0].paid_out as i64 - 1000;
        assert_eq!(m.get_season(0, 10).players, 2);
        while m.get_town().night < SEASON_NIGHTS {
            open(&mut m);
            ring_to_dawn(&mut m);
        }
        assert!(m.get_season(0, 10).champions.is_empty());
        open(&mut m);
        let s = m.get_season(0, 10);
        assert_eq!((s.season, s.started_night), (2, SEASON_NIGHTS + 1));
        assert_eq!(s.players, 0, "a new season starts empty");
        let best = if alice.net >= bob_net {
            "alice.testnet"
        } else {
            "bob.testnet"
        };
        assert_eq!(s.champions.len(), 1);
        assert_eq!(s.champions[0].player, acc(best));
        assert_eq!(s.champions[0].night, SEASON_NIGHTS);
        assert_eq!(m.get_town().season, 2);
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
        assert_eq!(c.temperament, Temperament::Possessed);
        assert!(!c.broke);
    }

    #[test]
    #[should_panic(expected = "under the caller's own account")]
    fn cannot_register_someone_elses_clone() {
        as_caller("mallory.testnet", NearToken::from_near(1));
        let mut m = Market::new(U64(SEED), None, None);
        m.register_clone(acc("clone-1.alice.testnet"), Temperament::Loyal, None, None);
    }

    #[test]
    #[should_panic(expected = "already in town")]
    fn cannot_register_twice() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", NearToken::from_near(1));
        m.register_clone(acc("clone-1.alice.testnet"), Temperament::Loyal, None, None);
    }

    #[test]
    #[should_panic(expected = "at least 0.1 NEAR")]
    fn stake_has_a_floor() {
        as_caller("alice.testnet", NearToken::from_millinear(10));
        let mut m = Market::new(U64(SEED), None, None);
        m.register_clone(
            acc("clone-2.alice.testnet"),
            Temperament::Cautious,
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "at most 2 NEAR")]
    fn stake_has_a_ceiling() {
        as_caller("alice.testnet", NearToken::from_near(3));
        let mut m = Market::new(U64(SEED), None, None);
        m.register_clone(
            acc("clone-2.alice.testnet"),
            Temperament::Cautious,
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "1 to 3 nights")]
    fn nights_are_one_to_three() {
        as_caller("alice.testnet", NearToken::from_near(1));
        let mut m = Market::new(U64(SEED), None, None);
        m.register_clone(
            acc("clone-2.alice.testnet"),
            Temperament::Cautious,
            Some(4),
            None,
        );
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
    #[should_panic(expected = "not what this clone's temperament does")]
    fn a_clone_cannot_stray_from_its_temperament() {
        let mut m = town_with_clone();
        as_caller("bob.testnet", NearToken::from_near(2));
        m.register_clone(acc("clone-1.bob.testnet"), Temperament::Greedy, None, None);
        ring_to_dawn(&mut m);
        open(&mut m);
        as_caller("clone-1.bob.testnet", zero());
        m.trade(0, vec![order("salt", Side::Buy, 1, 1000)]);
    }

    #[test]
    fn a_clone_trades_exactly_as_its_temperament_decides() {
        let mut m = town_with_clone();
        as_caller("bob.testnet", NearToken::from_near(2));
        m.register_clone(acc("clone-1.bob.testnet"), Temperament::Greedy, None, None);
        ring_to_dawn(&mut m);
        open(&mut m);
        let t = m.get_town();
        let book = rules::Book {
            usual: t.hours[0],
            stock: t.hour_stock,
            fee_bps: t.fee_bps,
        };
        let d = rules::decide(
            rules::Temperament::Greedy,
            &rules::View {
                round: 0,
                book,
                prices: book.board(),
                prev: t.prev_prices,
                ledger: rules::Ledger {
                    cash: 2000,
                    stock: [0; 5],
                },
                stake: 2000,
            },
        );
        let orders: Vec<OrderIn> = d
            .intents
            .iter()
            .map(|i| OrderIn {
                good: rules::GOODS[i.good].into(),
                side: if i.side == rules::Side::Buy {
                    Side::Buy
                } else {
                    Side::Sell
                },
                qty: i.qty,
                price: i.limit,
            })
            .collect();
        as_caller("clone-1.bob.testnet", zero());
        assert_eq!(m.trade(0, orders).len(), d.intents.len());
    }

    #[test]
    #[should_panic(expected = "one move an hour")]
    fn a_possessed_clone_makes_one_move() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(
            0,
            vec![
                order("salt", Side::Buy, 1, 30),
                order("grain", Side::Buy, 1, 30),
            ],
        );
    }

    #[test]
    #[should_panic(expected = "starts trading next night")]
    fn a_clone_never_joins_a_night_under_way() {
        let mut m = town_with_clone();
        as_caller("bob.testnet", NearToken::from_near(1));
        m.register_clone(acc("clone-1.bob.testnet"), Temperament::Loyal, None, None);
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
        m.register_clone(
            acc("clone-1.bob.testnet"),
            Temperament::Loyal,
            Some(2),
            None,
        );
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

    // NEP-245: the goods as multi-tokens.

    fn ids(goods: &[&str]) -> Vec<String> {
        goods.iter().map(|g| g.to_string()).collect()
    }

    /// The NEP-245 events in the logs of the last call, parsed.
    fn mt_events() -> Vec<near_sdk::serde_json::Value> {
        near_sdk::test_utils::get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| near_sdk::serde_json::from_str(j).unwrap())
            .collect()
    }

    /// Alice's clone with 3 salt and 5 grain (bought in hour 0), and bob's with 2 salt.
    fn town_with_goods() -> Market {
        let mut m = town_with_clone();
        as_caller("bob.testnet", NearToken::from_near(1));
        m.register_clone(
            acc("clone-2.bob.testnet"),
            Temperament::Possessed,
            None,
            None,
        );
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 3, 30)]);
        ring_to_dawn(&mut m);
        open(&mut m);
        as_clone();
        m.trade(0, vec![order("grain", Side::Buy, 5, 1000)]);
        as_caller("clone-2.bob.testnet", zero());
        m.trade(0, vec![order("salt", Side::Buy, 2, 1000)]);
        m
    }

    #[test]
    fn mt_balance_of_is_a_clones_holding_and_zero_for_anyone_else() {
        let m = town_with_goods();
        let alice = acc("clone-1.alice.testnet");
        assert_eq!(m.mt_balance_of(alice.clone(), "salt".into()), U128(3));
        assert_eq!(m.mt_balance_of(alice.clone(), "grain".into()), U128(5));
        assert_eq!(m.mt_balance_of(alice, "amber".into()), U128(0));
        assert_eq!(
            m.mt_balance_of(acc("alice.testnet"), "salt".into()),
            U128(0),
            "the player holds none"
        );
        assert_eq!(
            m.mt_balance_of(acc("mallory.testnet"), "salt".into()),
            U128(0)
        );
    }

    #[test]
    fn mt_batch_balance_of_reads_each_good() {
        let m = town_with_goods();
        assert_eq!(
            m.mt_batch_balance_of(
                acc("clone-1.alice.testnet"),
                ids(&["grain", "salt", "wool", "iron", "amber"])
            ),
            vec![U128(5), U128(3), U128(0), U128(0), U128(0)]
        );
        assert_eq!(
            m.mt_batch_balance_of(acc("clone-2.bob.testnet"), ids(&["salt"])),
            vec![U128(2)]
        );
    }

    #[test]
    #[should_panic(expected = "unknown good")]
    fn mt_balance_of_an_unknown_good_panics() {
        let m = town_with_goods();
        m.mt_balance_of(acc("clone-1.alice.testnet"), "gold".into());
    }

    #[test]
    fn mt_supply_is_what_the_clones_in_town_hold() {
        let m = town_with_goods();
        assert_eq!(m.mt_supply("salt".into()), Some(U128(5)));
        assert_eq!(m.mt_supply("grain".into()), Some(U128(5)));
        assert_eq!(m.mt_supply("iron".into()), Some(U128(0)));
        assert_eq!(m.mt_supply("gold".into()), None);
        assert_eq!(
            m.mt_batch_supply(ids(&["salt", "gold", "wool"])),
            vec![Some(U128(5)), None, Some(U128(0))]
        );
    }

    #[test]
    fn mt_token_returns_each_good_or_null() {
        let m = town_with_clone();
        let t = m.mt_token(ids(&["amber", "gold"]));
        assert_eq!(t.len(), 2);
        let amber = t[0].clone().unwrap();
        assert_eq!(amber.token_id, "amber");
        assert_eq!(amber.owner_id, None);
        assert_eq!(amber.base_metadata_id, MT_BASE_ID);
        assert_eq!(
            amber.token_metadata.unwrap().title.as_deref(),
            Some("Amber")
        );
        assert_eq!(t[1], None);
    }

    #[test]
    fn mt_tokens_lists_the_five_goods_a_page_at_a_time() {
        let m = town_with_clone();
        let all: Vec<String> = m
            .mt_tokens(None, None)
            .into_iter()
            .map(|t| t.token_id)
            .collect();
        assert_eq!(all, rules::GOODS.map(String::from).to_vec());
        let page: Vec<String> = m
            .mt_tokens(Some(U128(1)), Some(2))
            .into_iter()
            .map(|t| t.token_id)
            .collect();
        assert_eq!(page, ids(&["salt", "wool"]));
        assert!(m.mt_tokens(Some(U128(u128::MAX)), None).is_empty());
    }

    #[test]
    fn mt_tokens_for_owner_lists_only_the_goods_held() {
        let m = town_with_goods();
        let held: Vec<String> = m
            .mt_tokens_for_owner(acc("clone-1.alice.testnet"), None, None)
            .into_iter()
            .map(|t| t.token_id)
            .collect();
        assert_eq!(held, ids(&["grain", "salt"]));
        let second = m.mt_tokens_for_owner(acc("clone-1.alice.testnet"), Some(U128(1)), Some(5));
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].token_id, "salt");
        assert!(m
            .mt_tokens_for_owner(acc("alice.testnet"), None, None)
            .is_empty());
    }

    #[test]
    fn mt_metadata_views_follow_the_standard() {
        let m = town_with_clone();
        let c = m.mt_metadata_contract();
        assert_eq!(
            (c.spec.as_str(), c.name.as_str()),
            ("mt-1.0.0", "Clones market goods")
        );
        let all = m.mt_metadata_token_all(ids(&["grain", "iron"]));
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].base.symbol.as_deref(), Some("GOODS"));
        assert_eq!(all[0].base.id, MT_BASE_ID);
        assert_eq!(all[0].base.decimals.as_deref(), Some("0"));
        assert_eq!(all[1].token.title.as_deref(), Some("Iron"));
        let titles: Vec<Option<String>> = m
            .mt_metadata_token_by_token_id(rules::GOODS.map(String::from).to_vec())
            .into_iter()
            .map(|t| t.title)
            .collect();
        assert_eq!(titles, GOOD_TITLES.map(|t| Some(t.to_string())).to_vec());
        let base = m.mt_metadata_base_by_token_id(ids(&["wool"]));
        assert_eq!(base[0].name, MT_NAME);
        assert_eq!(m.mt_metadata_base_by_metadata_id(ids(&[MT_BASE_ID])), base);
        assert_eq!(m.mt_tokens_base_metadata_all(None, None), base);
        assert!(m
            .mt_tokens_base_metadata_all(Some(U128(1)), None)
            .is_empty());
        // The JSON carries every field of the standard's shapes, null when unset.
        let j = near_sdk::serde_json::to_value(&all[0]).unwrap();
        assert!(j["base"]["base_uri"].is_null());
        assert!(j["token"]["media"].is_null());
        let t = near_sdk::serde_json::to_value(m.mt_token(ids(&["salt"]))).unwrap();
        assert!(t[0]["owner_id"].is_null());
        assert_eq!(t[0]["base_metadata_id"], "goods");
    }

    #[test]
    #[should_panic(expected = "unknown good")]
    fn mt_metadata_of_an_unknown_good_panics() {
        let m = town_with_clone();
        m.mt_metadata_token_by_token_id(ids(&["gold"]));
    }

    #[test]
    #[should_panic(expected = "unknown base metadata id")]
    fn mt_base_metadata_of_an_unknown_id_panics() {
        let m = town_with_clone();
        m.mt_metadata_base_by_metadata_id(ids(&["grain"]));
    }

    #[test]
    #[should_panic(expected = "goods stay at the market")]
    fn a_clone_cannot_mt_transfer_its_goods() {
        let mut m = town_with_goods();
        as_caller("clone-1.alice.testnet", NearToken::from_yoctonear(1));
        m.mt_transfer();
    }

    #[test]
    #[should_panic(expected = "goods stay at the market")]
    fn a_player_cannot_mt_batch_transfer_its_clones_goods() {
        let mut m = town_with_goods();
        as_caller("alice.testnet", NearToken::from_yoctonear(1));
        m.mt_batch_transfer();
    }

    #[test]
    #[should_panic(expected = "goods stay at the market")]
    fn mt_transfer_call_is_refused() {
        let mut m = town_with_goods();
        as_caller("clone-1.alice.testnet", NearToken::from_yoctonear(1));
        let _ = m.mt_transfer_call();
    }

    #[test]
    #[should_panic(expected = "goods stay at the market")]
    fn mt_batch_transfer_call_is_refused() {
        let mut m = town_with_goods();
        as_caller("alice.testnet", NearToken::from_yoctonear(1));
        let _ = m.mt_batch_transfer_call();
    }

    #[test]
    fn a_buy_logs_an_mt_mint_to_the_clone() {
        let mut m = town_with_clone();
        as_clone();
        m.trade(0, vec![order("salt", Side::Buy, 3, 30)]);
        let ev = mt_events();
        assert_eq!(ev.len(), 1);
        assert_eq!(
            ev[0],
            near_sdk::serde_json::json!({
                "standard": "nep245",
                "version": "1.0.0",
                "event": "mt_mint",
                "data": [{
                    "owner_id": "clone-1.alice.testnet",
                    "token_ids": ["salt"],
                    "amounts": ["3"]
                }]
            })
        );
    }

    #[test]
    fn a_sell_logs_an_mt_burn_batching_the_goods() {
        let mut m = town_with_goods();
        as_caller("keeper.testnet", zero());
        m.advance_round(0);
        as_clone();
        m.trade(
            1,
            vec![
                order("salt", Side::Sell, 3, 1),
                order("grain", Side::Sell, 5, 1),
            ],
        );
        let ev = mt_events();
        assert_eq!(ev.len(), 1, "one event for the whole turn");
        assert_eq!(ev[0]["event"], "mt_burn");
        assert_eq!(ev[0]["standard"], "nep245");
        let d = &ev[0]["data"][0];
        assert_eq!(d["owner_id"], "clone-1.alice.testnet");
        assert_eq!(
            d["token_ids"],
            near_sdk::serde_json::json!(["grain", "salt"])
        );
        assert_eq!(d["amounts"], near_sdk::serde_json::json!(["5", "3"]));
        assert_eq!(
            m.mt_supply("salt".into()),
            Some(U128(2)),
            "bob's two remain"
        );
    }

    #[test]
    fn settle_burns_what_the_clone_held() {
        let mut m = town_with_goods();
        ring_to_dawn(&mut m);
        as_caller("alice.testnet", zero());
        let _ = m.settle(acc("clone-1.alice.testnet"));
        let ev = mt_events();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0]["event"], "mt_burn");
        assert_eq!(
            ev[0]["data"][0]["token_ids"],
            near_sdk::serde_json::json!(["grain", "salt"])
        );
        assert_eq!(
            ev[0]["data"][0]["amounts"],
            near_sdk::serde_json::json!(["5", "3"])
        );
        assert_eq!(m.mt_supply("grain".into()), Some(U128(0)));
        assert_eq!(m.mt_supply("salt".into()), Some(U128(2)));
        // A clone with nothing to sell logs no event.
        let mut empty = town_with_clone();
        ring_to_dawn(&mut empty);
        as_caller("alice.testnet", zero());
        let _ = empty.settle(acc("clone-1.alice.testnet"));
        assert!(mt_events().is_empty());
    }

    #[test]
    fn the_town_board_keeps_the_last_forty() {
        as_caller("keeper.testnet", zero());
        let mut m = Market::new(U64(SEED), None, None);
        for i in 0..45 {
            let player = format!("p{i}.testnet");
            as_caller(&player, NearToken::from_millinear(100 + i));
            m.register_clone(
                acc(&format!("clone-1.{player}")),
                Temperament::Loyal,
                None,
                None,
            );
            as_caller(&player, zero());
            let _ = m.settle(acc(&format!("clone-1.{player}")));
        }
        let board = m.get_recent();
        assert_eq!(board.len(), 40);
        assert_eq!(board[0].stake, 105, "oldest kept first");
        assert_eq!(board[39].stake, 144);
    }
}
