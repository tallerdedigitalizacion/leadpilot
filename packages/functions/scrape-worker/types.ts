export interface ScrapedLead {
  businessName: string;
  url: string;
  phone?: string;
  email?: string;
  city?: string;
  category?: string;
  sponsored?: boolean;
}

export interface ProviderResult {
  rows: number;
  leads: ScrapedLead[];
}
