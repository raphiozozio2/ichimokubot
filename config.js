module.exports = {
  mode: 'live',
  initialCapital: 1000,
  cycleInterval: 10000, // 1 minutes entre chaque cycle (300000ms)
  exchange: 'binance',
  symbols: [
    'LINK/USDT', 'NEAR/USDT', 'APT/USDT',
    'RNDR/USDT', 'ARB/USDT', 'SUI/USDT',
    'DOGE/USDT', 'SHIB/USDT', 'LDO/USDT',
    'SOL/USDT', 'BTG/USDT', 'ACH/USDT',
    'BEL/USDT'
  ],
  timeframes: ['15m', '1h', '4h', '1d'],
  backtest: {
    startDate: '2020-01-01',
    endDate: '2024-01-01'
  },
  riskPercentage: 25,
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
    ratios: [0.5, 0.5],
    target: 0.15,
    trailing: true
  },
  shorting: {
    maxExposure: 0.3,
    hedgeRatio: 0.5
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