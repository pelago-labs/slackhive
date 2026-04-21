/**
 * @fileoverview Persona template types.
 * @module @slackhive/shared/personas/types
 */

export type PersonaCategory =
  | 'engineering' | 'data' | 'product' | 'design'
  | 'business' | 'support' | 'marketing' | 'generic';

export interface PersonaSkillSeed {
  category: string;
  filename: string;
  sortOrder: number;
  content: string;
}

export interface PersonaTemplate {
  id: string;
  name: string;
  cardDescription: string;
  category: PersonaCategory;
  tags: string[];
  description: string;
  persona: string;
  claudeMd: string;
  skills: PersonaSkillSeed[];
}
