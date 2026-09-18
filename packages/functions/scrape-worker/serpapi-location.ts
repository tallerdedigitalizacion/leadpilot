// Compartido entre serpapi-provider.ts y serpapi-web-provider.ts — es una quirk de la API
// de SerpApi (no lógica de negocio de ningún provider en particular), así que a diferencia
// del resto de cada provider (que se mantiene autocontenido) esto sí se comparte.
const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// El parámetro location de SerpApi rechaza abreviaturas de 2 letras pegadas al nombre
// ("Fort Worth TX" y "Fort Worth, TX" ambas fallan con 400), pero sí acepta el nombre
// completo del estado ("Fort Worth, Texas"). El scheduler automático usa "Ciudad ST" para
// sus 50 ciudades — se expande aquí. Si no matchea (ciudad manual, extranjera, o ya en
// formato completo), se pasa tal cual.
export function toSerpApiLocation(city: string): string {
  const match = city.trim().match(/^(.+?)\s+([A-Z]{2})$/);
  const stateName = match && US_STATE_NAMES[match[2]];
  return stateName ? `${match[1]}, ${stateName}, United States` : city;
}
