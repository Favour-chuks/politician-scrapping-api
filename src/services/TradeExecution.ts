import crypto from 'crypto';
import type { TradeSignal } from '../models/TradeSignal.js';
import { tradingRules } from '../config/tradingRules.js';

export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'open' | 'closed' | 'rejected' | 'pending';

export interface Order {
  id: string;
  signalId: string;
  instrument: string; // e.g. symbol
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: Date;
  closedAt?: Date;
  exitPrice?: number;
  status: OrderStatus;
  pnl?: number;
  metadata?: Record<string, unknown>;
}

export type OrderRequest = {
  signal: TradeSignal;
  instrument: string;
  side: OrderSide;
  quantity?: number; // optional, service may compute size
  stopLoss?: number;
  takeProfit?: number;
  metadata?: Record<string, unknown>;
};

/**
 * BrokerAdapter defines the minimal interface for executing and closing orders.
 * Implement this interface to integrate with a real broker SDK/API.
 */
export interface BrokerAdapter {
  placeOrder(request: {
    instrument: string;
    side: OrderSide;
    quantity: number;
    stopLoss?: number;
    takeProfit?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ orderId: string; filledPrice: number }>; // returns executed order id and fill price

  closeOrder(orderId: string): Promise<{ orderId: string; exitPrice: number }>; // close position
}

/**
 * A simple in-memory broker adapter that simulates fills.
 * Good for testing and local development.
 */
export class SimulatedBrokerAdapter implements BrokerAdapter {
  async placeOrder(request: {
    instrument: string;
    side: OrderSide;
    quantity: number;
    stopLoss?: number;
    takeProfit?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ orderId: string; filledPrice: number }> {
    // simulate a short delay and a market fill at a synthetic price
    await new Promise(r => setTimeout(r, 100));
    const basePrice = 100; // arbitrary base; in real adapter use market price
    // small random slippage
    const slippage = (Math.random() - 0.5) * 0.5;
    const filledPrice = +(basePrice + slippage).toFixed(4);
    return { orderId: crypto.randomUUID(), filledPrice };
  }

  async closeOrder(orderId: string): Promise<{ orderId: string; exitPrice: number }> {
    await new Promise(r => setTimeout(r, 100));
    const exitPrice = +(100 + (Math.random() - 0.5) * 0.5).toFixed(4);
    return { orderId, exitPrice };
  }
}

/**
 * TradeExecutionService executes and manages orders using a BrokerAdapter.
 */
export class TradeExecutionService {
  private adapter: BrokerAdapter;
  // in-memory orders store
  private orders: Map<string, Order> = new Map();

  constructor(adapter?: BrokerAdapter) {
    this.adapter = adapter ?? new SimulatedBrokerAdapter();
  }

  /**
   * Open a trade based on a TradeSignal. Performs basic validation and sizing.
   */
  async openTrade(req: OrderRequest): Promise<Order> {
    const { signal, instrument, side } = req;

    // Basic validation: only approved signals should open trades
    if (signal.validationStatus !== 'approved') {
      throw new Error('Trade signal not approved');
    }

    // Derive quantity if not provided
    const quantity = req.quantity ?? this.deriveQuantity(signal);

    // Pre-check: very small or invalid quantity
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Invalid trade quantity');
    }

    // Place order via adapter
    const placePayload: {
      instrument: string;
      side: OrderSide;
      quantity: number;
      stopLoss?: number;
      takeProfit?: number;
      metadata?: Record<string, unknown>;
    } = {
      instrument,
      side,
      quantity
    };
    if (req.stopLoss !== undefined) placePayload.stopLoss = req.stopLoss;
    if (req.takeProfit !== undefined) placePayload.takeProfit = req.takeProfit;
    if (req.metadata !== undefined) placePayload.metadata = req.metadata;

    const placeResp = await this.adapter.placeOrder(placePayload);

    const order: Order = {
      id: placeResp.orderId,
      signalId: signal.id,
      instrument,
      side,
      quantity,
      entryPrice: placeResp.filledPrice,
      openedAt: new Date(),
      status: 'open'
    };
    if (req.stopLoss !== undefined) order.stopLoss = req.stopLoss;
    if (req.takeProfit !== undefined) order.takeProfit = req.takeProfit;
    if (req.metadata !== undefined) order.metadata = req.metadata;

    this.orders.set(order.id, order);
    return order;
  }

  /**
   * Close an open trade.
   */
  async closeTrade(orderId: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error('Order not open');

    const resp = await this.adapter.closeOrder(orderId);
    order.exitPrice = resp.exitPrice;
    order.closedAt = new Date();
    order.status = 'closed';
    // compute PnL (simple quantity * price difference). Side matters.
    const priceDiff = order.side === 'buy' ? order.exitPrice - order.entryPrice : order.entryPrice - order.exitPrice!;
    order.pnl = +(priceDiff * order.quantity);

    this.orders.set(order.id, order);
    return order;
  }

  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  listOrders(): Order[] {
    return [...this.orders.values()];
  }

  /**
   * Very simple sizing logic based on signal riskLevel. You should replace this with real risk management.
   */
  private deriveQuantity(signal: TradeSignal): number {
    // basic size map: low risk -> larger size, high risk -> small size
    const base = 10; // base units
    switch (signal.riskLevel) {
      case 'low':
        return base * 3;
      case 'medium':
        return base * 2;
      case 'high':
      default:
        return base;
    }
  }
}

export default TradeExecutionService;
