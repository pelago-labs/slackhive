/**
 * @fileoverview Re-export from personas/ folder.
 * Each persona is now in its own file under personas/.
 * @module @slackhive/shared/persona-templates
 */

export {
  PERSONA_CATALOG,
  getPersonaById,
  getPersonasByCategory,
  searchPersonas,
} from './personas';

export type {
  PersonaTemplate,
  PersonaSkillSeed,
  PersonaCategory,
} from './personas';
