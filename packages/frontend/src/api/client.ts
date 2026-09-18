import type { LeadItem, LeadStatus, ScrapeJob } from '../types/lead';

const BASE_URL = import.meta.env.VITE_API_BASE_URL as string;
const API_KEY = import.meta.env.VITE_API_KEY as string;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listLeads(status: LeadStatus, cursor?: string): Promise<{ leads: LeadItem[]; nextCursor?: string }> {
    const params = new URLSearchParams({ status });
    if (cursor) params.set('cursor', cursor);
    return request(`/leads?${params}`);
  },

  getLead(leadId: string): Promise<LeadItem> {
    return request(`/leads/${leadId}`);
  },

  updateStatus(leadId: string, status: LeadStatus, note?: string, myNotes?: string): Promise<LeadItem> {
    return request(`/leads/${leadId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, note, myNotes }),
    });
  },

  updateNotes(leadId: string, myNotes: string): Promise<LeadItem> {
    return request(`/leads/${leadId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ myNotes }),
    });
  },

  markLinkedinPublished(leadId: string): Promise<LeadItem> {
    return request(`/leads/${leadId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ linkedinPublished: true }),
    });
  },

  // Botón de prueba manual — dispara el seguimiento 1, 2, o el personalizado post-click
  // ('engaged') al instante, sin esperar 5/7/14 días reales.
  async simulateFollowup(
    leadId: string,
    followupNumber: 1 | 2 | 'engaged'
  ): Promise<{ ok: boolean; error?: string; lead?: LeadItem }> {
    try {
      const res = await fetch(`${BASE_URL}/leads/${leadId}/simulate-followup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify(
          followupNumber === 'engaged' ? { branch: 'engaged' } : { followupNumber }
        ),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: data?.error ?? `${res.status} ${res.statusText}` };
      return { ok: true, lead: data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Error de red' };
    }
  },

  triggerReport(leadId: string): Promise<{ message: string; leadId: string }> {
    return request(`/leads/${leadId}/report`, { method: 'POST' });
  },

  // Never throws on a failed send — the whole point is to force the caller to check `ok`
  // instead of assuming a resolved promise means the email actually landed.
  async sendEmail(
    leadId: string,
    emailSubject: string,
    emailBody: string,
    toSelf = false,
    toAddresses?: string[]
  ): Promise<{ ok: boolean; preview?: boolean; error?: string; lead?: LeadItem }> {
    try {
      const res = await fetch(`${BASE_URL}/leads/${leadId}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ emailSubject, emailBody, toSelf, toAddresses }),
      });
      const data = await res.json().catch(() => null);
      if (!data || typeof data.ok !== 'boolean') {
        return { ok: false, error: `${res.status} ${res.statusText}` };
      }
      return data;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Error de red al enviar el email' };
    }
  },

  updateEmails(leadId: string, emails: string[]): Promise<LeadItem> {
    return request(`/leads/${leadId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ emails }),
    });
  },

  getStats(): Promise<{ counts: Record<string, number> }> {
    return request('/stats');
  },

  retryAnalysis(leadId: string): Promise<{ message: string; leadId: string }> {
    return request(`/leads/${leadId}/analyze`, { method: 'POST' });
  },

  updatePagespeed(leadId: string, data: {
    strategy: 'mobile' | 'desktop';
    rawText: string;
  }): Promise<LeadItem> {
    return request(`/leads/${leadId}/pagespeed`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  deleteLead(leadId: string): Promise<{ deleted: boolean; leadId: string }> {
    return request(`/leads/${leadId}`, { method: 'DELETE' });
  },

  regenEmail(leadId: string): Promise<LeadItem> {
    return request(`/leads/${leadId}/regen-email`, { method: 'POST' });
  },

  addLead(lead: {
    businessName: string;
    url: string;
    city?: string;
    category?: string;
    phone?: string;
    email?: string;
  }): Promise<{ created: number; skipped: number; ids: string[] }> {
    return request('/leads', {
      method: 'POST',
      body: JSON.stringify({ leads: [lead] }),
    });
  },

  startScrapeJob(input: { query: string; city: string; extractEmails: boolean; provider?: 'gosom' | 'serpapi' | 'serpapi-web'; campaignId?: string }): Promise<{ jobId: string }> {
    return request('/scrape-jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  getScrapeJob(jobId: string): Promise<ScrapeJob> {
    return request(`/scrape-jobs/${jobId}`);
  },

  getUnsubscribeInfo(leadId: string, token: string): Promise<{ businessName?: string; email?: string }> {
    return request(`/u/${leadId}?t=${encodeURIComponent(token)}`);
  },

  confirmUnsubscribe(leadId: string, token: string): Promise<{ unsubscribed: boolean }> {
    return request(`/u/${leadId}/confirm?t=${encodeURIComponent(token)}`, { method: 'POST' });
  },
};
