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
  timeframes: ['15m', '1h', '4h'], // Timeframes plus longs
  simulationDuration: 20,
  riskPercentage: 5, // Risque réduit à 5%
  
  ichimoku: {
    conversionPeriod: 9,  // Paramètres standard
    basePeriod: 26,
    spanPeriod: 52,
    displacement: 26
  },
  
  apiSettings: {
    rateLimit: 30000,
    enableRateLimit: true
  }
};
