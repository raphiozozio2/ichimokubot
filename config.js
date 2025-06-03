module.exports = {
  mode: 'live',
  initialCapital: 1000,
  cycleInterval: 300000, // 5 minutes au lieu de 30s (CRITIQUE)
  exchange: 'binance',
  symbols: [
    'BTC/USDT', 'ETH/USDT',
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
  riskPercentage: 2, // 2% au lieu de 25% (CRITIQUE)
  maxPositions: 3,   // Maximum 3 positions simultanées (CRITIQUE)
  maxDrawdown: 20,   // Arrêt si perte 20% (CRITIQUE)
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
    rateLimit: 1200, // Plus restrictif (IMPORTANT)
    enableRateLimit: true,
    retryAttempts: 3, // Retry automatique (IMPORTANT)
    retryDelay: 2000  // 2s entre retries (IMPORTANT)
  },
  priceValidation: {
    maxSpreadPercent: 0.2, // 0.2% au lieu de 0.5% (IMPORTANT)
    minVolume: 1000        // Volume minimum (IMPORTANT)
  }
};