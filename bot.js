// bot.js

const ccxt = require('ccxt');
const { ichimokucloud, atr } = require('technicalindicators');
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

    this.portfolio = { USDT: 1000, history: [] };
    config.symbols.forEach(symbol => {
      const asset = symbol.split('/')[0];
      this.portfolio[asset] = 0;
    });

    this.entryPrices = {}; // { asset: { price, atr, takeProfit } }
    this.intervalId = null;
  }

  async fetchMultiTimeframeOHLCV(symbol) {
    const results = {};
    for (const tf of config.timeframes) {
      try {
        const ohlcv = await this.exchange.fetchOHLCV(
          symbol,
          tf,
          undefined,
          config.ichimoku.spanPeriod * 2
        );
        results[tf] = ohlcv;
      } catch (error) {
        console.error(`Erreur fetchOHLCV (${symbol} ${tf}):`, error.message);
      }
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

  generateSignal(ichimokuData, currentPrice) {
    if (!ichimokuData || ichimokuData.length === 0) return { buy: false, sell: false };
    const last = ichimokuData[ichimokuData.length - 1];
    const inCloud = currentPrice > last.spanA && currentPrice > last.spanB;
    return {
      buy: inCloud && currentPrice > last.conversion && last.conversion > last.base,
      sell: !inCloud && currentPrice < last.conversion
    };
  }

  async executeVirtualTrade(symbol, signal, price, atrValue = 0) {
    const asset = symbol.split('/')[0];

    // Achat
    if (signal.buy) {
      const maxAmount = this.portfolio.USDT * (config.riskPercentage / 100);
      const amount = maxAmount / price;
      if (amount > 0) {
        this.portfolio[asset] += amount * 0.999; // simulate fees
        this.portfolio.USDT -= maxAmount;

        // Définir le take profit à 2 x ATR au-dessus du prix d'entrée
        const takeProfit = price + (2 * atrValue);

        this.entryPrices[asset] = { price, atr: atrValue, takeProfit };
        this.logTransaction(symbol, 'BUY', amount, price);
        console.log(`[ENTRÉE] ${symbol} @ ${price.toFixed(6)} | TP: ${takeProfit.toFixed(6)}`);
      }
    }

    // Vente (sortie)
    if (signal.sell && this.portfolio[asset] > 0) {
      this.portfolio.USDT += this.portfolio[asset] * price * 0.999; // simulate fees
      this.logTransaction(symbol, 'SELL', this.portfolio[asset], price);
      this.portfolio[asset] = 0;
      delete this.entryPrices[asset];
      console.log(`[SORTIE] ${symbol} @ ${price.toFixed(6)}`);
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
    fs.appendFileSync('transactions.log', JSON.stringify(logEntry, null, 2) + '\n');
  }

  async analyzeSymbol(symbol) {
    try {
      const ohlcvs = await this.fetchMultiTimeframeOHLCV(symbol);
      if (!ohlcvs['15m'] || ohlcvs['15m'].length === 0) return null;
      const currentPrice = ohlcvs['15m'][ohlcvs['15m'].length - 1][4];
      const asset = symbol.split('/')[0];
      const atrValues = this.calculateATR(ohlcvs['1h']);
      const currentATR = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;

      // Stop-loss dynamique
      if (this.entryPrices[asset] && currentPrice <= (this.entryPrices[asset].price - currentATR * 1.5)) {
        await this.executeVirtualTrade(symbol, { sell: true }, currentPrice);
        console.log(`[STOP-LOSS ATR] ${symbol} @ ${currentPrice.toFixed(6)}`);
      }

      // Take profit automatique
      if (this.entryPrices[asset] && currentPrice >= this.entryPrices[asset].takeProfit) {
        await this.executeVirtualTrade(symbol, { sell: true }, currentPrice);
        console.log(`[TAKE PROFIT] ${symbol} @ ${currentPrice.toFixed(6)}`);
      }

      const signals = {};
      for (const [tf, ohlcv] of Object.entries(ohlcvs)) {
        const ichimokuData = this.calculateIchimoku(ohlcv);
        signals[tf] = this.generateSignal(ichimokuData, currentPrice);
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
        const ticker = await this.exchange.fetchTicker(`${asset}/USDT`);
        total += quantity * ticker.last;
      } catch (error) {
        console.error(`Erreur prix ${asset}:`, error.message);
      }
    }
    return total;
  }

  async runSimulation() {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      this.intervalId = setInterval(async () => {
        try {
          if (Date.now() - startTime >= config.simulationDuration * 60 * 1000) {
            clearInterval(this.intervalId);
            this.exportResults();
            resolve();
            return;
          }
          console.log(`\n=== Cycle ${Math.floor((Date.now() - startTime) / 60000) + 1} ===`);
          console.log('Portefeuille :',
            Object.entries(this.portfolio)
              .filter(([k]) => k !== 'history')
              .map(([k, v]) => `${k}=${v.toFixed(6)}`)
              .join(' | ')
          );
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
        } catch (error) {
          clearInterval(this.intervalId);
          reject(error);
        }
      }, config.apiSettings.rateLimit);
    });
  }

  exportResults() {
    const csvContent = this.portfolio.history
      .map(entry => `${entry.timestamp},${entry.symbol},${entry.type},${entry.amount},${entry.price}`)
      .join('\n');
    fs.writeFileSync('simulation_results.csv', 'Timestamp,Symbol,Type,Amount,Price\n' + csvContent);
    console.log('\n=== Résultats finaux ===');
    console.log('Portefeuille :', this.portfolio);
  }
}

// === Lancement du bot ===
const bot = new IchimokuBot();
bot.runSimulation()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('ERREUR:', error);
    process.exit(1);
  });

// Gestion CTRL+C
process.on('SIGINT', () => {
  console.log('\nArrêt manuel...');
  bot.exportResults();
  process.exit(0);
});

// === Serveur Express pour stats en direct ===
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
