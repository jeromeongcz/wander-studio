import type { LicenseRecord } from '../license.ts';

export type ProviderKind = 'manual_import' | 'image_prompt' | 'stock_search';

/** Documented for every provider (plan section 14): free-tier limits, keys, commercial use, privacy. */
export interface ProviderTerms {
  freeTier: string;
  requiresKey: boolean;
  commercialUse: string;
  privacy: string;
  termsUrl?: string;
}

export interface BaseProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  terms: ProviderTerms;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

export interface StockResult {
  id: string;
  title: string;
  creator?: string;
  creator_url?: string;
  thumbnail_url?: string;
  download_url: string;
  landing_url?: string;
  width?: number;
  height?: number;
  license: LicenseRecord;
}

export interface StockSearchProvider extends BaseProvider {
  kind: 'stock_search';
  search(q: { query: string; page?: number; includeRestricted?: boolean }): Promise<StockResult[]>;
  fetchResult(id: string): Promise<StockResult>;
}

export interface ImagePromptProvider extends BaseProvider {
  kind: 'image_prompt';
  buildPrompt(args: { description: string; style?: string; assetType: string; aspect: string }): { prompt: string; instructions: string };
}

export type Provider = BaseProvider | StockSearchProvider | ImagePromptProvider;
