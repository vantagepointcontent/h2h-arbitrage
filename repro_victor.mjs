
import { calculateArbitrageMax, computeArbitrageFees, getPolymarketTheta, calcKalshiFee, calcPolymarketFee } from '/home/scott/h2h-arbitrage/src/lib/matcher';

const scenarios = [
  { kNo: 0.48, pYes: 0.55, label: 'Victor-like (kNo=0.48, pYes=0.55)' },
  { kNo: 0.45, pYes: 0.52, label: 'Near break-even (kNo=0.45, pYes=0.52)' },
  { kNo: 0.45, pYes: 0.48, label: 'Profitable before fees (kNo=0.45, pYes=0.48)' },
  { kNo: 0.48, pYes: 0.51, label: 'Slight loss (kNo=0.48, pYes=0.51)' },
];

for (const s of scenarios) {
  const kShape = { ticker: 'KX-TEST', yesBid: 0.50, yesAsk: 0.52, noBid: 0.47, noAsk: s.kNo, lastPrice: 0.50 };
  const pmShape = { marketId: 'm1', conditionId: 'abc', yesPrice: s.pYes, noPrice: 1 - s.pYes, bestBid: s.pYes - 0.01, bestAsk: s.pYes + 0.01, lastTradePrice: s.pYes };
  const capital = 1000;
  const res = calculateArbitrageMax(kShape, pmShape, 0, capital * 2, capital * 2, 0, 'sports', capital);

  console.log('\n===', s.label, '===');
  console.log('Strategy:', res.strategy);
  console.log('Kalshi NO ask:', s.kNo.toFixed(2), 'PM YES ask:', s.pYes.toFixed(2));
  console.log('Combined cost:', (s.kNo + s.pYes).toFixed(2));
  console.log('ROI%:', res.roiPct.toFixed(2));
  console.log('Expected net profit:', res.expectedProfit.toFixed(2));
  console.log('Kalshi stake:', res.kalshiStake.toFixed(2), 'PM stake:', res.pmStake.toFixed(2));
  console.log('Fees:', res.fees ? `Kalshi=${res.fees.kalshiFee.toFixed(3)} PM=${res.fees.pmFee.toFixed(3)}` : 'none');

  const fees = computeArbitrageFees(
    'Buy YES PM + NO Kalshi',
    capital,
    capital * s.kNo,
    capital * s.pYes,
    0.52,
    s.kNo,
    s.pYes,
    1 - s.pYes,
    'sports'
  );
  console.log('Manual gross profit:', fees.grossProfit.toFixed(2));
  console.log('Manual worstCaseNetProfit:', fees.worstCaseNetProfit.toFixed(2));
  const theta = getPolymarketTheta('sports');
  const kalshiContracts = capital;
  const pmContracts = capital;
  const kFee = calcKalshiFee(kalshiContracts, s.kNo);
  const pFee = calcPolymarketFee(pmContracts, s.pYes, theta);
  console.log('Manual fees: Kalshi=' + kFee.toFixed(3) + ' PM=' + pFee.toFixed(3) + ' (theta=' + theta + ')');
  console.log('Net = gross - totalFees = ' + fees.grossProfit.toFixed(2) + ' - ' + (kFee + pFee).toFixed(3) + ' = ' + (fees.grossProfit - kFee - pFee).toFixed(3));
}
