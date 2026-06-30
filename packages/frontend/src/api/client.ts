import type { LeadItem, LeadStatus } from '../types/lead';

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

  triggerReport(leadId: string): Promise<{ message: string; leadId: string }> {
    return request(`/leads/${leadId}/report`, { method: 'POST' });
  },

  sendEmail(leadId: string): Promise<LeadItem> {
    return request(`/leads/${leadId}/send`, { method: 'POST' });
  },

  retryAnalysis(leadId: string): Promise<{ message: string; leadId: string }> {
    return request(`/leads/${leadId}/analyze`, { method: 'POST' });
  },

  updatePagespeed(leadId: string, data: {
    strategy: 'mobile' | 'desktop';
    performance: number;
    accessibility?: number;
    seo?: number;
    bestPractices?: number;
    lcp?: number;
    tbt?: number;
    speedIndex?: number;
  }): Promise<LeadItem> {
    return request(`/leads/${leadId}/pagespeed`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  deleteLead(leadId: string): Promise<{ deleted: boolean; leadId: string }> {
    return request(`/leads/${leadId}`, { method: 'DELETE' });
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
};
