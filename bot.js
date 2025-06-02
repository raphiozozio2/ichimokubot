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
    this.isRunning = false;
    this.cycleCount = 0;
  }

  async delay(ms = 1000) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async processQueue() {
    if (this.requestQueue.length === 0 || this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    const batch = this.requestQueue.splice(0, 5);
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
          tp1 : price - 1 * atrValue,
          tp2 : price - 2 * atrValue,
          tp1Done: false
        };
        this.portfolio.USDT += amount * price * 0.999;
        this.logTransaction(symbol, 'SHORT', amount, price);
        console.log(`[SHORT] ${symbol} @ ${price.toFixed(6)} | SL: ${this.shorts[asset].stopLoss.toFixed(6)} | TP1: ${this.shorts[asset].tp1.toFixed(6)} | TP2: ${this.shorts[asset].tp2.toFixed(6)}`);
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

      const shortSignal = signals['1d']?.short;
      if (shortSignal) {
        await this.executeVirtualTrade(symbol, { short: true }, currentPrice, currentATR);
      }

      const buySignal = signals['15m']?.buy && signals['1h']?.buy;
      const sellSignal = signals['15m']?.sell;

      if (buySignal) {
        await this.executeVirtualTrade(symbol, { buy: true }, currentPrice, currentATR);
      } else if (sellSignal) {
        await this.executeVirtualTrade(symbol, { sell: true }, currentPrice, currentATR);
      }

      return { symbol, currentPrice, signals, atr: currentATR };
    } catch (error) {
      console.error(`Erreur analyse ${symbol}:`, error.message);
      return null;
    }
  }

  getTotalValue() {
    let total = this.portfolio.USDT;
    return total;
  }

  displayPortfolio() {
    const portfolioStr = Object.entries(this.portfolio)
      .filter(([key]) => key !== 'history')
      .map(([asset, amount]) => `${asset}=${amount.toFixed(6)}`)
      .join(' | ');
    
    console.log(`Portefeuille : ${portfolioStr}`);
    console.log(`Valeur totale : $${this.getTotalValue().toFixed(2)}`);
  }

  // NOUVELLE MÉTHODE : Cycle principal d'exécution
  async runCycle() {
    try {
      this.cycleCount++;
      console.log(`\n=== Cycle ${this.cycleCount} ===\n`);
      
      this.displayPortfolio();
      
      // Analyser tous les symboles
      const analysisPromises = config.symbols.map(symbol => this.analyzeSymbol(symbol));
      const results = await Promise.allSettled(analysisPromises);
      
      let successCount = 0;
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          successCount++;
        } else if (result.status === 'rejected') {
          console.error(`Erreur analyse ${config.symbols[index]}:`, result.reason?.message);
        }
      });
      
      console.log(`\nCycle ${this.cycleCount} terminé - ${successCount}/${config.symbols.length} symboles analysés avec succès`);
      console.log(`Valeur finale : $${this.getTotalValue().toFixed(2)}\n`);
      
    } catch (error) {
      console.error(`Erreur dans le cycle ${this.cycleCount}:`, error.message);
    }
  }

  // NOUVELLE MÉTHODE : Boucle principale continue
  async start() {
    if (this.isRunning) {
      console.log('Le bot est déjà en cours d\'exécution');
      return;
    }

    this.isRunning = true;
    console.log('🚀 Démarrage du bot Ichimoku');
    console.log(`💰 Capital initial : $${config.initialCapital}`);
    console.log(`📊 Symboles surveillés : ${config.symbols.length}`);
    console.log(`⏱️  Interval entre cycles : ${config.cycleInterval || 300000}ms (${(config.cycleInterval || 300000) / 1000 / 60} minutes)`);
    
    // Premier cycle immédiat
    await this.runCycle();
    
    // Puis cycles réguliers
    while (this.isRunning) {
      try {
        // Attendre l'intervalle configuré (par défaut 5 minutes)
        await this.delay(config.cycleInterval || 300000);
        
        if (this.isRunning) {
          await this.runCycle();
        }
      } catch (error) {
        console.error('Erreur dans la boucle principale:', error.message);
        // Attendre un peu avant de continuer en cas d'erreur
        await this.delay(60000); // 1 minute
      }
    }
  }

  // NOUVELLE MÉTHODE : Arrêt propre
  stop() {
    console.log('🛑 Arrêt du bot demandé...');
    this.isRunning = false;
  }

  // NOUVELLE MÉTHODE : Statut du bot
  getStatus() {
    return {
      isRunning: this.isRunning,
      cycleCount: this.cycleCount,
      portfolio: { ...this.portfolio },
      totalValue: this.getTotalValue(),
      openPositions: Object.keys(this.entryPrices).length,
      shortPositions: Object.keys(this.shorts).length
    };
  }
}

// NOUVELLE SECTION : Démarrage et serveur Express
async function main() {
  const bot = new IchimokuBot();
  
  // Configuration du serveur Express pour monitoring
  const app = express();
  app.use(express.json());
  
  // Route de santé
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime() 
    });
  });
  
  // Route de statut du bot
  app.get('/status', (req, res) => {
    res.json(bot.getStatus());
  });
  
  // Route pour arrêter le bot
  app.post('/stop', (req, res) => {
    bot.stop();
    res.json({ message: 'Arrêt du bot demandé' });
  });
  
  // Route pour redémarrer le bot
  app.post('/restart', async (req, res) => {
    bot.stop();
    setTimeout(async () => {
      await bot.start();
    }, 5000);
    res.json({ message: 'Redémarrage du bot en cours...' });
  });
  
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`Serveur Express démarré sur le port ${PORT}`);
  });
  
  // Gestion des signaux pour arrêt propre
  process.on('SIGINT', () => {
    console.log('\n🛑 Signal SIGINT reçu, arrêt du bot...');
    bot.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n🛑 Signal SIGTERM reçu, arrêt du bot...');
    bot.stop();
    process.exit(0);
  });
  
  // Démarrer le bot
  try {
    await bot.start();
  } catch (error) {
    console.error('Erreur lors du démarrage du bot:', error);
    process.exit(1);
  }
}

// Démarrage de l'application
if (require.main === module) {
  main().catch(error => {
    console.error('Erreur fatale:', error);
    process.exit(1);
  });
}

module.exports = IchimokuBot;