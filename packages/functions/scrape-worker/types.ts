export interface ScrapedLead {
  businessName: string;
  url: string;
  phone?: string;
  email?: string;
  city?: string;
  category?: string;
  sponsored?: boolean;
  leadSource?: 'maps' | 'serp';
  vertical?: string;
  campaignId?: string;
}

export interface ProviderResult {
  rows: number;
  leads: ScrapedLead[];
}
