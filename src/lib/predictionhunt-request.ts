export type SavePredictionHuntMarketRequest = {
  kalshiUrl: string;
  polymarketUrl: string;
  title: string;
  category: string;
  expiryDate: string | null;
};

export function parseSavePredictionHuntMarketRequest(
  body: Record<string, unknown>,
): SavePredictionHuntMarketRequest | { error: string } {
  const kalshiUrl = typeof body.kalshiUrl === 'string' ? body.kalshiUrl.trim() : '';
  const polymarketUrl = typeof body.polymarketUrl === 'string' ? body.polymarketUrl.trim() : '';
  if (!kalshiUrl || !polymarketUrl) return { error: 'Missing or invalid polymarketUrl or kalshiUrl' };

  return {
    kalshiUrl,
    polymarketUrl,
    title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled',
    category: typeof body.category === 'string' ? body.category.trim() : '',
    expiryDate: typeof body.expiryDate === 'string' && body.expiryDate.trim() ? body.expiryDate.trim() : null,
  };
}
