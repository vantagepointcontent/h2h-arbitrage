export async function parseJsonObject(request: Request): Promise<{ body: Record<string, unknown> } | { error: string }> {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Expected a JSON object' };
    return { body: body as Record<string, unknown> };
  } catch {
    return { error: 'Invalid JSON body' };
  }
}
