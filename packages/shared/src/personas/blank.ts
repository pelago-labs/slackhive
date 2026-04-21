import type { PersonaTemplate } from './types';

const BLANK: PersonaTemplate = {
  id: 'blank',
  name: 'Blank',
  cardDescription: 'Start from scratch — no pre-configured persona, instructions, or skills',
  category: 'generic',
  tags: ['blank', 'custom', 'empty'],

  description: 'A blank agent with no pre-configured persona or skills. Add your own system prompt and slash commands.',

  persona: `You are a helpful AI assistant.`,

  claudeMd: ``,

  skills: [],
};

export default BLANK;
