const ccxt = require('ccxt');
const { ichimokucloud, atr, adx } = require('technicalindicators');
const config = require('./config');
require('dotenv').config();
const fs = require('fs');
const express = require('express');

// LOGS GLOBAUX : capte toutes les erreurs fatales et promesses non catchées
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

class IchimokuBot {
  constructor() {
    try {
      this.exchange = new ccxt[config.exchange]({
        apiKey: process.env.BINANCE_API_KEY,
        secret: process.env.BINANCE_API_SECRET,
        enableRateLimit: config.apiSettings.enableRateLimit,
        rateLimit: config.apiSettings.rateLimit,
        timeout: 30000
      });
      console.log('[INIT] Exchange initialisé avec succès');
    } catch (e) {
      console.error('[INIT] Erreur lors de l\'initialisation de l\'exchange:', e);
    }
    this.portfolio = { USDT: config.initialCapital, history: [] };
    config.symbols.forEach(symbol => {
      const asset = symbol.split('/')[0];
      this.portfolio[asset] = 0;
    });
    this.entryPrices = {};
    this.shorts = {};
    this.isRunning = false;
    this.cycleCount = 0;
    this.lastAnalysisErrors = {};
    this.initialCapital = config.initialCapital;
    this.startTime = Date.now();
    this.metrics = {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      maxDrawdown: 0,
      currentDrawdown: 0
    };
    this.lastReadings = {};
  }

  async delay(ms = 1000) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async retryApiCall(apiCall, maxRetries = config.apiSettings.retryAttempts) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        console.error(`[API] Tentative ${attempt} échouée:`, error.message || error);
        if (attempt === maxRetries) throw error;
        await this.delay(config.apiSettings.retryDelay * Math.pow(2, attempt - 1));
      }
    }
  }

  async fetchMultiTimeframeOHLCV(symbol) {
    const results = {};
    for (const tf of config.timeframes) {
      try {
        const apiCall = async () => {
          const ohlcv = await this.exchange.fetchOHLCV(
            symbol,
            tf,
            undefined,
            Math.max(config.ichimoku.spanPeriod * 3, 100)
          );
          if (!ohlcv || ohlcv.length < config.ichimoku.spanPeriod) {
            throw new Error(`Données insuffisantes: ${ohlcv?.length || 0}/${config.ichimoku.spanPeriod}`);
          }
          return ohlcv;
        };
        results[tf] = await this.retryApiCall(apiCall);
        await this.delay(200);
      } catch (e) {
        console.error(`[OHLCV] ${symbol} (${tf}) : ${e.message || e}`);
        throw e;
      }
    }
    return results;
  }

  async validatePrice(symbol, price) {
    try {
      const ticker = await this.retryApiCall(async () => await this.exchange.fetchTicker(symbol));
      const spread = Math.abs(ticker.last - price) / ticker.last * 100;
      if (spread > config.priceValidation.maxSpreadPercent) {
        return { valid: false, reason: 'Écart prix trop important' };
      }
      if (!ticker.quoteVolume || ticker.quoteVolume < config.priceValidation.minVolume) {
        return { valid: false, reason: 'Volume insuffisant' };
      }
      return { valid: true, reason: '' };
    } catch (err) {
      return { valid: false, reason: 'Validation prix échouée' };
    }
  }

  calculateIchimoku(ohlcv) {
    try {
      if (!ohlcv || ohlcv.length < config.ichimoku.spanPeriod) return null;
      return ichimokucloud({
        high: ohlcv.map(c => c[2]),
        low: ohlcv.map(c => c[3]),
        conversionPeriod: config.ichimoku.conversionPeriod,
        basePeriod: config.ichimoku.basePeriod,
        spanPeriod: config.ichimoku.spanPeriod,
        displacement: config.ichimoku.displacement
      });
    } catch (e) {
      return null;
    }
  }

  calculateATR(ohlcv, period = 14) {
    try {
      if (!ohlcv || ohlcv.length < period) return [];
      return atr({
        high: ohlcv.map(c => c[2]),
        low: ohlcv.map(c => c[3]),
        close: ohlcv.map(c => c[4]),
        period
      });
    } catch (e) {
      return [];
    }
  }

  calculateADX(ohlcv, period = 14) {
    try {
      if (!ohlcv || ohlcv.length < period * 2) return [];
      return adx({
        high: ohlcv.map(c => c[2]),
        low: ohlcv.map(c => c[3]),
        close: ohlcv.map(c => c[4]),
        period
      });
    } catch (e) {
      return [];
    }
  }

  isTrending(ohlcv) {
    try {
      const adxValues = this.calculateADX(ohlcv, config.antiRange.adxPeriod);
      const lastAdx = adxValues.length > 0 ? adxValues[adxValues.length - 1].adx : 0;
      if (lastAdx < config.antiRange.adxThreshold) return false;
      const ichimokuData = this.calculateIchimoku(ohlcv);
      if (!ichimokuData || ichimokuData.length === 0) return false;
      const last = ichimokuData[ichimokuData.length - 1];
      const lastClose = ohlcv[ohlcv.length - 1][4];
      return (lastClose > last.spanA && lastClose > last.spanB) ||
             (lastClose < last.spanA && lastClose < last.spanB);
    } catch (e) {
      return false;
    }
  }

  generateSignal(ichimokuData, currentPrice) {
    if (!ichimokuData || ichimokuData.length === 0) return { buy: false, sell: false, short: false };
    try {
      const last = ichimokuData[ichimokuData.length - 1];
      const inCloud = currentPrice > last.spanA && currentPrice > last.spanB;
      return {
        buy: inCloud && currentPrice > last.conversion && last.conversion > last.base,
        sell: !inCloud && currentPrice < last.conversion,
        short: !inCloud && currentPrice < last.conversion && currentPrice < last.spanA
      };
    } catch (e) {
      return { buy: false, sell: false, short: false };
    }
  }

  simulateBreakOfStructureSignal(ohlcv, price) {
    if (!ohlcv || ohlcv.length < 20) return { buy: false, sell: false, confidence: 0 };
    const recentHighs = ohlcv.slice(-10).map(c => c[2]);
    const recentLows = ohlcv.slice(-10).map(c => c[3]);
    const maxHigh = Math.max(...recentHighs);
    const minLow = Math.min(...recentLows);
    const breakoutUp = price > maxHigh;
    const breakoutDown = price < minLow;
    const confidence = breakoutUp || breakoutDown ? 0.8 : 0.3;
    return { buy: breakoutUp, sell: breakoutDown, confidence };
  }

  canOpenNewPosition() {
    const currentPositions = Object.keys(this.entryPrices).length + Object.keys(this.shorts).length;
    return currentPositions < config.maxPositions;
  }

  updateDrawdown() {
    const currentValue = this.getTotalValue();
    const drawdownPercent = (this.initialCapital - currentValue) / this.initialCapital * 100;
    this.metrics.currentDrawdown = Math.max(0, drawdownPercent);
    this.metrics.maxDrawdown = Math.max(this.metrics.maxDrawdown, this.metrics.currentDrawdown);
    if (this.metrics.currentDrawdown > config.maxDrawdown) {
      console.warn('[Drawdown] Max drawdown dépassé, mais on continue le bot');
    }
    return true;
  }

  updateTrailingStop(asset, currentPrice, atrValue) {
    if (!this.entryPrices[asset]) return;
    if (currentPrice > this.entryPrices[asset].highest) {
      this.entryPrices[asset].highest = currentPrice;
      this.entryPrices[asset].trailingStop = currentPrice - config.trailing.atrMultiplier * atrValue;
    }
  }

  getDynamicRisk(atrValue) {
    if (!atrValue) return config.riskPercentage;
    if (atrValue > config.dynamicSizing.atrThreshold) {
      return config.riskPercentage * config.dynamicSizing.riskReduction;
    }
    return config.riskPercentage;
  }

  async executeVirtualTrade(symbol, signal, price, atrValue = 0, customRisk = null) {
    const asset = symbol.split('/')[0];
    const minTradeUSD = 10;
    const strategy = signal.strategyTag || signal.strategy || 'Ichimoku';

    // Validation prix
    const validation = await this.validatePrice(symbol, price);
    if (!validation.valid) {
      this.lastReadings[symbol].tradeBlockReason = validation.reason;
      return;
    }

    // Taille min trade
    const dynamicRisk = this.getDynamicRisk(atrValue);
    const maxAmount = this.portfolio.USDT * (dynamicRisk / 100);
    if (maxAmount < minTradeUSD) {
      this.lastReadings[symbol].tradeBlockReason = 'Montant trop faible pour trade';
      return;
    }

    // Position déjà ouverte
    if (signal.short && this.shorts[asset]) {
      this.lastReadings[symbol].tradeBlockReason = `Position déjà ouverte sur ${symbol}`;
      return;
    }
    if (signal.buy && this.entryPrices[asset]) {
      this.lastReadings[symbol].tradeBlockReason = `Position déjà ouverte sur ${symbol}`;
      return;
    }

    // Peut-on ouvrir une nouvelle position ?
    if (!this.canOpenNewPosition()) {
      this.lastReadings[symbol].tradeBlockReason = 'Trop de positions ouvertes';
      return;
    }

    this.lastReadings[symbol].tradeBlockReason = '';

    // --- OUVERTURE TRADE ---
    if (signal.buy) {
      const amount = maxAmount / price;
      if (amount > 0 && this.portfolio.USDT >= maxAmount) {
        this.portfolio[asset] += amount * 0.999;
        this.portfolio.USDT -= maxAmount;
        const feeRate = 0.001;
        const targetTP1 = price * (1 + 0.02 + feeRate * 2);
        const tp1 = Math.max(targetTP1, price + 1 * atrValue);
        const targetTP2 = price * 1.2;
        const tp2 = Math.max(targetTP2, price + 2 * atrValue);
        const stopLoss = price - config.stopLoss.atrMultiplier * atrValue;
        const trailingStop = price - config.trailing.atrMultiplier * atrValue;
        this.entryPrices[asset] = {
          price,
          atr: atrValue,
          stopLoss,
          trailingStop,
          tp1,
          tp2,
          highest: price,
          qty: amount,
          tp1Done: false,
          entryTime: new Date(),
          strategy
        };
        this.metrics.totalTrades++;
        this.logTransaction(symbol, 'BUY', amount, price, null, strategy);
      }
    }
    if (signal.sell && this.portfolio[asset] > 0) {
      const entry = this.entryPrices[asset];
      const sellValue = this.portfolio[asset] * price * 0.999;
      this.portfolio.USDT += sellValue;
      if (entry) {
        const pnl = sellValue - (entry.qty * entry.price);
        this.logTransaction(symbol, 'SELL', this.portfolio[asset], price, pnl, entry.strategy);
        if (pnl > 0) this.metrics.winningTrades++;
        else this.metrics.losingTrades++;
      } else {
        this.logTransaction(symbol, 'SELL', this.portfolio[asset], price, null, strategy);
      }
      this.portfolio[asset] = 0;
      delete this.entryPrices[asset];
    }
    if (signal.short && !this.shorts[asset]) {
      const amount = maxAmount / price;
      if (amount > 0 && this.portfolio.USDT >= maxAmount) {
        this.shorts[asset] = {
          price,
          atr: atrValue,
          qty: amount,
          stopLoss: price + config.stopLoss.atrMultiplier * atrValue,
          tp1: price - 1 * atrValue,
          tp2: price - 2 * atrValue,
          tp1Done: false,
          entryTime: new Date(),
          strategy
        };
        this.portfolio.USDT -= maxAmount;
        this.metrics.totalTrades++;
        this.logTransaction(symbol, 'SHORT', amount, price, null, strategy);
      }
    }
  }

  async checkPartialTakeProfit(symbol, currentPrice) {
    const asset = symbol.split('/')[0];
    const entry = this.entryPrices[asset];
    if (!entry || this.portfolio[asset] === 0) return;
    try {
      if (!entry.tp1Done && currentPrice >= entry.tp1) {
        const qtyToSell = entry.qty * 0.5;
        this.portfolio.USDT += qtyToSell * currentPrice * 0.999;
        this.portfolio[asset] -= qtyToSell;
        entry.tp1Done = true;
        const pnl = qtyToSell * (currentPrice - entry.price);
        this.metrics.winningTrades++;
        this.logTransaction(symbol, 'TP1', qtyToSell, currentPrice, pnl, entry.strategy);
      }
      if (entry.tp1Done && currentPrice >= entry.tp2 && this.portfolio[asset] > 0) {
        const qtyToSell = this.portfolio[asset];
        this.portfolio.USDT += qtyToSell * currentPrice * 0.999;
        this.portfolio[asset] = 0;
        const pnl = qtyToSell * (currentPrice - entry.price);
        this.metrics.winningTrades++;
        this.logTransaction(symbol, 'TP2', qtyToSell, currentPrice, pnl, entry.strategy);
        delete this.entryPrices[asset];
      }
    } catch (error) {}
  }

  async checkPartialTakeProfitShort(symbol, currentPrice) {
    const asset = symbol.split('/')[0];
    const short = this.shorts[asset];
    if (!short || short.qty === 0) return;
    try {
      if (!short.tp1Done && currentPrice <= short.tp1) {
        const qtyToCover = short.qty * 0.5;
        this.portfolio.USDT += qtyToCover * (short.price - currentPrice);
        short.qty -= qtyToCover;
        short.tp1Done = true;
        const pnl = qtyToCover * (short.price - currentPrice);
        this.metrics.winningTrades++;
        this.logTransaction(symbol, 'COVER1', qtyToCover, currentPrice, pnl, short.strategy);
      }
      if (short.tp1Done && currentPrice <= short.tp2 && short.qty > 0) {
        const qtyToCover = short.qty;
        this.portfolio.USDT += qtyToCover * (short.price - currentPrice);
        short.qty = 0;
        const pnl = qtyToCover * (short.price - currentPrice);
        this.metrics.winningTrades++;
        this.logTransaction(symbol, 'COVER2', qtyToCover, currentPrice, pnl, short.strategy);
        delete this.shorts[asset];
      }
    } catch (error) {}
  }

  logTransaction(symbol, type, amount, price, pnl = null, strategy = null) {
    const portfolioCopy = { ...this.portfolio };
    delete portfolioCopy.history;
    const logEntry = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      symbol,
      type,
      amount: parseFloat(amount.toFixed(6)),
      price: parseFloat(price.toFixed(6)),
      value: parseFloat((amount * price).toFixed(2)),
      pnl: pnl ? parseFloat(pnl.toFixed(2)) : null,
      portfolio: portfolioCopy,
      totalValue: this.getTotalValue(),
      drawdown: this.metrics.currentDrawdown,
      strategy
    };
    this.portfolio.history.push(logEntry);
    try {
      fs.appendFileSync('transactions.log', JSON.stringify(logEntry) + '\n');
    } catch (e) {}
  }

  async analyzeSymbol(symbol) {
    try {
      let ichimokuStatus = '-', bosStatus = '-';
      let ichimokuReason = '', bosReason = '', tradeBlockReason = '';
      let currentPrice = null;
      try {
        const ohlcvs = await this.fetchMultiTimeframeOHLCV(symbol);
        if (!ohlcvs['15m'] || ohlcvs['15m'].length === 0) {
          this.lastReadings[symbol] = {
            value: 'sans',
            timestamp: null,
            ichimoku: '-',
            ichimokuReason: '',
            bos: '-',
            bosReason: '',
            tradeBlockReason: 'Erreur API ou données'
          };
          return null;
        }
        currentPrice = ohlcvs['15m'][ohlcvs['15m'].length - 1][4];

        const ichimokuData = this.calculateIchimoku(ohlcvs['1h']);
        let ichimokuSignal = { buy: false, short: false };
        if (!ichimokuData || ichimokuData.length === 0) {
          ichimokuStatus = 'NON';
          ichimokuReason = 'pas de données';
        } else {
          ichimokuSignal = this.generateSignal(ichimokuData, currentPrice);
          const last = ichimokuData[ichimokuData.length - 1];
          if (ichimokuSignal.buy) {
            ichimokuStatus = 'OUI (long)';
            ichimokuReason = 'prix au-dessus nuage et croisement';
          } else if (ichimokuSignal.short) {
            ichimokuStatus = 'OUI (short)';
            ichimokuReason = 'prix sous nuage';
          } else {
            ichimokuStatus = 'NON';
            ichimokuReason = 'autre';
          }
        }

        const bosSignal = this.simulateBreakOfStructureSignal(ohlcvs['1h'], currentPrice);
        if (bosSignal.buy && bosSignal.confidence >= 0.7) {
          bosStatus = 'OUI';
          bosReason = 'breakout validé';
        } else {
          bosStatus = 'NON';
          bosReason = 'pas de breakout';
        }

        tradeBlockReason = '';
        const asset = symbol.split('/')[0];
        if (ichimokuSignal.short && this.shorts[asset]) {
          tradeBlockReason = `Position déjà ouverte sur ${symbol}`;
        }
        if (ichimokuSignal.buy && this.entryPrices[asset]) {
          tradeBlockReason = `Position déjà ouverte sur ${symbol}`;
        }

        const atrValues = this.calculateATR(ohlcvs['1h'], config.stopLoss.atrPeriod);
        const currentATR = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
        const validation = await this.validatePrice(symbol, currentPrice);
        if (!validation.valid) {
          tradeBlockReason = validation.reason;
        }
        const minTradeUSD = 10;
        const dynamicRisk = this.getDynamicRisk(currentATR);
        const maxAmount = this.portfolio.USDT * (dynamicRisk / 100);
        if (maxAmount < minTradeUSD) {
          tradeBlockReason = 'Montant trop faible pour trade';
        }
        if (!this.canOpenNewPosition()) {
          tradeBlockReason = 'Trop de positions ouvertes';
        }

        this.lastReadings[symbol] = {
          value: currentPrice,
          timestamp: new Date(),
          ichimoku: ichimokuStatus,
          ichimokuReason,
          bos: bosStatus,
          bosReason,
          tradeBlockReason
        };

        if (!this.isTrending(ohlcvs['1d'])) return null;
        if (this.entryPrices[asset]) {
          await this.checkPartialTakeProfit(symbol, currentPrice);
          if (this.entryPrices[asset]) {
            this.updateTrailingStop(asset, currentPrice, currentATR);
            if (currentPrice <= this.entryPrices[asset].trailingStop) {
              const sellValue = this.portfolio[asset] * currentPrice * 0.999;
              this.portfolio.USDT += sellValue;
              const pnl = sellValue - (this.entryPrices[asset].qty * this.entryPrices[asset].price);
              this.logTransaction(symbol, 'TRAILING_STOP', this.portfolio[asset], currentPrice, pnl, this.entryPrices[asset].strategy);
              this.portfolio[asset] = 0;
              delete this.entryPrices[asset];
            }
          }
          return null;
        }
        if (this.shorts[asset]) {
          await this.checkPartialTakeProfitShort(symbol, currentPrice);
          return null;
        }

        if (!tradeBlockReason) {
          if (ichimokuSignal.buy) {
            await this.executeVirtualTrade(symbol, { buy: true, strategyTag: 'Ichimoku' }, currentPrice, currentATR, config.riskPercentage);
          }
          if (bosSignal.buy && bosSignal.confidence >= 0.7) {
            await this.executeVirtualTrade(symbol, { buy: true, strategyTag: 'BoS' }, currentPrice, currentATR, config.riskPercentage);
          }
          if (ichimokuSignal.short) {
            await this.executeVirtualTrade(symbol, { short: true, strategyTag: 'Ichimoku' }, currentPrice, currentATR, config.riskPercentage);
          }
        }
        return { symbol, price: currentPrice, atr: currentATR, signal: { ...ichimokuSignal, bos: bosSignal } };
      } catch (err) {
        this.lastReadings[symbol] = {
          value: 'sans',
          timestamp: null,
          ichimoku: '-',
          ichimokuReason: '',
          bos: '-',
          bosReason: '',
          tradeBlockReason: 'Erreur API ou données'
        };
        return null;
      }
    } catch (error) {
      return null;
    }
  }

  getTotalValue() {
    let total = this.portfolio.USDT;
    Object.keys(this.entryPrices).forEach(asset => {
      total += this.portfolio[asset] * this.entryPrices[asset].price;
    });
    return total;
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      cycleCount: this.cycleCount,
      portfolio: { ...this.portfolio },
      totalValue: this.getTotalValue(),
      usdtBalance: this.portfolio.USDT,
      activePositions: Object.keys(this.entryPrices).length + Object.keys(this.shorts).length,
      longPositions: Object.keys(this.entryPrices).length,
      shortPositions: Object.keys(this.shorts).length,
      lastUpdate: new Date().toISOString(),
      uptime: Date.now() - (this.startTime || Date.now()),
      openPositions: Object.keys(this.entryPrices).length,
      lastErrors: this.lastAnalysisErrors,
      symbols: config.symbols,
      metrics: {
        ...this.metrics,
        winRate: (this.metrics.winningTrades + this.metrics.losingTrades) > 0 ?
          (this.metrics.winningTrades / (this.metrics.winningTrades + this.metrics.losingTrades)) * 100 : 0
      },
      config: {
        riskPercentage: config.riskPercentage,
        maxPositions: config.maxPositions,
        maxDrawdown: config.maxDrawdown,
        cycleInterval: config.cycleInterval
      }
    };
  }

  getPositions() {
    const positions = [];
    for (const [asset, entry] of Object.entries(this.entryPrices)) {
      const symbol = `${asset}/USDT`;
      const currentPrice = this.lastReadings[symbol]?.value || entry.highest || entry.price;
      const pnl = (currentPrice - entry.price) * entry.qty;
      const pnlPercent = ((currentPrice - entry.price) / entry.price) * 100;
      positions.push({
        symbol,
        type: 'LONG',
        entryPrice: entry.price,
        currentPrice,
        quantity: entry.qty,
        pnl,
        pnlPercent,
        entryTime: entry.entryTime ? entry.entryTime.toISOString() : new Date().toISOString(),
        stopLoss: entry.stopLoss,
        tp1: entry.tp1,
        tp2: entry.tp2,
        strategy: entry.strategy || 'Non spécifié'
      });
    }
    for (const [asset, short] of Object.entries(this.shorts)) {
      const symbol = `${asset}/USDT`;
      const currentPrice = this.lastReadings[symbol]?.value || short.price;
      const pnl = (short.price - currentPrice) * short.qty;
      const pnlPercent = ((short.price - currentPrice) / short.price) * 100;
      positions.push({
        symbol,
        type: 'SHORT',
        entryPrice: short.price,
        currentPrice,
        quantity: short.qty,
        pnl,
        pnlPercent,
        entryTime: short.entryTime ? short.entryTime.toISOString() : new Date().toISOString(),
        stopLoss: short.stopLoss,
        tp1: short.tp1,
        tp2: short.tp2,
        strategy: short.strategy || 'Non spécifié'
      });
    }
    return positions;
  }

  getTransactions() {
    try {
      if (fs.existsSync('transactions.log')) {
        const logContent = fs.readFileSync('transactions.log', 'utf8');
        const transactions = logContent
          .split('\n')
          .filter(line => line.trim())
          .map(line => {
            try { return JSON.parse(line); } catch { return null; }
          })
          .filter(t => t !== null)
          .slice(-50)
          .reverse();
        return transactions;
      }
    } catch (e) {}
    if (this.portfolio.history && this.portfolio.history.length > 0) {
      return this.portfolio.history.slice(-50).reverse();
    }
    return [];
  }

  async runCycle() {
    if (!this.isRunning) return;
    this.updateDrawdown();
    const analysisPromises = config.symbols.map(symbol => this.analyzeSymbol(symbol));
    await Promise.allSettled(analysisPromises);
    this.cycleCount++;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startTime = Date.now();
    while (this.isRunning) {
      try {
        await this.runCycle();
        if (this.isRunning) await this.delay(config.cycleInterval);
      } catch (e) {
        await this.delay(5000);
      }
    }
  }

  stop() {
    this.isRunning = false;
  }
}

// EXPRESS SERVER
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Pour parser les formulaires POST
app.use(express.static('public'));
let bot = null;

app.get('/transactions/view', (req, res) => {
  try {
    let transactions = [];
    if (bot) transactions = bot.getTransactions();
    else if (fs.existsSync('transactions.log')) {
      const logContent = fs.readFileSync('transactions.log', 'utf8');
      transactions = logContent
        .split('\n')
        .filter(line => line.trim())
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(t => t !== null)
        .slice(-100)
        .reverse();
    }
    const symbols = config.symbols;
    const readingsTable = `
      <h2>📋 Dernières lectures des symboles</h2>
      <table border="1" cellpadding="6" style="background:#222;color:#fff;border-collapse:collapse;">
        <tr>
          <th>Symbole</th>
          <th>Dernière lecture</th>
          <th>Valeur relevée</th>
          <th>Ichimoku</th>
          <th>Raison Ichimoku</th>
          <th>BoS</th>
          <th>Raison BoS</th>
          <th>Blocage Ouverture</th>
        </tr>
        ${
          symbols.map(sym => {
            const reading = bot && bot.lastReadings && bot.lastReadings[sym];
            return `<tr>
              <td>${sym}</td>
              <td>${reading && reading.timestamp ? new Date(reading.timestamp).toLocaleString('fr-FR') : 'sans'}</td>
              <td>${reading && reading.value !== undefined ? reading.value : 'sans'}</td>
              <td style="text-align:center;">
                ${
                  reading && reading.ichimoku === 'OUI (long)' ? '🟢 OUI (long)' :
                  reading && reading.ichimoku === 'OUI (short)' ? '🟣 OUI (short)' :
                  (reading && reading.ichimoku === 'NON' ? '❌ NON' : '-')
                }
              </td>
              <td style="text-align:center;">
                ${reading && reading.ichimokuReason ? reading.ichimokuReason : '-'}
              </td>
              <td style="text-align:center;">
                ${
                  reading && reading.bos === 'OUI' ? '🟢 OUI' :
                  (reading && reading.bos === 'NON' ? '❌ NON' : '-')
                }
              </td>
              <td style="text-align:center;">
                ${reading && reading.bosReason ? reading.bosReason : '-'}
              </td>
              <td style="text-align:center;">
                ${reading && reading.tradeBlockReason ? reading.tradeBlockReason : '-'}
              </td>
</tr>`;
          }).join('')
        }
      </table>
    `;
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Transactions Bot Ichimoku</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #1a1a1a; color: #fff; }
            h1 { color: #4CAF50; text-align: center; }
            .summary { background: #2d2d2d; padding: 15px; margin: 20px 0; border-radius: 8px; }
            .transaction { background: #333; margin: 10px 0; padding: 15px; border-radius: 8px; border-left: 4px solid #4CAF50; }
            .transaction.loss { border-left-color: #f44336; }
            .profit { color: #4CAF50; font-weight: bold; }
            .loss { color: #f44336; font-weight: bold; }
            .symbol { font-weight: bold; color: #2196F3; }
            .type { padding: 2px 6px; border-radius: 4px; font-size: 12px; }
            .type.BUY { background: #4CAF50; }
            .type.SELL { background: #f44336; }
            .type.SHORT { background: #ff9800; }
            .type.COVER1, .type.COVER2, .type.COVER-FORCE { background: #9c27b0; }
            .type.TP1, .type.TP2 { background: #4CAF50; }
            .timestamp { color: #888; font-size: 12px; }
            .positions { background: #2d2d2d; padding: 15px; margin: 20px 0; border-radius: 8px; }
            .position { background: #444; margin: 5px 0; padding: 10px; border-radius: 4px; }
            .position.long { border-left: 3px solid #4CAF50; }
            .position.short { border-left: 3px solid #ff9800; }
            .strategy { color: #00bfff; font-weight: bold; }
            table { margin-bottom: 30px; }
            form.force-sell { display: inline; }
            button.force-sell-btn { margin-left: 10px; background: #f44336; color: #fff; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
            button.force-sell-btn:hover { background: #c62828; }
        </style>
    </head>
    <body>
        <h1>🤖 Bot Ichimoku - Transactions & Positions</h1>
        ${readingsTable}
        ${bot ? `
        <div class="summary">
            <h2>📊 Statut du Bot</h2>
            <p><strong>État:</strong> ${bot.getStatus().isRunning ? '🟢 Actif' : '🔴 Arrêté'}</p>
            <p><strong>Cycles:</strong> ${bot.getStatus().cycleCount}</p>
            <p><strong>Capital:</strong> ${bot.getStatus().totalValue.toFixed(2)} USDT</p>
            <p><strong>Positions actives:</strong> ${bot.getStatus().activePositions}</p>
            <p><strong>Taux de réussite:</strong> ${bot.getStatus().metrics.winRate.toFixed(2)}%</p>
        </div>
        <div class="positions">
            <h2>🎯 Positions Actives</h2>
            ${bot.getPositions().length > 0 ? 
              bot.getPositions().map(pos => `
                <div class="position ${pos.type.toLowerCase()}">
                    <strong>${pos.symbol}</strong> - ${pos.type} 
                    <span class="type ${pos.type}">${pos.type}</span><br>
                    Prix d'entrée: ${pos.entryPrice.toFixed(6)} | 
                    Prix actuel: ${pos.currentPrice.toFixed(6)} | 
                    Quantité: ${pos.quantity.toFixed(6)}<br>
                    TP1: ${(pos.tp1).toFixed(6)} | TP2: ${(pos.tp2).toFixed(6)}<br>
                    PnL: <span class="${pos.pnl >= 0 ? 'profit' : 'loss'}">${pos.pnl.toFixed(2)} USDT (${pos.pnlPercent.toFixed(2)}%)</span><br>
                    <span class="strategy">Stratégie: ${pos.strategy || 'Non spécifié'}</span>
                    <form class="force-sell" method="POST" action="/api/close-position">
                      <input type="hidden" name="symbol" value="${pos.symbol}">
                      <button type="submit" class="force-sell-btn">Forcer la vente</button>
                    </form>
                </div>
              `).join('') 
              : '<p>Aucune position active</p>'
            }
        </div>
        ` : ''}
        <div class="summary">
            <h2>📈 Historique des Transactions (${transactions.length})</h2>
            ${transactions.length === 0 ? '<p>Aucune transaction trouvée</p>' : ''}
        </div>
        ${transactions.map(tx => `
            <div class="transaction ${tx.pnl && tx.pnl < 0 ? 'loss' : ''}">
                <div class="timestamp">${new Date(tx.timestamp).toLocaleString('fr-FR')}</div>
                <div>
                    <span class="symbol">${tx.symbol}</span> 
                    <span class="type ${tx.type}">${tx.type}</span>
                    ${tx.amount} @ ${tx.price} USDT
                    ${tx.pnl !== null ? `<span class="${tx.pnl >= 0 ? 'profit' : 'loss'}"> | PnL: ${tx.pnl.toFixed(2)} USDT</span>` : ''}
                </div>
                <div style="font-size: 12px; color: #888;">
                    Valeur: ${(tx.amount * tx.price).toFixed(2)} USDT | 
                    Total Portfolio: ${tx.totalValue ? tx.totalValue.toFixed(2) : 'N/A'} USDT<br>
                    <span class="strategy">Stratégie: ${tx.strategy || 'Non spécifié'}</span>
                </div>
            </div>
        `).join('')}
        <script>
            setTimeout(() => location.reload(), 30000);
        </script>
    </body>
    </html>
    `;
    res.send(html);
  } catch (error) {
    res.status(500).send(`Erreur: ${error.message}`);
  }
});

app.post('/api/close-position', (req, res) => {
  const symbol = req.body.symbol;
  if (!bot || !symbol) return res.status(400).json({ error: 'Bot ou symbole manquant' });

  const asset = symbol.split('/')[0];

  // Si LONG, vendre immédiatement
  if (bot.entryPrices[asset] && bot.portfolio[asset] > 0) {
    const price = bot.lastReadings[symbol]?.value || bot.entryPrices[asset].price;
    bot.executeVirtualTrade(symbol, { sell: true }, price, bot.entryPrices[asset].atr, bot.entryPrices[asset].strategy);
    return res.redirect('/transactions/view');
  }
  // Si SHORT, couvrir immédiatement
  if (bot.shorts[asset] && bot.shorts[asset].qty > 0) {
    const price = bot.lastReadings[symbol]?.value || bot.shorts[asset].price;
    const qtyToCover = bot.shorts[asset].qty;
    bot.portfolio.USDT += qtyToCover * (bot.shorts[asset].price - price);
    bot.logTransaction(symbol, 'COVER-FORCE', qtyToCover, price, qtyToCover * (bot.shorts[asset].price - price), bot.shorts[asset].strategy);
    delete bot.shorts[asset];
    return res.redirect('/transactions/view');
  }
  return res.redirect('/transactions/view');
});

app.get('/api/status', (req, res) => { if (!bot) return res.json({ isRunning: false }); res.json(bot.getStatus()); });
app.get('/api/positions', (req, res) => { if (!bot) return res.json([]); res.json(bot.getPositions()); });
app.get('/api/transactions', (req, res) => { if (!bot) return res.json([]); res.json(bot.getTransactions()); });

app.post('/api/start', async (req, res) => {
  try {
    if (bot && bot.isRunning) return res.json({ error: 'Bot déjà en cours' });
    bot = new IchimokuBot();
    await bot.start();
    res.json({ success: true, message: 'Bot démarré' });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/api/stop', (req, res) => {
  if (bot) { bot.stop(); res.json({ success: true, message: 'Bot arrêté' }); }
  else res.json({ error: 'Aucun bot en cours' });
});

async function main() {
  bot = new IchimokuBot();
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Serveur web démarré sur le port ${PORT}`);
    console.log(`📊 Interface: http://localhost:${PORT}/transactions/view`);
  });
  process.on('SIGINT', () => { if (bot) bot.stop(); });
  try { await bot.start(); } catch (e) {}
}

if (require.main === module) {
  main().catch(error => {});
}

module.exports = IchimokuBot;
