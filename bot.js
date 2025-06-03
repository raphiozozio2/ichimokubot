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
        console.log(`❌ Tentative ${attempt}/${maxRetries} échouée: ${error.message}`);
        
        if (attempt === maxRetries) {
          throw error;
        }
        
        const delay = config.apiSettings.retryDelay * Math.pow(2, attempt - 1);
        console.log(`⏳ Retry dans ${delay}ms...`);
        await this.delay(delay);
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
    
    if (!(await this.validatePrice(symbol, price))) {
      return;
    }

    if (signal.buy) {
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
      
      if (!this.updateDrawdown()) {
        return;
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
    
    await this.runCycle();
    
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

// Fonctions helper pour l'interface
function generatePortfolioSection(status) {
  const totalAssets = Object.entries(status.portfolio)
    .filter(([asset, amount]) => asset !== 'history' && amount > 0).length;
    
  return `
    <div class="card">
      <h2>💼 Portfolio Détaillé</h2>
      <div style="background: #e8f5e8; padding: 15px; border-radius: 8px; margin: 15px 0;">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; text-align: center;">
          <div>
            <div class="metric-value" style="color: #4CAF50;">$${status.totalValue.toFixed(2)}</div>
            <div class="metric-label">Valeur Totale</div>
          </div>
          <div>
            <div class="metric-value" style="color: #2196F3;">${totalAssets}</div>
            <div class="metric-label">Actifs Détenus</div>
          </div>
          <div>
            <div class="metric-value" style="color: #ff9800;">${status.metrics?.currentDrawdown?.toFixed(2) || '0.00'}%</div>
            <div class="metric-label">Drawdown Actuel</div>
          </div>
        </div>
      </div>
      
      <div class="portfolio-grid">
        ${Object.entries(status.portfolio)
          .filter(([asset]) => asset !== 'history')
          .map(([asset, amount]) => {
            const isZero = amount === 0;
            return `
              <div class="asset-card ${isZero ? 'zero' : ''}">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <div style="font-weight: bold; font-size: 1.1em;">${asset}</div>
                    <div class="asset-amount">${amount.toFixed(6)}</div>
                  </div>
                  <div style="text-align: right;">
                    ${asset === 'USDT' ? 
                      `<div class="asset-value">$${amount.toFixed(2)}</div>` :
                      `<div style="color: #666; font-size: 0.9em;">${isZero ? 'Aucune position' : 'Position active'}</div>`
                    }
                  </div>
                </div>
              </div>
            `;
          }).join('')}
      </div>
    </div>
  `;
}

function generateMetricsSection(status) {
  const metrics = status.metrics || {};
  const winRate = metrics.totalTrades > 0 ? 
    (metrics.winningTrades / metrics.totalTrades * 100).toFixed(1) : '0.0';
    
  return `
    <div class="card">
      <h2>📊 Métriques de Performance</h2>
      <div class="metrics">
        <div class="metric-card">
          <div class="metric-value">${metrics.totalTrades || 0}</div>
          <div class="metric-label">Total Trades</div>
        </div>
        <div class="metric-card">
          <div class="metric-value" style="color: #4CAF50;">${metrics.winningTrades || 0}</div>
          <div class="metric-label">Trades Gagnants</div>
        </div>
        <div class="metric-card">
          <div class="metric-value" style="color: #f44336;">${metrics.losingTrades || 0}</div>
          <div class="metric-label">Trades Perdants</div>
        </div>
        <div class="metric-card">
          <div class="metric-value" style="color: #2196F3;">${winRate}%</div>
          <div class="metric-label">Win Rate</div>
        </div>
        <div class="metric-card">
          <div class="metric-value" style="color: #ff9800;">${metrics.maxDrawdown?.toFixed(2) || '0.00'}%</div>
          <div class="metric-label">Max Drawdown</div>
        </div>
      </div>
    </div>
  `;
}

function generatePositionsSection(status) {
  return `
    <div class="card">
      <h2>📈 Positions Ouvertes</h2>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px;">
        <div style="background: #e3f2fd; padding: 15px; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.5em; font-weight: bold; color: #4CAF50;">${status.openPositions}</div>
          <div style="color: #666;">Positions LONG</div>
        </div>
        <div style="background: #fff3e0; padding: 15px; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.5em; font-weight: bold; color: #ff9800;">${status.shortPositions}</div>
          <div style="color: #666;">Positions SHORT</div>
        </div>
        <div style="background: #f3e5f5; padding: 15px; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.5em; font-weight: bold; color: #9c27b0;">${status.config?.maxPositions || 3}</div>
          <div style="color: #666;">Maximum Autorisé</div>
        </div>
      </div>
      
      ${status.openPositions === 0 && status.shortPositions === 0 ? 
        '<p style="text-align: center; color: #666; margin-top: 20px;">🔍 Aucune position ouverte - Le bot recherche des opportunités...</p>' :
        '<p style="text-align: center; color: #4CAF50; margin-top: 20px;">✅ Positions actives - Le bot gère vos trades automatiquement</p>'
      }
    </div>
  `;
}

// Serveur Express
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

  // Interface web transactions AMÉLIORÉE
  app.get('/transactions/view', (req, res) => {
    try {
      const status = bot.getStatus();
      
      if (!fs.existsSync('transactions.log')) {
        return res.send(`
          <html>
            <head>
              <title>Bot Sécurisé - Portfolio Détaillé</title>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="font-family: Arial; padding: 20px; background: #f5f5f5;">
              <h1>🤖 Bot Ichimoku Sécurisé - Portfolio</h1>
              <div style="background: #fff3cd; padding: 15px; border-radius: 5px; border-left: 4px solid #ffc107;">
                <h3>⚠️ Aucune transaction trouvée</h3>
                <p>Le bot n'a pas encore effectué de trades.</p>
              </div>
              ${generatePortfolioSection(status)}
              <div style="background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <h3>⚙️ Configuration Sécurisée</h3>
                <p><strong>Risk par trade:</strong> ${status.config?.riskPercentage || 2}%</p>
                <p><strong>Max positions:</strong> ${status.config?.maxPositions || 3}</p>
                <p><strong>Max drawdown:</strong> ${status.config?.maxDrawdown || 20}%</p>
                <p><strong>Cycle:</strong> ${(status.config?.cycleInterval || 300000) / 1000 / 60} minutes</p>
              </div>
              <p><a href="/status" style="color: #2196F3;">📈 Voir statut JSON</a></p>
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
        .slice(-30)
        .reverse();

      const html = `
        <html>
          <head>
            <title>Bot Sécurisé - Portfolio & Transactions</title>
            <meta http-equiv="refresh" content="30">
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { 
                font-family: 'Segoe UI', Arial, sans-serif; 
                margin: 0; 
                padding: 20px; 
                background: #f8f9fa; 
                color: #333;
              }
              .container { max-width: 1200px; margin: 0 auto; }
              .header { 
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                color: white; 
                padding: 20px; 
                border-radius: 10px; 
                margin-bottom: 20px; 
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
              }
              .card { 
                background: white; 
                padding: 20px; 
                margin: 15px 0; 
                border-radius: 10px; 
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                border-left: 5px solid #2196F3;
              }
              .portfolio-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                gap: 20px;
                margin: 20px 0;
              }
              .asset-card {
                background: white;
                padding: 15px;
                border-radius: 8px;
                border-left: 4px solid #4CAF50;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
              }
              .asset-card.zero { border-left-color: #ccc; opacity: 0.6; }
              .asset-amount {
                font-size: 1.2em;
                font-weight: bold;
                color: #2196F3;
              }
              .asset-value {
                color: #4CAF50;
                font-weight: bold;
              }
              .transaction { 
                background: white; 
                padding: 15px; 
                margin: 8px 0; 
                border-radius: 8px; 
                border-left: 4px solid #4CAF50;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
              }
              .buy { border-left-color: #4CAF50; }
              .sell { border-left-color: #f44336; }
              .short { border-left-color: #ff9800; }
              .cover, .cover1, .cover2, .cover_sl { border-left-color: #9c27b0; }
              .tp1, .tp2 { border-left-color: #00bcd4; }
              .timestamp { 
                color: #666; 
                font-size: 0.85em; 
                margin-bottom: 5px;
              }
              .trade-info {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
                margin: 10px 0;
              }
              .metrics {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 15px;
                margin: 20px 0;
              }
              .metric-card {
                background: white;
                padding: 15px;
                border-radius: 8px;
                text-align: center;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
              }
              .metric-value {
                font-size: 1.8em;
                font-weight: bold;
                color: #2196F3;
              }
              .metric-label {
                color: #666;
                font-size: 0.9em;
                margin-top: 5px;
              }
              .status-running { color: #4CAF50; }
              .status-stopped { color: #f44336; }
              .nav {
                display: flex;
                gap: 15px;
                flex-wrap: wrap;
                margin-top: 10px;
              }
              .nav a {
                color: white;
                text-decoration: none;
                background: rgba(255,255,255,0.2);
                padding: 8px 15px;
                border-radius: 5px;
                transition: background 0.3s;
              }
              .nav a:hover {
                background: rgba(255,255,255,0.3);
              }
              @media (max-width: 768px) {
                .trade-info { grid-template-columns: 1fr; }
                .portfolio-grid { grid-template-columns: 1fr; }
                .metrics { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🤖 Bot Ichimoku - Portfolio & Transactions Live</h1>
                <p><strong>Dernière mise à jour:</strong> ${new Date().toLocaleString()}</p>
                <p><strong>État:</strong> <span class="${status.isRunning ? 'status-running' : 'status-stopped'}">${status.isRunning ? '🟢 Actif' : '🔴 Arrêté'}</span> | <strong>Cycle:</strong> ${status.cycleCount}</p>
                <div class="nav">
                  <a href="/">🏠 Accueil</a>
                  <a href="/status">📊 JSON</a>
                  <a href="/transactions/download">💾 Télécharger</a>
                  <a href="/transactions/view">🔄 Actualiser</a>
                </div>
              </div>

              ${generatePortfolioSection(status)}
              ${generateMetricsSection(status)}
              ${generatePositionsSection(status)}
              
              <div class="card">
                <h2>📈 Historique des Transactions (${transactions.length} dernières)</h2>
                ${transactions.length === 0 ? '<p style="text-align: center; color: #666;">Aucune transaction</p>' : ''}
                
                ${transactions.map(t => `
                  <div class="transaction ${t.type.toLowerCase()}">
                    <div class="timestamp">${new Date(t.timestamp).toLocaleString()}</div>
                    <div class="trade-info">
                      <div>
                        <strong>${t.symbol}</strong> - <span style="font-weight: bold;">${t.type}</span><br>
                        <span style="color: #666;">Quantité: ${parseFloat(t.amount).toFixed(6)}</span><br>
                        <span style="color: #666;">Prix: ${parseFloat(t.price).toFixed(6)} USDT</span>
                      </div>
                      <div>
                        <strong>Portfolio après trade:</strong><br>
                        <span style="color: #4CAF50;">💰 USDT: ${parseFloat(t.portfolio.USDT).toFixed(2)}</span><br>
                        ${t.totalValue ? `<span style="color: #2196F3;">📊 Total: $${parseFloat(t.totalValue).toFixed(2)}</span><br>` : ''}
                        ${t.drawdown ? `<span style="color: #ff9800;">📉 Drawdown: ${parseFloat(t.drawdown).toFixed(2)}%</span>` : ''}
                      </div>
                    </div>
                  </div>
                `).join('')}
              </div>
              
              <div class="card">
                <p style="text-align: center; color: #666;">
                  🔄 <strong>Auto-refresh toutes les 30 secondes</strong><br>
                  <small>Bot version: Ichimoku Sécurisé v2.0 | Risk: ${status.config?.riskPercentage || 2}% | Max positions: ${status.config?.maxPositions || 3}</small>
                </p>
              </div>
            </div>
          </body>
        </html>
      `;

      res.send(html);
    } catch (error) {
      res.status(500).send(`<h1>Erreur: ${error.message}</h1>`);
    }
  });

  app.get('/transactions/download', (req, res) => {
    try {
      if (!fs.existsSync('transactions.log')) {
        return res.status(404).json({ error: 'Fichier non trouvé' });
      }
      
      res.download('transactions.log', 'transactions.log', (err) => {
        if (err) {
          res.status(500).json({ error: 'Erreur téléchargement: ' + err.message });
        }
      });
    } catch (error) {
      res.status(500).json({ error: 'Erreur: ' + error.message });
    }
  });

  app.get('/logs', (req, res) => {
    const logs = [];
    
    if (fs.existsSync('transactions.log')) {
      const transactionLogs = fs.readFileSync('transactions.log', 'utf8')
        .split('\n')
        .filter(line => line.trim())
        .slice(-20);
      logs.push(...transactionLogs);
    }
    
    res.json({
      logs: logs,
      count: logs.length,
      lastUpdate: new Date().toISOString()
    });
  });

  app.get('/', (req, res) => {
    const status = bot.getStatus();
    const html = `
      <html>
        <head>
          <title>Ichimoku Trading Bot Sécurisé</title>
          <meta http-equiv="refresh" content="60">
          <style>
            body { font-family: Arial; margin: 20px; background: #f0f0f0; }
            .card { background: white; padding: 20px; margin: 10px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            .status-running { color: #4CAF50; }
            .status-stopped { color: #f44336; }
            .nav { background: #2196F3; color: white; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
            .nav a { color: white; text-decoration: none; margin: 0 15px; }
            .security-banner { background: #e8f5e8; padding: 15px; border-radius: 5px; border-left: 4px solid #4CAF50; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="nav">
            <h1>🤖 Bot Ichimoku Sécurisé</h1>
            <nav>
              <a href="/">🏠 Accueil</a>
              <a href="/transactions/view">📊 Portfolio Détaillé</a>
              <a href="/status">📈 Statut JSON</a>
              <a href="/transactions/download">💾 Télécharger logs</a>
            </nav>
          </div>
          
          <div class="security-banner">
            <h3>✅ Mode Sécurisé Activé</h3>
            <p><strong>Risk par trade:</strong> ${status.config?.riskPercentage || 2}% (au lieu de 25%)</p>
            <p><strong>Max positions:</strong> ${status.config?.maxPositions || 3} simultanées</p>
            <p><strong>Protection drawdown:</strong> ${status.config?.maxDrawdown || 20}% maximum</p>
            <p><strong>Cycle trading:</strong> ${(status.config?.cycleInterval || 300000) / 1000 / 60} minutes (au lieu de 30s)</p>
          </div>
          
          <div class="card">
            <h2>📊 Statut du Bot</h2>
            <p><strong>État:</strong> <span class="${status.isRunning ? 'status-running' : 'status-stopped'}">${status.isRunning ? '🟢 Actif' : '🔴 Arrêté'}</span></p>
            <p><strong>Cycles:</strong> ${status.cycleCount}</p>
            <p><strong>Valeur portefeuille:</strong> $${status.totalValue.toFixed(2)}</p>
            <p><strong>Positions ouvertes:</strong> ${status.openPositions} LONG, ${status.shortPositions} SHORT</p>
            <p><strong>Symboles surveillés:</strong> ${status.symbols.length}</p>
            <p><strong>Dernière maj:</strong> ${new Date().toLocaleString()}</p>
          </div>
          
          <div class="card">
            <h2>📈 Performance</h2>
            <p><strong>Total trades:</strong> ${status.metrics?.totalTrades || 0}</p>
            <p><strong>Trades gagnants:</strong> ${status.metrics?.winningTrades || 0}</p>
            <p><strong>Win rate:</strong> ${status.metrics?.totalTrades > 0 ? (status.metrics.winningTrades / status.metrics.totalTrades * 100).toFixed(1) : '0.0'}%</p>
            <p><strong>Drawdown actuel:</strong> ${status.metrics?.currentDrawdown?.toFixed(2) || '0.00'}%</p>
            <p><strong>Max drawdown:</strong> ${status.metrics?.maxDrawdown?.toFixed(2) || '0.00'}%</p>
          </div>
          
          <div class="card">
            <p><em>🔄 Page mise à jour automatiquement toutes les 60 secondes</em></p>
            <p><small>Bot version: Ichimoku Sécurisé v2.0</small></p>
          </div>
        </body>
      </html>
    `;
    res.send(html);
  });
  
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`🌐 Serveur Express démarré sur le port ${PORT}`);
  });
  
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
  
  try {
    await bot.start();
  } catch (error) {
    console.error('❌ Erreur lors du démarrage du bot:', error);
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