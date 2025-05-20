module.exports = {
  mode: 'backtest', // 'live' ou 'backtest'
  initialCapital: 10000,
  exchange: 'binance',
  symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
  timeframes: ['15m', '1h', '4h', '1d'],
  
  backtest: {
    startDate: '2020-01-01',
    endDate: '2024-01-01'
  },

  riskPercentage: 5,
  dynamicSizing: {
    atrThreshold: 50,
    riskReduction: 0.5
  },

  ichimoku: {
    conversionPeriod: 9,
    basePeriod: 26,
    spanPeriod: 52,
    displacement: 26
  },

  stopLoss: {
    atrMultiplier: 1.5,
    atrPeriod: 14
  },

  trailing: {
    atrMultiplier: 1.0
  },

  takeProfit: {
    atrMultipliers: [1, 2],
    ratios: [0.5, 0.5]
  },

  antiRange: {
    adxPeriod: 14,
    adxThreshold: 25
  },

  apiSettings: {
    rateLimit: 30000,
    enableRateLimit: true
  }
};
