module.exports = {
  exchange: 'binance',
    symbols: [
    'BTC/USDT', 'ETH/USDT', 'SUI/USDT',
    'DOGE/USDT', 'SHIB/USDT',    'SOL/USDT',  'ACH/USDT',  'BEL/USDT'
  ],
  initialCapital: 1000,
  riskPercentage: 30,
  maxPositions: 10,
  maxDrawdown: 20,
  cycleInterval: 60000, // 60s
  timeframes: ['15m', '1h', '4h', '1d'],
  priceValidation: {
    maxSpreadPercent: 0.2,
    minVolume: 10000
  },
  ichimoku: {
    conversionPeriod: 9,
    basePeriod: 26,
    spanPeriod: 52,
    displacement: 26
  },
  stopLoss: {
    atrPeriod: 14,
    atrMultiplier: 2
  },
  trailing: {
    atrMultiplier: 1.5
  },
  dynamicSizing: {
    atrThreshold: 10,
    riskReduction: 0.5
  },
  antiRange: {
    adxPeriod: 14,
    adxThreshold: 20
  },
  apiSettings: {
    enableRateLimit: true,
    rateLimit: 250,
    retryAttempts: 5,
    retryDelay: 1000
  }
};
