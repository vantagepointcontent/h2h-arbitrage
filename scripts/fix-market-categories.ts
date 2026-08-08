import { classifyMarket, parseMarketDomain } from '../src/lib/market-classification';
import { getSavedMarkets, updateSavedMarket } from '../src/lib/persistence';

async function main(): Promise<void> {
  const markets = await getSavedMarkets({ includeArchived: true });
  let updated = 0;

  for (const market of markets) {
    const parsedCategory = parseMarketDomain(market.category);
    if (parsedCategory && market.category === parsedCategory) continue;
    const category = parsedCategory ?? classifyMarket(market.eventTitle || '').domain;
    if (await updateSavedMarket(market.id, { category })) updated += 1;
  }

  console.log(JSON.stringify({ inspected: markets.length, updated }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});