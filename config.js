module.exports = {
  exchange: 'binance',
  symbols: [
    'BTC/USDT', 'ETH/USDT',
    'DOGE/USDT', 'SHIB/USDT', 'PEPE/USDT',
    'WIF/USDT', 'FLOKI/USDT', 'BONK/USDT',
    'SOL/USDT', 'AVAX/USDT', 'MATIC/USDT',
    'XRP/USDT', 'ADA/USDT', 'DOT/USDT',
    'LINK/USDT', 'NEAR/USDT', 'APT/USDT',
    'RNDR/USDT', 'ARB/USDT', 'SUI/USDT'
  ],
  timeframes: ['15m', '1h', '4h', '1d'], // Ajout du timeframe daily
  simulationDuration: 1000000,
  riskPercentage: 5,
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
  antiRange: {
    adxPeriod: 14,
    adxThreshold: 25
  },
  apiSettings: {
    rateLimit: 30000,
    enableRateLimit: true
  }
};
