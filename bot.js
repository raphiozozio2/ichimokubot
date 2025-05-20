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

    this.portfolio = { USDT: 1000, history: [] };
    config.symbols.forEach(symbol => {
      const asset = symbol.split('/')[0];
      this.portfolio[asset] = 0;
    });

    this.entryPrices = {}; // { asset: { price, atr, stopLoss, trailingStop, highest } }
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
          Math.max(config.ichimoku.spanPeriod * 2, 60)
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
    if (!ichimokuData || ichimokuData.length === 0) return { buy: false, sell: false };
    const last = ichimokuData[ichimokuData.length - 1];
    const inCloud = currentPrice > last.spanA && currentPrice > last.spanB;
    return {
      buy: inCloud && currentPrice > last.conversion && last.conversion > last.base,
      sell: !inCloud && currentPrice < last.conversion
    };
  }

  updateTrailingStop(asset, currentPrice, atrValue) {
    if (!this.entryPrices[asset]) return;
    if (currentPrice > this.entryPrices[asset].highest) {
      this.entryPrices[asset].highest = currentPrice;
      this.entryPrices[asset].trailingStop = currentPrice - config.trailing.atrMultiplier * atrValue;
    }
  }

  async executeVirtualTrade(symbol, signal, price, atrValue = 0) {
    const asset = symbol.split('/')[0];
    if (signal.buy) {
      const maxAmount = this.portfolio.USDT * (config.riskPercentage / 100);
      const amount = maxAmount / price;
      if (amount > 0) {
        this.portfolio[asset] += amount * 0.999;
        this.portfolio.USDT -= maxAmount;
        const stopLoss = price - config.stopLoss.atrMultiplier * atrValue;
        const trailingStop = price - config.trailing.atrMultiplier * atrValue;
        this.entryPrices[asset] = {
          price,
          atr: atrValue,
          stopLoss,
          trailingStop,
          highest: price
        };
        this.logTransaction(symbol, 'BUY', amount, price);
        console.log(`[ENTRÉE] ${symbol} @ ${price.toFixed(6)} | SL: ${stopLoss.toFixed(6)} | TS: ${trailingStop.toFixed(6)}`);
      }
    }
    if (signal.sell && this.portfolio[asset] > 0) {
      this.portfolio.USDT += this.portfolio[asset] * price * 0.999;
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
      const atrValues = this.calculateATR(ohlcvs['1h'], config.stopLoss.atrPeriod);
      const currentATR = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;

      // Filtre anti-range sur le daily (1d) pour plus de robustesse
      if (!this.isTrending(ohlcvs['1d'])) return null;

      // Trailing stop dynamique
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

const bot = new IchimokuBot();
bot.runSimulation()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('ERREUR:', error);
    process.exit(1);
  });

process.on('SIGINT', () => {
  console.log('\nArrêt manuel...');
  bot.exportResults();
  process.exit(0);
});

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
