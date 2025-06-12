const ccxt = require('ccxt');
const { ichimokucloud, atr, adx } = require('technicalindicators');
const config = require('./config');
require('dotenv').config();
const fs = require('fs');
const express = require('express');

class IchimokuBot {
  constructor() {
    this.exchange = new ccxt[config.exchange]({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET,
      enableRateLimit: config.apiSettings.enableRateLimit,
      rateLimit: config.apiSettings.rateLimit,
      timeout: 30000
    });
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
  }

  async delay(ms = 1000) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async retryApiCall(apiCall, maxRetries = config.apiSettings.retryAttempts) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        if (attempt === maxRetries) throw error;
        await this.delay(config.apiSettings.retryDelay * Math.pow(2, attempt - 1));
      }
    }
  }

  async fetchMultiTimeframeOHLCV(symbol) {
    const results = {};
    for (const tf of config.timeframes) {
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
    }
    return results;
  }

  async validatePrice(symbol, price) {
    try {
      const ticker = await this.retryApiCall(async () => await this.exchange.fetchTicker(symbol));
      const spread = Math.abs(ticker.last - price) / ticker.last * 100;
      if (spread > config.priceValidation.maxSpreadPercent) return false;
      if (ticker.baseVolume < config.priceValidation.minVolume) return false;
      return true;
    } catch {
      return false;
    }
  }

  calculateIchimoku(ohlcv) {
    if (!ohlcv || ohlcv.length < config.ichimoku.spanPeriod) return null;
    try {
      return ichimokucloud({
        high: ohlcv.map(c => c[2]),
        low: ohlcv.map(c => c[3]),
        conversionPeriod: config.ichimoku.conversionPeriod,
        basePeriod: config.ichimoku.basePeriod,
        spanPeriod: config.ichimoku.spanPeriod,
        displacement: config.ichimoku.displacement
      });
    } catch {
      return null;
    }
  }

  calculateATR(ohlcv, period = 14) {
    if (!ohlcv || ohlcv.length < period) return [];
    try {
      return atr({
        high: ohlcv.map(c => c[2]),
        low: ohlcv.map(c => c[3]),
        close: ohlcv.map(c => c[4]),
        period
      });
    } catch {
      return [];
    }
  }

  calculateADX(ohlcv, period = 14) {
    if (!ohlcv || ohlcv.length < period * 2) return [];
    try {
      return adx({
        high: ohlcv.map(c => c[2]),
        low: ohlcv.map(c => c[3]),
        close: ohlcv.map(c => c[4]),
        period
      });
    } catch {
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
    } catch {
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
    } catch {
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
      this.stop();
      return false;
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
    if (!(await this.validatePrice(symbol, price))) return;
    const strategy = signal.strategyTag || signal.strategy || 'Ichimoku';
    if (signal.buy) {
      if (this.entryPrices[asset] || !this.canOpenNewPosition()) return;
      const dynamicRisk = this.getDynamicRisk(atrValue);
      const maxAmount = this.portfolio.USDT * (dynamicRisk / 100);
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
    if (signal.short && !this.shorts[asset] && this.canOpenNewPosition()) {
      const dynamicRisk = this.getDynamicRisk(atrValue);
      const maxAmount = this.portfolio.USDT * (dynamicRisk / 100);
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
       // this.portfolio.USDT += amount * price * 0.999;
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
        this.metrics.winningTrades++; // <-- AJOUT
        this.logTransaction(symbol, 'TP1', qtyToSell, currentPrice, pnl, entry.strategy);
      }
      if (entry.tp1Done && currentPrice >= entry.tp2 && this.portfolio[asset] > 0) {
        const qtyToSell = this.portfolio[asset];
        this.portfolio.USDT += qtyToSell * currentPrice * 0.999;
        this.portfolio[asset] = 0;
        const pnl = qtyToSell * (currentPrice - entry.price);
        this.metrics.winningTrades++; // <-- AJOUT
        this.logTransaction(symbol, 'TP2', qtyToSell, currentPrice, pnl, entry.strategy);
        delete this.entryPrices[asset];
      }
      // (Ajoute la même logique pour les shorts si besoin)
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
    } catch {}
  }

  async analyzeSymbol(symbol) {
    try {
      const ohlcvs = await this.fetchMultiTimeframeOHLCV(symbol);
      if (!ohlcvs['15m'] || ohlcvs['15m'].length === 0) return null;
      const currentPrice = ohlcvs['15m'][ohlcvs['15m'].length - 1][4];
      const atrValues = this.calculateATR(ohlcvs['1h'], config.stopLoss.atrPeriod);
      const currentATR = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
      if (!this.isTrending(ohlcvs['1d'])) return null;
      const asset = symbol.split('/')[0];
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
        await this.checkPartialTakeProfit(symbol, currentPrice);
        return null;
      }
      const ichimokuData = this.calculateIchimoku(ohlcvs['1h']);
      if (!ichimokuData || ichimokuData.length === 0) return null;
      const ichimokuSignal = this.generateSignal(ichimokuData, currentPrice);
      const bosSignal = this.simulateBreakOfStructureSignal(ohlcvs['1h'], currentPrice);

      // --- Exécution PARALLÈLE des stratégies ---
      if (ichimokuSignal.buy) {
        await this.executeVirtualTrade(symbol, { buy: true, strategyTag: 'Ichimoku' }, currentPrice, currentATR, config.riskPercentage);
      }
      if (bosSignal.buy && bosSignal.confidence >= 0.7) {
        await this.executeVirtualTrade(symbol, { buy: true, strategyTag: 'BoS' }, currentPrice, currentATR, config.riskPercentage);
      }
      if (ichimokuSignal.short) {
        await this.executeVirtualTrade(symbol, { short: true, strategyTag: 'Ichimoku' }, currentPrice, currentATR, config.riskPercentage);
      }
      return { symbol, price: currentPrice, atr: currentATR, signal: { ...ichimokuSignal, bos: bosSignal } };
    } catch (error) { return null; }
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
      const currentPrice = entry.highest || entry.price;
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
        takeProfit: entry.tp2,
        strategy: entry.strategy || 'Non spécifié'
      });
    }
    for (const [asset, short] of Object.entries(this.shorts)) {
      const symbol = `${asset}/USDT`;
      const currentPrice = short.price;
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
        takeProfit: short.tp2,
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
    } catch {}
    if (this.portfolio.history && this.portfolio.history.length > 0) {
      return this.portfolio.history.slice(-50).reverse();
    }
    return [];
  }

  async runCycle() {
    if (!this.isRunning) return;
    if (!this.updateDrawdown()) return;
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
      } catch { await this.delay(5000); }
    }
  }

  stop() {
    this.isRunning = false;
  }
}

// EXPRESS SERVER
const app = express();
app.use(express.json());
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
            .type.COVER1, .type.COVER2 { background: #9c27b0; }
            .type.TP1, .type.TP2 { background: #4CAF50; }
            .timestamp { color: #888; font-size: 12px; }
            .positions { background: #2d2d2d; padding: 15px; margin: 20px 0; border-radius: 8px; }
            .position { background: #444; margin: 5px 0; padding: 10px; border-radius: 4px; }
            .position.long { border-left: 3px solid #4CAF50; }
            .position.short { border-left: 3px solid #ff9800; }
            .strategy { color: #00bfff; font-weight: bold; }
        </style>
    </head>
    <body>
        <h1>🤖 Bot Ichimoku - Transactions & Positions</h1>
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
                    TP1: ${(pos.entryPrice * 1.022).toFixed(6)} | 
                    TP2: ${(pos.entryPrice * 1.2).toFixed(6)}<br>
                    PnL: <span class="${pos.pnl >= 0 ? 'profit' : 'loss'}">${pos.pnl.toFixed(2)} USDT (${pos.pnlPercent.toFixed(2)}%)</span><br>
                    <span class="strategy">Stratégie: ${pos.strategy || 'Non spécifié'}</span>
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

app.get('/api/status', (req, res) => { if (!bot) return res.json({ isRunning: false }); res.json(bot.getStatus()); });
app.get('/api/positions', (req, res) => { if (!bot) return res.json([]); res.json(bot.getPositions()); });
app.get('/api/transactions', (req, res) => { if (!bot) return res.json([]); res.json(bot.getTransactions()); });

app.post('/api/start', async (req, res) => {
  try {
    if (bot && bot.isRunning) return res.json({ error: 'Bot déjà en cours' });
    bot = new IchimokuBot();
    await bot.start();
    res.json({ success: true, message: 'Bot démarré' });
  } catch (error) { res.json({ error: error.message }); }
});

app.post('/api/stop', (req, res) => {
  if (bot) { bot.stop(); res.json({ success: true, message: 'Bot arrêté' }); }
  else res.json({ error: 'Aucun bot en cours' });
});

async function main() {
  bot = new IchimokuBot();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Serveur web démarré sur le port ${PORT}`);
    console.log(`📊 Interface: http://localhost:${PORT}/transactions/view`);
  });
  process.on('SIGINT', () => { if (bot) bot.stop(); process.exit(0); });
  process.on('uncaughtException', (error) => { if (bot) bot.stop(); process.exit(1); });
  process.on('unhandledRejection', (reason, promise) => { if (bot) bot.stop(); process.exit(1); });
  try { await bot.start(); } catch { process.exit(1); }
}

if (require.main === module) {
  main().catch(error => { process.exit(1); });
}

module.exports = IchimokuBot;
