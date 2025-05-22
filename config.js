module.exports = {
  mode: 'backtest', // 'live' ou 'backtest'
  simulationDuration: 500000, // durée de la simulation en minutes (ajouté, à ajuster selon ton besoin)
  initialCapital: 10000, // capital initial (à utiliser pour réinitialiser le portefeuille si besoin)
  exchange: 'binance',
  symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
  timeframes: ['15m', '1h', '4h', '1d'],
  backtest: {
    startDate: '2020-01-01',
    endDate: '2024-01-01'
  },
  riskPercentage: 5, // % du capital investi par signal (à diviser si plusieurs signaux simultanés)
  maxSimultaneousSignals: 3, // nombre max de signaux simultanés (ajouté, à adapter)
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
