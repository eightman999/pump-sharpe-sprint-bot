import { runBot, LAMPORTS_PER_SOL, BPS } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const TAPE_LEN = 20;
const MIN_REAL_RESERVES = 2n * LAMPORTS_PER_SOL;
const MAX_REAL_RESERVES = 50n * LAMPORTS_PER_SOL;
const BUY_QUOTE = LAMPORTS_PER_SOL / 40n; // 0.025 SOL
const MIN_BUY_QUOTE = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
const FEE_RESERVE = LAMPORTS_PER_SOL / 200n; // 0.005 SOL kept back for fees
const FLAT_SLOTS = 6000;
const SLIPPAGE_BUY = 2000;
const SLIPPAGE_TP = 1500;
const SLIPPAGE_SL = 10000;
const SLIPPAGE_FLAT = 2000;

interface TapeTrade {
  buy: boolean;
  sol: bigint;
}

interface Tape {
  trades: TapeTrade[];
  feeBps: bigint | null;
}

const tapes = new Map<Pubkey, Tape>();
const everHeld = new Set<Pubkey>();
const entrySlot = new Map<Pubkey, number>();

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const txFee = state.txFeeLamports();
  const fallbackFeeBps =
    BigInt(state.hello.fees.protocol_bps_fallback) + BigInt(state.hello.fees.creator_bps_fallback);
  const orderCap = state.hello.caps.max_orders_per_batch;

  for (const f of batch.fills) {
    if (f.side === 'buy' && f.status === 'filled') {
      everHeld.add(f.mint);
      entrySlot.set(f.mint, f.slot);
    }
  }
  for (const mint of entrySlot.keys()) {
    if (!state.positions.has(mint)) entrySlot.delete(mint);
  }

  const traded = new Map<Pubkey, true>();
  for (const e of batch.events) {
    if (e.event === 'TradeEvent') {
      let tape = tapes.get(e.mint);
      if (tape === undefined) {
        tape = { trades: [], feeBps: null };
        tapes.set(e.mint, tape);
      }
      tape.trades.push({ buy: e.is_buy, sol: BigInt(e.sol_amount) });
      if (tape.trades.length > TAPE_LEN) tape.trades.shift();
      tape.feeBps = BigInt(e.fee_basis_points) + BigInt(e.creator_fee_basis_points);
      traded.set(e.mint, true);
    } else if (e.event === 'CreateEvent' && !tapes.has(e.mint)) {
      tapes.set(e.mint, { trades: [], feeBps: null });
    }
  }

  const pendingBuy = new Set<Pubkey>();
  const pendingSell = new Set<Pubkey>();
  for (const p of state.pending.values()) {
    (p.order.side === 'buy' ? pendingBuy : pendingSell).add(p.order.mint);
  }

  const orders: OrderInput[] = [];

  // exits before entries
  for (const [mint, hold] of state.positions) {
    if (orders.length >= orderCap) break;
    if (pendingSell.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete || curve.real_quote_reserves === 0n) continue;

    let feeBps = tapes.get(mint)?.feeBps ?? fallbackFeeBps;
    if (feeBps > BPS) feeBps = BPS;
    const tokens = hold.token_amount;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    const gross = (vq * tokens) / (vt + tokens);
    const mark = (gross * (BPS - feeBps)) / BPS - txFee;
    const basis = hold.cost_lamports + txFee;

    let slippage = 0;
    if (mark * 100n >= basis * 125n) slippage = SLIPPAGE_TP;
    else if (mark * 100n <= basis * 88n) slippage = SLIPPAGE_SL;
    else if (state.slot - (entrySlot.get(mint) ?? state.slot) >= FLAT_SLOTS) slippage = SLIPPAGE_FLAT;
    if (slippage === 0) continue;

    // clip the sell to what real reserves can pay, keeping 10% headroom
    const target = (curve.real_quote_reserves * 9n) / 10n;
    let amount = tokens;
    if (vq > target) {
      const maxTokens = (target * vt) / (vq - target);
      if (maxTokens < amount) amount = maxTokens;
    }
    if (amount <= 0n) continue;
    orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: slippage });
  }

  const maxPositions = state.hello.caps.max_open_positions;
  const free0 = state.freeCashLamports();
  let reserved = 0n;
  let added = 0;
  for (const mint of traded.keys()) {
    if (orders.length >= orderCap) break;
    if (state.committedPositionCount() + added >= maxPositions) break;
    if (everHeld.has(mint) || state.positions.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.real_quote_reserves < MIN_REAL_RESERVES || curve.real_quote_reserves > MAX_REAL_RESERVES) continue;
    const tape = tapes.get(mint);
    if (tape === undefined) continue;
    let buys = 0;
    let buySol = 0n;
    let sellSol = 0n;
    for (const tr of tape.trades) {
      if (tr.buy) {
        buys++;
        buySol += tr.sol;
      } else {
        sellSol += tr.sol;
      }
    }
    if (buys < 3) continue;
    if (buySol * 2n < sellSol * 3n) continue; // buy SOL >= 1.5x sell SOL
    let quote = state.maxBuyLamports(mint);
    if (quote > BUY_QUOTE) quote = BUY_QUOTE;
    if (quote < MIN_BUY_QUOTE) continue;
    if (free0 - reserved < quote + txFee + FEE_RESERVE) continue;
    orders.push({ side: 'buy', mint, quote_lamports: quote, max_slippage_bps: SLIPPAGE_BUY });
    added++;
    reserved += quote + txFee;
  }

  return orders;
}

await runBot({ onBatch });
