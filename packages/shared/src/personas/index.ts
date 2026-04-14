/**
 * @fileoverview Persona catalog — imports all persona templates.
 *
 * Each persona is in its own file for maintainability.
 * Add new personas by creating a file and importing here.
 *
 * @module @slackhive/shared/personas
 */

export type { PersonaTemplate, PersonaSkillSeed, PersonaCategory } from './types';

import type { PersonaTemplate, PersonaCategory } from './types';

import BACKEND_ENGINEER from './backend-engineer';
import FRONTEND_ENGINEER from './frontend-engineer';
import FULLSTACK_ENGINEER from './fullstack-engineer';
import MOBILE_ENGINEER from './mobile-engineer';
import DEVOPS_SRE from './devops-sre';
import ML_AI_ENGINEER from './ml-ai-engineer';
import QA_TEST_ENGINEER from './qa-test-engineer';

export const PERSONA_CATALOG: PersonaTemplate[] = [
  BACKEND_ENGINEER,
  FRONTEND_ENGINEER,
  FULLSTACK_ENGINEER,
  MOBILE_ENGINEER,
  DEVOPS_SRE,
  ML_AI_ENGINEER,
  QA_TEST_ENGINEER,
];

export function getPersonaById(id: string): PersonaTemplate | undefined {
  return PERSONA_CATALOG.find(p => p.id === id);
}

export function getPersonasByCategory(category: PersonaCategory): PersonaTemplate[] {
  return PERSONA_CATALOG.filter(p => p.category === category);
}

export function searchPersonas(query: string): PersonaTemplate[] {
  const q = query.toLowerCase().trim();
  if (!q) return PERSONA_CATALOG;
  return PERSONA_CATALOG.filter(p =>
    p.name.toLowerCase().includes(q) ||
    p.cardDescription.toLowerCase().includes(q) ||
    p.tags.some(t => t.includes(q))
  );
}
