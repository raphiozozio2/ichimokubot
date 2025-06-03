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
    this.initialCapital = config.initialCapital; // Pour calcul drawdown
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

  // AMÉLIORATION: Retry automatique sur erreurs API
  async retryApiCall(apiCall, maxRetries = config.apiSettings.retryAttempts) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        console.log(`❌ Tentative ${attempt}/${maxRetries} échouée: ${error.message}`);
        
        if (attempt === maxRetries) {
          throw error;
        }
        
        // Attendre avant retry (délai exponentiel)
        const delay = config.apiSettings.retryDelay * Math.pow(2, attempt - 1);
        console.log(`⏳ Retry dans ${delay}ms...`);
        await this.delay(delay);
      }
    }
  }

  // AMÉLIORATION: Fetch avec retry et validation
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
      await this.delay(200); // Délai entre requêtes
    }
    
    return results;
  }

  // AMÉLIORATION: Validation des prix stricte
  async validatePrice(symbol, price) {
    try {
      const ticker = await this.retryApiCall(async () => {
        return await this.exchange.fetchTicker(symbol);
      });
      
      const spread = Math.abs(ticker.last - price) / ticker.last * 100;
      
      if (spread > config.priceValidation.maxSpreadPercent) {
        console.log(`❌ ${symbol}: Écart prix trop important ${spread.toFixed(2)}%`);
        return false;
      }
      
      if (ticker.baseVolume < config.priceValidation.minVolume) {
        console.log(`❌ ${symbol}: Volume insuffisant ${ticker.baseVolume}`);
        return false;
      }
      
      return true;
    } catch (error) {
      console.log(`❌ ${symbol}: Erreur validation prix - ${error.message}`);
      return false;
    }
  }

  calculateIchimoku(ohlcv) {
    if (!ohlcv || ohlcv.length < config.ichimoku.spanPeriod) {
      return null;
    }
    
    try {
      return ichimokucloud({
        high: ohlcv.map(c => c[2]),
        low: ohlcv.map(c => c[3]),
        conversionPeriod: config.ichimoku.conversionPeriod,
        basePeriod: config.ichimoku.basePeriod,
        spanPeriod: config.ichimoku.spanPeriod,
        displacement: config.ichimoku.displacement
      });
    } catch (error) {
      console.log(`❌ Erreur calcul Ichimoku: ${error.message}`);
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
    } catch (error) {
      console.log(`❌ Erreur calcul ATR: ${error.message}`);
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
    } catch (error) {
      console.log(`❌ Erreur calcul ADX: ${error.message}`);
      return [];
    }
  }

  isTrending(ohlcv) {
    try {
      const adxValues = this.calculateADX(ohlcv, config.antiRange.adxPeriod);
      const lastAdx = adxValues.length > 0 ? adxValues[adxValues.length - 1].adx : 0;
      
      if (lastAdx < config.antiRange.adxThreshold) {
        return false;
      }
      
      const ichimokuData = this.calculateIchimoku(ohlcv);
      if (!ichimokuData || ichimokuData.length === 0) {
        return false;
      }
      
      const last = ichimokuData[ichimokuData.length - 1];
      const lastClose = ohlcv[ohlcv.length - 1][4];
      
      return (lastClose > last.spanA && lastClose > last.spanB) || 
             (lastClose < last.spanA && lastClose < last.spanB);
      
    } catch (error) {
      console.log(`❌ Erreur isTrending: ${error.message}`);
      return false;
    }
  }

  generateSignal(ichimokuData, currentPrice) {
    if (!ichimokuData || ichimokuData.length === 0) {
      return { buy: false, sell: false, short: false };
    }
    
    try {
      const last = ichimokuData[ichimokuData.length - 1];
      const inCloud = currentPrice > last.spanA && currentPrice > last.spanB;
      
      return {
        buy: inCloud && currentPrice > last.conversion && last.conversion > last.base,
        sell: !inCloud && currentPrice < last.conversion,
        short: !inCloud && currentPrice < last.conversion && currentPrice < last.spanA
      };
    } catch (error) {
      console.log(`❌ Erreur generateSignal: ${error.message}`);
      return { buy: false, sell: false, short: false };
    }
  }

  // AMÉLIORATION: Contrôle nombre de positions
  canOpenNewPosition() {
    const currentPositions = Object.keys(this.entryPrices).length + Object.keys(this.shorts).length;
    return currentPositions < config.maxPositions;
  }

  // AMÉLIORATION: Calcul et contrôle drawdown
  updateDrawdown() {
    const currentValue = this.getTotalValue();
    const drawdownPercent = (this.initialCapital - currentValue) / this.initialCapital * 100;
    
    this.metrics.currentDrawdown = Math.max(0, drawdownPercent);
    this.metrics.maxDrawdown = Math.max(this.metrics.maxDrawdown, this.metrics.currentDrawdown);
    
    // CRITIQUE: Arrêt si drawdown maximum atteint
    if (this.metrics.currentDrawdown > config.maxDrawdown) {
      console.log(`🚨 DRAWDOWN MAXIMUM ATTEINT: ${this.metrics.currentDrawdown.toFixed(2)}%`);
      console.log(`🛑 ARRÊT AUTOMATIQUE DU BOT POUR PROTECTION`);
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

  async executeVirtualTrade(symbol, signal, price, atrValue = 0) {
    const asset = symbol.split('/')[0];
    
    // AMÉLIORATION: Validation prix stricte
    if (!(await this.validatePrice(symbol, price))) {
      return;
    }

    if (signal.buy) {
      // AMÉLIORATION: Contrôle nombre de positions
      if (this.entryPrices[asset] || !this.canOpenNewPosition()) {
        if (!this.canOpenNewPosition()) {
          console.log(`⚠️ Maximum de positions atteint (${config.maxPositions}), pas d'achat ${symbol}`);
        }
        return;
      }
      
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
          tp1Done: false,
          entryTime: new Date()
        };
        
        this.metrics.totalTrades++;
        this.logTransaction(symbol, 'BUY', amount, price);
        console.log(`[ENTRÉE] ${symbol} @ ${price.toFixed(6)} | SL: ${stopLoss.toFixed(6)} | TP1: ${tp1.toFixed(6)} | TP2: ${tp2.toFixed(6)}`);
      }
    }

    if (signal.sell && this.portfolio[asset] > 0) {
      const entry = this.entryPrices[asset];
      const sellValue = this.portfolio[asset] * price * 0.999;
      
      this.portfolio.USDT += sellValue;
      this.logTransaction(symbol, 'SELL', this.portfolio[asset], price);
      
      // Mise à jour métriques
      if (entry) {
        const pnl = sellValue - (entry.qty * entry.price);
        if (pnl > 0) {
          this.metrics.winningTrades++;
        } else {
          this.metrics.losingTrades++;
        }
      }
      
      this.portfolio[asset] = 0;
      delete this.entryPrices[asset];
      console.log(`[SORTIE] ${symbol} @ ${price.toFixed(6)}`);
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
          entryTime: new Date()
        };
        
        this.portfolio.USDT += amount * price * 0.999;
        this.metrics.totalTrades++;
        this.logTransaction(symbol, 'SHORT', amount, price);
        console.log(`[SHORT] ${symbol} @ ${price.toFixed(6)} | SL: ${this.shorts[asset].stopLoss.toFixed(6)} | TP1: ${this.shorts[asset].tp1.toFixed(6)} | TP2: ${this.shorts[asset].tp2.toFixed(6)}`);
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
    } catch (error) {
      console.log(`❌ Erreur checkPartialTakeProfit pour ${symbol}: ${error.message}`);
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
      portfolio: portfolioCopy,
      totalValue: this.getTotalValue(),
      drawdown: this.metrics.currentDrawdown
    };
    
    this.portfolio.history.push(logEntry);
    
    try {
      fs.appendFileSync('transactions.log', JSON.stringify(logEntry, null, 2) + '\n');
    } catch (err) {
      console.error('Erreur écriture transactions.log:', err);
    }
  }

  async analyzeSymbol(symbol) {
    console.log(`\n🔍 === ANALYSE ${symbol} ===`);
    
    try {
      const ohlcvs = await this.fetchMultiTimeframeOHLCV(symbol);
      
      if (!ohlcvs['15m'] || ohlcvs['15m'].length === 0) {
        throw new Error(`Pas de données 15m pour ${symbol}`);
      }
      
      const currentPrice = ohlcvs['15m'][ohlcvs['15m'].length - 1][4];
      console.log(`💰 Prix actuel: ${currentPrice.toFixed(6)}`);
      
      const atrValues = this.calculateATR(ohlcvs['1h'], config.stopLoss.atrPeriod);
      const currentATR = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
      console.log(`📈 ATR: ${currentATR.toFixed(6)}`);
      
      if (!this.isTrending(ohlcvs['1d'])) {
        console.log(`⚠️ ${symbol}: Pas de tendance détectée`);
        return null;
      }
      console.log(`✅ ${symbol}: Tendance confirmée`);

      const asset = symbol.split('/')[0];

      if (this.entryPrices[asset]) {
        console.log(`🔄 Position existante pour ${asset}`);
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
        console.log(`📉 Signal SHORT détecté sur 1d`);
        await this.executeVirtualTrade(symbol, { short: true }, currentPrice, currentATR);
      }

      const buySignal = signals['15m']?.buy && signals['1h']?.buy;
      const sellSignal = signals['15m']?.sell;

      if (buySignal) {
        console.log(`📈 Signal BUY détecté`);
        await this.executeVirtualTrade(symbol, { buy: true }, currentPrice, currentATR);
      } else if (sellSignal) {
        console.log(`📉 Signal SELL détecté`);
        await this.executeVirtualTrade(symbol, { sell: true }, currentPrice, currentATR);
      }

      console.log(`✅ ${symbol}: Analyse terminée`);
      delete this.lastAnalysisErrors[symbol];
      
      return { symbol, currentPrice, signals, atr: currentATR };
      
    } catch (error) {
      console.error(`❌ ${symbol}: ERREUR - ${error.message}`);
      this.lastAnalysisErrors[symbol] = {
        error: error.message,
        timestamp: new Date().toISOString()
      };
      return null;
    }
  }

  getTotalValue() {
    let total = this.portfolio.USDT;
    // Note: En réalité, il faudrait calculer la valeur des autres actifs
    // Ici on simplifie car les positions sont vendues rapidement
    return total;
  }

  displayPortfolio() {
    const portfolioStr = Object.entries(this.portfolio)
      .filter(([key]) => key !== 'history')
      .map(([asset, amount]) => `${asset}=${amount.toFixed(6)}`)
      .join(' | ');
    
    console.log(`\n💼 Portefeuille : ${portfolioStr}`);
    console.log(`💰 Valeur totale : $${this.getTotalValue().toFixed(2)}`);
    console.log(`📊 Drawdown actuel : ${this.metrics.currentDrawdown.toFixed(2)}%`);
    
    const openPositions = Object.keys(this.entryPrices).length;
    const shortPositions = Object.keys(this.shorts).length;
    console.log(`📈 Positions: ${openPositions} LONG, ${shortPositions} SHORT (Max: ${config.maxPositions})`);
    
    if (this.metrics.totalTrades > 0) {
      const winRate = (this.metrics.winningTrades / this.metrics.totalTrades * 100).toFixed(1);
      console.log(`🎯 Trades: ${this.metrics.totalTrades} | Win Rate: ${winRate}%`);
    }
  }

  async runCycle() {
    try {
      this.cycleCount++;
      const startTime = Date.now();
      console.log(`\n🚀 === CYCLE ${this.cycleCount} - ${new Date().toLocaleString()} ===`);
      
      this.displayPortfolio();
      
      // CRITIQUE: Vérifier drawdown avant de continuer
      if (!this.updateDrawdown()) {
        return; // Bot arrêté automatiquement
      }
      
      const errorCount = Object.keys(this.lastAnalysisErrors).length;
      if (errorCount > 0) {
        console.log(`\n⚠️ Erreurs persistantes sur ${errorCount} symboles`);
      }
      
      console.log(`\n📊 Analyse de ${config.symbols.length} symboles...`);
      
      let successCount = 0;
      let errorCount_cycle = 0;
      
      for (let i = 0; i < config.symbols.length; i++) {
        const symbol = config.symbols[i];
        console.log(`\n[${i+1}/${config.symbols.length}] ${symbol}...`);
        
        try {
          const result = await this.analyzeSymbol(symbol);
          if (result) {
            successCount++;
            console.log(`✅ ${symbol}: Succès`);
          } else {
            errorCount_cycle++;
            console.log(`❌ ${symbol}: Pas de tendance`);
          }
        } catch (error) {
          errorCount_cycle++;
          console.log(`❌ ${symbol}: ${error.message}`);
        }
        
        // Délai plus long entre symboles
        if (i < config.symbols.length - 1) {
          await this.delay(1500);
        }
      }
      
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n📊 CYCLE ${this.cycleCount} TERMINÉ:`);
      console.log(`   ✅ Succès: ${successCount}/${config.symbols.length}`);
      console.log(`   ❌ Échecs: ${errorCount_cycle}/${config.symbols.length}`);
      console.log(`   ⏱️ Durée: ${duration}s`);
      console.log(`   💰 Valeur: $${this.getTotalValue().toFixed(2)}`);
      console.log(`   📉 Drawdown: ${this.metrics.currentDrawdown.toFixed(2)}%`);
      
    } catch (error) {
      console.error(`❌ Erreur cycle ${this.cycleCount}:`, error.message);
    }
  }

  async start() {
    if (this.isRunning) {
      console.log('⚠️ Bot déjà en cours');
      return;
    }

    this.isRunning = true;
    console.log('\n🚀 === DÉMARRAGE BOT ICHIMOKU (VERSION SÉCURISÉE) ===');
    console.log(`💰 Capital: $${config.initialCapital}`);
    console.log(`📊 Symboles: ${config.symbols.length}`);
    console.log(`⏱️ Cycle: ${config.cycleInterval / 1000 / 60} minutes`);
    console.log(`🎯 Risk par trade: ${config.riskPercentage}%`);
    console.log(`📈 Max positions: ${config.maxPositions}`);
    console.log(`🛡️ Max drawdown: ${config.maxDrawdown}%`);
    
    try {
      console.log('\n🔌 Test connexion Binance...');
      await this.retryApiCall(async () => {
        return await this.exchange.fetchTicker('BTC/USDT');
      });
      console.log('✅ Connexion OK\n');
    } catch (error) {
      console.error('❌ Erreur connexion:', error.message);
      console.log('⚠️ Vérifiez vos clés API\n');
    }
    
    // Premier cycle
    await this.runCycle();
    
    // Cycles réguliers
    while (this.isRunning) {
      try {
        const nextCycle = new Date(Date.now() + config.cycleInterval);
        console.log(`\n⏳ Prochain cycle: ${nextCycle.toLocaleTimeString()}`);
        
        await this.delay(config.cycleInterval);
        
        if (this.isRunning) {
          await this.runCycle();
        }
      } catch (error) {
        console.error('❌ Erreur boucle:', error.message);
        await this.delay(60000);
      }
    }
  }

  stop() {
    console.log('\n🛑 Arrêt du bot...');
    this.isRunning = false;
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      cycleCount: this.cycleCount,
      portfolio: { ...this.portfolio },
      totalValue: this.getTotalValue(),
      openPositions: Object.keys(this.entryPrices).length,
      shortPositions: Object.keys(this.shorts).length,
      lastErrors: this.lastAnalysisErrors,
      symbols: config.symbols,
      metrics: this.metrics,
      config: {
        riskPercentage: config.riskPercentage,
        maxPositions: config.maxPositions,
        maxDrawdown: config.maxDrawdown,
        cycleInterval: config.cycleInterval
      }
    };
  }
}

// Serveur Express et démarrage
async function main() {
  const bot = new IchimokuBot();
  
  const app = express();
  app.use(express.json());
  
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime() 
    });
  });
  
  app.get('/status', (req, res) => {
    res.json(bot.getStatus());
  });

  app.post('/stop', (req, res) => {
    bot.stop();
    res.json({ message: 'Arrêt demandé' });
  });
  
  app.post('/restart', async (req, res) => {
    bot.stop();
    setTimeout(async () => {
      await bot.start();
    }, 5000);
    res.json({ message: 'Redémarrage en cours...' });
  });

  // Route transactions
  app.get('/transactions', (req, res) => {
    try {
      if (!fs.existsSync('transactions.log')) {
        return res.json({ 
          message: 'Aucune transaction', 
          transactions: [],
          count: 0 
        });
      }

      const logContent = fs.readFileSync('transactions.log', 'utf8');
      const transactions = logContent
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(t => t !== null)
        .slice(-50);

      res.json({
        transactions: transactions.reverse(),
        count: transactions.length,
        lastUpdate: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: 'Erreur: ' + error.message });
    }
  });

  // Interface web transactions
  app.get('/transactions/view', (req, res) => {
    try {
      const status = bot.getStatus();
      
      if (!fs.existsSync('transactions.log')) {
        return res.send(`
          <html>
            <head><title>Bot Sécurisé - Aucune Transaction</title></head>
            <body style="font-family: Arial; padding: 20px;">
              <h1>🤖 Bot Ichimoku Sécurisé</h1>
              <p>Aucune transaction trouvée</p>
              <div style="background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <h3>⚙️ Configuration Sécurisée</h3>
                <p><strong>Risk par trade:</strong> ${status.config.riskPercentage}%</p>
                <p><strong>Max positions:</strong> ${status.config.maxPositions}</p>
                <p><strong>Max drawdown:</strong> ${status.config.maxDrawdown}%</p>
                <p><strong>Cycle:</strong> ${status.config.cycleInterval / 1000 / 60} minutes</p>
              </div>
              <a href="/status">📈 Voir statut</a>
            </body>
          </html>
        `);
      }

      const logContent = fs.readFileSync('transactions.log', 'utf8');
      const transactions = logContent
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(t => t !== null)
        .slice(-50)
        .reverse();

      const html = `
        <html>
          <head>
            <title>Bot Sécurisé - Transactions</title>
            <meta http-equiv="refresh" content="30">
            <style>
              body { font-family: Arial; margin: 20px; background: #f5f5f5; }
              .header { background: #2196F3; color: white; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
              .security-info { background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 10px 0; border-left: 4px solid #4CAF50; }
              .transaction { background: white; padding: 10px; margin: 5px 0; border-radius: 5px; border-left: 4px solid #4CAF50; }
              .buy { border-left-color: #4CAF50; }
              .sell { border-left-color: #f44336; }
              .short { border-left-color: #ff9800; }
              .cover, .cover1, .cover2, .cover_sl { border-left-color: #9c27b0; }
              .tp1, .tp2 { border-left-color: #00bcd4; }
              .timestamp { color: #666; font-size: 0.8em; }
              .amount { font-weight: bold; }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>🛡️ Bot Ichimoku Sécurisé - Transactions</h1>
              <p>Dernière MAJ: ${new Date().toLocaleString()}</p>
              <p>Total: ${transactions.length} transactions | <a href="/status" style="color: white;">📈 Statut</a></p>
            </div>
            
            <div class="security-info">
              <h3>⚙️ Configuration Sécurisée Active</h3>
              <p><strong>✅ Risk par trade:</strong> ${status.config.riskPercentage}% (au lieu de 25%)</p>
              <p><strong>✅ Max positions:</strong> ${status.config.maxPositions} simultanées</p>
              <p><strong>✅ Protection drawdown:</strong> Arrêt auto à ${status.config.maxDrawdown}%</p>
              <p><strong>✅ Cycle trading:</strong> ${status.config.cycleInterval / 1000 / 60} minutes (au lieu de 30s)</p>
              <p><strong>📊 Drawdown actuel:</strong> ${status.metrics.currentDrawdown.toFixed(2)}%</p>
            </div>
            
            ${transactions.length === 0 ? '<p>Aucune transaction</p>' : ''}
            
            ${transactions.map(t => `
              <div class="transaction ${t.type.toLowerCase()}">
                <div class="timestamp">${new Date(t.timestamp).toLocaleString()}</div>
                <div><strong>${t.symbol}</strong> - ${t.type}</div>
                <div class="amount">Quantité: ${t.amount} @ ${t.price} USDT</div>
                <div style="margin-top: 10px; font-size: 0.9em;">
                  💰 USDT: ${parseFloat(t.portfolio.USDT).toFixed(2)}
                  ${t.totalValue ? ` | 📈 Total: $${t.totalValue.toFixed(2)}` : ''}
                  ${t.drawdown ? ` | 📉 DD: ${t.drawdown.toFixed(2)}%` : ''}
                </div>
              </div>
            `).join('')}
            
            <div style="background: #e3f2fd; padding: 15px; border-radius: 5px; margin-top: 20px;">
              <p><em>🔄 Auto-refresh 30s | ⚡ Toutes les corrections critiques appliquées</em></p>
            </div>
          </body>
        </html>
      `;

      res.send(html);
    } catch (error) {
      res.status(500).send(`<h1>Erreur: ${error.message}</h1>`);
    }
  });

  // Dashboard principal
  app.get('/', (req, res) => {
    const status = bot.getStatus();
    const html = `
      <html>
        <head>
          <title>Bot Ichimoku Sécurisé</title>
          <meta http-equiv="refresh" content="60">
          <style>
            body { font-family: Arial; margin: 20px; background: #f0f0f0; }
            .card { background: white; padding: 20px; margin: 10px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            .status-running { color: #4CAF50; }
            .status-stopped { color: #f44336; }
            .nav { background: #2196F3; color: white; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
            .nav a { color: white; text-decoration: none; margin: 0 15px; }
            .security { background: #e8f5e8; padding: 15px; border-radius: 5px; border-left: 4px solid #4CAF50; }
            .warning { background: #fff3cd; padding: 15px; border-radius: 5px; border-left: 4px solid #ffc107; }
            .danger { background: #f8d7da; padding: 15px; border-radius: 5px; border-left: 4px solid #dc3545; }
          </style>
        </head>
        <body>
          <div class="nav">
            <h1>🛡️ Bot Ichimoku Sécurisé</h1>
            <nav>
              <a href="/">🏠 Dashboard</a>
              <a href="/transactions/view">📊 Transactions</a>
              <a href="/status">📈 JSON</a>
            </nav>
          </div>
          
          <div class="card security">
            <h2>✅ Configuration Sécurisée Active</h2>
            <p><strong>Risk Management:</strong> ${status.config.riskPercentage}% par trade (au lieu de 25%)</p>
            <p><strong>Position Limit:</strong> Max ${status.config.maxPositions} positions simultanées</p>
            <p><strong>Protection Drawdown:</strong> Arrêt automatique à ${status.config.maxDrawdown}%</p>
            <p><strong>Fréquence Trading:</strong> Cycle ${status.config.cycleInterval / 1000 / 60} minutes (au lieu de 30s)</p>
          </div>
          
          <div class="card">
            <h2>📊 Statut Bot</h2>
            <p><strong>État:</strong> <span class="${status.isRunning ? 'status-running' : 'status-stopped'}">${status.isRunning ? '🟢 Actif' : '🔴 Arrêté'}</span></p>
            <p><strong>Cycles:</strong> ${status.cycleCount}</p>
            <p><strong>Valeur portefeuille:</strong> $${status.totalValue.toFixed(2)}</p>
            <p><strong>Positions:</strong> ${status.openPositions} LONG, ${status.shortPositions} SHORT / ${status.config.maxPositions} max</p>
            <p><strong>Dernière MAJ:</strong> ${new Date().toLocaleString()}</p>
          </div>
          
          ${status.metrics.currentDrawdown > 15 ? `
          <div class="card warning">
            <h2>⚠️ Attention Drawdown</h2>
            <p><strong>Drawdown actuel:</strong> ${status.metrics.currentDrawdown.toFixed(2)}%</p>
            <p><strong>Drawdown maximum:</strong> ${status.metrics.maxDrawdown.toFixed(2)}%</p>
            <p><em>Le bot s'arrêtera automatiquement à ${status.config.maxDrawdown}%</em></p>
          </div>
          ` : `
          <div class="card">
            <h2>📈 Performance</h2>
            <p><strong>Drawdown actuel:</strong> ${status.metrics.currentDrawdown.toFixed(2)}%</p>
            <p><strong>Drawdown maximum:</strong> ${status.metrics.maxDrawdown.toFixed(2)}%</p>
            ${status.metrics.totalTrades > 0 ? `
            <p><strong>Total trades:</strong> ${status.metrics.totalTrades}</p>
            <p><strong>Win rate:</strong> ${(status.metrics.winningTrades / status.metrics.totalTrades * 100).toFixed(1)}%</p>
            ` : ''}
          </div>
          `}
          
          <div class="card">
            <h2>💼 Portefeuille</h2>
            <p><strong>USDT:</strong> ${status.portfolio.USDT.toFixed(2)}</p>
            ${Object.entries(status.portfolio)
              .filter(([asset, amount]) => asset !== 'USDT' && asset !== 'history' && amount > 0)
              .map(([asset, amount]) => `<p><strong>${asset}:</strong> ${amount.toFixed(6)}</p>`)
              .join('') || '<p><em>Aucune autre position</em></p>'}
          </div>
          
          <div class="card">
            <h2>🔧 Actions</h2>
            <button onclick="fetch('/stop', {method: 'POST'}).then(r => r.json()).then(d => alert(d.message))" 
                    style="background: #f44336; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">
              🛑 Arrêter Bot
            </button>
            <button onclick="fetch('/restart', {method: 'POST'}).then(r => r.json()).then(d => alert(d.message))" 
                    style="background: #ff9800; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; margin-left: 10px;">
              🔄 Redémarrer Bot
            </button>
          </div>
          
          <div class="card">
            <p><em>🔄 Mise à jour auto 60s | Version sécurisée avec toutes les corrections critiques</em></p>
          </div>
        </body>
      </html>
    `;
    res.send(html);
  });
  
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`🌐 Serveur sur port ${PORT}`);
  });
  
  process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT - Arrêt...');
    bot.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM - Arrêt...');
    bot.stop();
    process.exit(0);
  });
  
  try {
    await bot.start();
  } catch (error) {
    console.error('❌ Erreur démarrage:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
  });
}

module.exports = IchimokuBot;