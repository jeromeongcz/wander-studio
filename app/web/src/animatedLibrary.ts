import { api } from './api';

export const VECTOR_KINDS = {
  character: 'Character',
  background: 'Background',
  prop: 'Prop',
  environment: 'Environment',
  effect: 'Effect',
} as const;
export type VectorKind = keyof typeof VECTOR_KINDS;
export interface VectorLibraryEntry {
  id: string;
  revision: string;
  name: string;
  kind: VectorKind;
  groupId: string;
  createdAt: string;
  hasRig?: boolean;
}
export const listAnimatedVectors = () => api.get<VectorLibraryEntry[]>('/animated-svg-library');
