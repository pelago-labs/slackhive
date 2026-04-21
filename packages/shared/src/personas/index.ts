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
import SECURITY_ENGINEER from './security-engineer';
import DATA_ANALYST from './data-analyst';
import DATA_SCIENTIST from './data-scientist';
import DATA_ENGINEER from './data-engineer';
import ANALYTICS_ENGINEER from './analytics-engineer';
import PRODUCT_MANAGER from './product-manager';
import TECHNICAL_WRITER from './technical-writer';
import UX_DESIGNER from './ux-designer';
import BUSINESS_ANALYST from './business-analyst';
import CUSTOMER_SUPPORT from './customer-support';
import CUSTOMER_SUCCESS from './customer-success';
import SALES_SDR from './sales-sdr';
import MARKETING_GROWTH from './marketing-growth';
import HR_RECRUITER from './hr-recruiter';
import FINANCE_ACCOUNTING from './finance-accounting';
import LEGAL_COMPLIANCE from './legal-compliance';
import SEO_SPECIALIST from './seo-specialist';
import BLANK from './blank';
import GENERALIST from './generalist';

export const PERSONA_CATALOG: PersonaTemplate[] = [
  // Engineering
  BACKEND_ENGINEER,
  FRONTEND_ENGINEER,
  FULLSTACK_ENGINEER,
  MOBILE_ENGINEER,
  DEVOPS_SRE,
  ML_AI_ENGINEER,
  QA_TEST_ENGINEER,
  SECURITY_ENGINEER,
  // Data
  DATA_ANALYST,
  DATA_SCIENTIST,
  DATA_ENGINEER,
  ANALYTICS_ENGINEER,
  // Product
  PRODUCT_MANAGER,
  TECHNICAL_WRITER,
  UX_DESIGNER,
  // Business
  BUSINESS_ANALYST,
  CUSTOMER_SUPPORT,
  CUSTOMER_SUCCESS,
  SALES_SDR,
  MARKETING_GROWTH,
  HR_RECRUITER,
  FINANCE_ACCOUNTING,
  LEGAL_COMPLIANCE,
  SEO_SPECIALIST,
  // Generic
  BLANK,
  GENERALIST,
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
