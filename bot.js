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
      enableRateLimit: config.apiSettings.enableRateLimit
    });
    this.portfolio = { USDT: config.initialCapital, history: [] };
    config.symbols.forEach(symbol => {
      const asset = symbol.split('/')[0];
      this.portfolio[asset] = 0;
    });
    this.entryPrices = {};
    this.requestQueue = [];
    this.isProcessingQueue = false;
    this.shorts = {};
  }

  async delay(ms = 1000) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async processQueue() {
    if (this.requestQueue.length === 0 || this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    const batch = this.requestQueue.splice(0, 5); // Traite par batch de 5
    const results = await Promise.allSettled(batch.map(req => req.fn()));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        batch[index].reject(result.reason);
      } else {
        batch[index].resolve(result.value);
      }
    });
    this.isProcessingQueue = false;
    this.processQueue();
  }

  async fetchMultiTimeframeOHLCV(symbol) {
    const queueRequest = (tf) => new Promise((resolve, reject) => {
      this.requestQueue.push({
        fn: async () => {
          try {
            const ohlcv = await this.exchange.fetchOHLCV(
              symbol, tf, undefined, Math.max(config.ichimoku.spanPeriod * 2, 60)
            );
            resolve(ohlcv);
          } catch (error) {
            reject(error);
          }
        },
        resolve,
        reject
      });
    });
    this.processQueue();
    const results = {};
    for (const tf of config.timeframes) {
      results[tf] = await queueRequest(tf);
    }
    return results;
  }

  calculateIchimoku(ohlcv) {
    if (!ohlcv || ohlcv.length < config.ichimoku.spanPeriod) return null;
    return ichimokucloud({
      high: ohlcv.map(c => c[2]),
      low: ohlcv.map(c => c[3]),
      conversionPeriod: config.ichimoku.conversionPeriod,
      basePeriod: config.ichimoku.basePeriod,
      spanPeriod: config.ichimoku.spanPeriod,
      displacement: config.ichimoku.displacement
    });
  }

  calculateATR(ohlcv, period = 14) {
    return atr({
      high: ohlcv.map(c => c[2]),
      low: ohlcv.map(c => c[3]),
      close: ohlcv.map(c => c[4]),
      period
    });
  }

  calculateADX(ohlcv, period = 14) {
    return adx({
      high: ohlcv.map(c => c[2]),
      low: ohlcv.map(c => c[3]),
      close: ohlcv.map(c => c[4]),
      period
    });
  }

  isTrending(ohlcv) {
    const adxValues = this.calculateADX(ohlcv, config.antiRange.adxPeriod);
    const lastAdx = adxValues.length > 0 ? adxValues[adxValues.length - 1].adx : 0;
    if (lastAdx < config.antiRange.adxThreshold) return false;
    const ichimokuData = this.calculateIchimoku(ohlcv);
    if (!ichimokuData || ichimokuData.length === 0) return false;
    const last = ichimokuData[ichimokuData.length - 1];
    const lastClose = ohlcv[ohlcv.length - 1][4];
    return (lastClose > last.spanA && lastClose > last.spanB) || (lastClose < last.spanA && lastClose < last.spanB);
  }

  generateSignal(ichimokuData, currentPrice) {
    if (!ichimokuData || ichimokuData.length === 0) return { buy: false, sell: false, short: false };
    const last = ichimokuData[ichimokuData.length - 1];
    const inCloud = currentPrice > last.spanA && currentPrice > last.spanB;
    return {
      buy: inCloud && currentPrice > last.conversion && last.conversion > last.base,
      sell: !inCloud && currentPrice < last.conversion,
      short: !inCloud && currentPrice < last.conversion && currentPrice < last.spanA
    };
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
    if (atrValue > config.dynamicSizing.atrThreshold) return config.riskPercentage * config.dynamicSizing.riskReduction;
    return config.riskPercentage;
  }

  async executeVirtualTrade(symbol, signal, price, atrValue = 0) {
    const asset = symbol.split('/')[0];
    // Vérification du prix actuel
    const currentTicker = await this.exchange.fetchTicker(symbol);
    if (Math.abs(currentTicker.last - price) > currentTicker.last * 0.005) {
      console.log(`[REJECT] Écart de prix trop important ${symbol}`);
      return;
    }

    if (signal.buy) {
      if (this.entryPrices[asset]) return;
      const dynamicRisk = this.getDynamicRisk(atrValue);
      const maxAmount = this.portfolio.USDT * (dynamicRisk / 100);
      const amount = maxAmount / price;
      if (amount > 0 && this.portfolio.USDT >= maxAmount) {
        this.portfolio[asset] += amount * 0.999;
        this.portfolio.USDT -= maxAmount;
        const tp1 = price + 1 * atrValue;
        const tp2 = price + 2 * atrValue;
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
          tp1Done: false
        };
        this.logTransaction(symbol, 'BUY', amount, price);
        console.log(`[ENTRÉE] ${symbol} @ ${price.toFixed(6)} | SL: ${stopLoss.toFixed(6)} | TS: ${trailingStop.toFixed(6)} | TP1: ${tp1.toFixed(6)} | TP2: ${tp2.toFixed(6)}`);
      }
    }

    if (signal.sell && this.portfolio[asset] > 0) {
      this.portfolio.USDT += this.portfolio[asset] * price * 0.999;
      this.logTransaction(symbol, 'SELL', this.portfolio[asset], price);
      this.portfolio[asset] = 0;
      delete this.entryPrices[asset];
      console.log(`[SORTIE] ${symbol} @ ${price.toFixed(6)}`);
    }

    // Shorting
    if (signal.short && !this.shorts[asset]) {
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
          tp1Done: false
        };
        this.portfolio.USDT += amount * price * 0.999; // Simule l'emprunt et la vente à découvert
        this.logTransaction(symbol, 'SHORT', amount, price);
        console.log(`[SHORT] ${symbol} @ ${price.toFixed(6)} | SL: ${this.shorts[asset].stopLoss.toFixed(6)} | TP1: ${this.shorts[asset].tp1.toFixed(6)} | TP2: ${this.shorts[asset].tp2.toFixed(6)}`);
      }
    }

    // Take profit / stop loss sur short
    if (signal.takeProfit && this.shorts[asset]) {
      const short = this.shorts[asset];
      if (price <= short.tp1 && !short.tp1Done) {
        const qtyToCover = short.qty * 0.5;
        this.portfolio.USDT -= qtyToCover * price * 0.999; // Simule le rachat partiel
        short.qty -= qtyToCover;
        short.tp1Done = true;
        this.logTransaction(symbol, 'COVER1', qtyToCover, price);
        console.log(`[COVER1] ${symbol} : +50% @ ${price.toFixed(6)}`);
      }
      if (short.tp1Done && price <= short.tp2 && short.qty > 0) {
        this.portfolio.USDT -= short.qty * price * 0.999; // Simule le rachat final
        this.logTransaction(symbol, 'COVER2', short.qty, price);
        delete this.shorts[asset];
        console.log(`[COVER2] ${symbol} : +reste @ ${price.toFixed(6)}`);
      }
      if (price >= short.stopLoss) {
        this.portfolio.USDT -= short.qty * price * 0.999; // Simule le stop loss
        this.logTransaction(symbol, 'COVER_SL', short.qty, price);
        delete this.shorts[asset];
        console.log(`[COVER_SL] ${symbol} @ ${price.toFixed(6)}`);
      }
    }
  }

  async checkPartialTakeProfit(symbol, currentPrice) {
    const asset = symbol.split('/')[0];
    const entry = this.entryPrices[asset];
    if (!entry || this.portfolio[asset] === 0) return;
    if (!entry.tp1Done && currentPrice >= entry.tp1) {
      const qtyToSell = entry.qty * 0.5;
      this.portfolio.USDT += qtyToSell * currentPrice * 0.999;
      this.portfolio[asset] -= qtyToSell;
      entry.tp1Done = true;
      this.logTransaction(symbol, 'TP1', qtyToSell, currentPrice);
      console.log(`[TP1] ${symbol} : +50% @ ${currentPrice.toFixed(6)}`);
    }
    if (entry.tp1Done && currentPrice >= entry.tp2 && this.portfolio[asset] > 0) {
      const qtyToSell = this.portfolio[asset];
      this.portfolio.USDT += qtyToSell * currentPrice * 0.999;
      this.portfolio[asset] = 0;
      this.logTransaction(symbol, 'TP2', qtyToSell, currentPrice);
      delete this.entryPrices[asset];
      console.log(`[TP2] ${symbol} : +reste @ ${currentPrice.toFixed(6)}`);
    }
    // Gestion des shorts
    const short = this.shorts[asset];
    if (short) {
      if (currentPrice <= short.tp1 && !short.tp1Done) {
        const qtyToCover = short.qty * 0.5;
        this.portfolio.USDT -= qtyToCover * currentPrice * 0.999;
        short.qty -= qtyToCover;
        short.tp1Done = true;
        this.logTransaction(symbol, 'COVER1', qtyToCover, currentPrice);
        console.log(`[COVER1] ${symbol} : +50% @ ${currentPrice.toFixed(6)}`);
      }
      if (short.tp1Done && currentPrice <= short.tp2 && short.qty > 0) {
        this.portfolio.USDT -= short.qty * currentPrice * 0.999;
        this.logTransaction(symbol, 'COVER2', short.qty, currentPrice);
        delete this.shorts[asset];
        console.log(`[COVER2] ${symbol} : +reste @ ${currentPrice.toFixed(6)}`);
      }
      if (currentPrice >= short.stopLoss) {
        this.portfolio.USDT -= short.qty * currentPrice * 0.999;
        this.logTransaction(symbol, 'COVER_SL', short.qty, currentPrice);
        delete this.shorts[asset];
        console.log(`[COVER_SL] ${symbol} @ ${currentPrice.toFixed(6)}`);
      }
    }
  }

  logTransaction(symbol, type, amount, price) {
    const portfolioCopy = { ...this.portfolio };
    delete portfolioCopy.history;
    const logEntry = {
      timestamp: new Date().toISOString(),
      symbol,
      type,
      amount: amount.toFixed(6),
      price: price.toFixed(6),
      portfolio: portfolioCopy
    };
    this.portfolio.history.push(logEntry);
    try {
      fs.appendFileSync('transactions.log', JSON.stringify(logEntry, null, 2) + '\n');
    } catch (err) {
      console.error('Erreur écriture transactions.log:', err);
    }
  }

  async analyzeSymbol(symbol) {
    try {
      const ohlcvs = await this.fetchMultiTimeframeOHLCV(symbol);
      if (!ohlcvs['15m'] || ohlcvs['15m'].length === 0) return null;
      const currentPrice = ohlcvs['15m'][ohlcvs['15m'].length - 1][4];
      const asset = symbol.split('/')[0];
      const atrValues = this.calculateATR(ohlcvs['1h'], config.stopLoss.atrPeriod);
      const currentATR = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
      if (!this.isTrending(ohlcvs['1d'])) return null;

      if (this.entryPrices[asset]) {
        await this.checkPartialTakeProfit(symbol, currentPrice);
        if (this.entryPrices[asset]) {
          this.updateTrailingStop(asset, currentPrice, currentATR);
          if (currentPrice <= this.entryPrices[asset].trailingStop) {
            await this.executeVirtualTrade(symbol, { sell: true }, currentPrice);
            console.log(`[TRAILING STOP] ${symbol} @ ${currentPrice.toFixed(6)}`);
          } else if (currentPrice <= this.entryPrices[asset].stopLoss) {
            await this.executeVirtualTrade(symbol, { sell: true }, currentPrice);
            console.log(`[STOP-LOSS ATR] ${symbol} @ ${currentPrice.toFixed(6)}`);
          }
        }
      }

      const signals = {};
      for (const [tf, ohlcv] of Object.entries(ohlcvs)) {
        const ichimokuData = this.calculateIchimoku(ohlcv);
        signals[tf] = this.generateSignal(ichimokuData, currentPrice);
      }

      // On vérifie aussi le signal de shorting
      const shortSignal = signals['1d']?.short;
      if (shortSignal) {
        await this.executeVirtualTrade(symbol, { short: true, takeProfit: false }, currentPrice, currentATR);
      }

      return { signals, currentPrice, currentATR };
    } catch (error) {
      console.error(`Erreur analyse ${symbol}:`, error.message);
      return null;
    }
  }

  async getPortfolioValue() {
    let total = this.portfolio.USDT;
    for (const [asset, quantity] of Object.entries(this.portfolio)) {
      if (asset === 'USDT' || asset === 'history' || quantity === 0) continue;
      try {
        await this.delay(1000);
        const ticker = await this.exchange.fetchTicker(`${asset}/USDT`);
        total += quantity * ticker.last;
      } catch (error) {
        console.error(`Erreur prix ${asset}:`, error.message);
      }
    }
    return total;
  }

  async runSimulation() {
    let cycle = 0;
    while (true) {
      try {
        cycle++;
        console.log(`\n=== Cycle ${cycle} ===`);
        const portefeuille = Object.entries(this.portfolio)
          .filter(([k]) => k !== 'history')
          .map(([k, v]) => `${k}=${v.toFixed(6)}`)
          .join(' | ');
        console.log('Portefeuille :', portefeuille);
        const totalValue = await this.getPortfolioValue();
        console.log(`Valeur totale : $${totalValue.toFixed(2)}`);

        for (const symbol of config.symbols) {
          const analysis = await this.analyzeSymbol(symbol);
          if (!analysis) continue;
          const buySignals = Object.values(analysis.signals).filter(s => s?.buy).length;
          if (buySignals >= 2) {
            await this.executeVirtualTrade(symbol, { buy: true }, analysis.currentPrice, analysis.currentATR);
          }
        }
        // Attente entre chaque cycle (par exemple 60 secondes)
        await this.delay(60000);
      } catch (error) {
        console.error('Erreur dans le cycle:', error);
        await this.delay(60000);
      }
    }
  }

  exportResults() {
    try {
      const csvContent = this.portfolio.history
        .map(entry => `${entry.timestamp},${entry.symbol},${entry.type},${entry.amount},${entry.price}`)
        .join('\n');
      fs.writeFileSync('simulation_results.csv', 'Timestamp,Symbol,Type,Amount,Price\n' + csvContent);
      console.log('\n=== Résultats finaux ===');
      console.log('Portefeuille :', this.portfolio);
    } catch (err) {
      console.error('Erreur exportResults:', err);
    }
  }
}

const bot = new IchimokuBot();

// Lancement du bot
bot.runSimulation()
  .catch(error => {
    console.error('ERREUR:', error);
    process.exit(1);
  });

// Arrêt propre sur SIGINT
process.on('SIGINT', () => {
  console.log('\nArrêt manuel...');
  bot.exportResults();
  process.exit(0);
});

// Serveur web pour consulter les stats
const app = express();
app.get('/stats', (req, res) => {
  fs.readFile('simulation_results.csv', 'utf8', (err, data) => {
    if (err) return res.status(500).send('Erreur lecture fichier');
    res.type('text/plain').send(data);
  });
});
app.get('/transactions', (req, res) => {
  fs.readFile('transactions.log', 'utf8', (err, data) => {
    if (err) return res.status(500).send('Erreur lecture fichier');
    res.type('text/plain').send(data);
  });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stats disponibles sur http://localhost:${PORT}/stats`));
