// Precios de Claude en USD por millón de tokens — actualizar acá si Anthropic cambia
// precios o se agrega un modelo nuevo. Si el modelo no está en la tabla, se loguea una
// advertencia y se devuelve costo $0 en vez de tirar — nunca debe romper el pipeline real
// por un gap de pricing desactualizado.
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
};

export function computeCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING_PER_MTOK[model];
  if (!pricing) {
    console.warn(`llm-pricing: sin precio registrado para el modelo "${model}", costo logueado como 0`);
    return 0;
  }
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
