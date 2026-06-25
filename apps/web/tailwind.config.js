/** @type {import('tailwindcss').Config} */
module.exports = {
  // shadcn `dark:` variants key off our existing `[data-theme="dark"]` attribute
  // (set pre-paint by the <head> script in layout.tsx) — NOT next-themes/.dark —
  // so the current toggle + no-FOUC behaviour is preserved.
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // ── shadcn token contract ────────────────────────────────────────────
        // Backed by `--sd-*` HSL channel vars (defined in globals.css) so they
        // never clobber the legacy hex tokens (--border/--muted/--accent) that
        // un-migrated inline styles still read. Standard class names (bg-primary,
        // border-border, …) work unchanged so generated shadcn components are
        // drop-in. `<alpha-value>` enables /opacity modifiers.
        border: 'hsl(var(--sd-border) / <alpha-value>)',
        input: 'hsl(var(--sd-input) / <alpha-value>)',
        ring: 'hsl(var(--sd-ring) / <alpha-value>)',
        background: 'hsl(var(--sd-background) / <alpha-value>)',
        foreground: 'hsl(var(--sd-foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--sd-primary) / <alpha-value>)',
          foreground: 'hsl(var(--sd-primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--sd-secondary) / <alpha-value>)',
          foreground: 'hsl(var(--sd-secondary-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--sd-destructive) / <alpha-value>)',
          foreground: 'hsl(var(--sd-destructive-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--sd-muted) / <alpha-value>)',
          foreground: 'hsl(var(--sd-muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--sd-accent) / <alpha-value>)',
          foreground: 'hsl(var(--sd-accent-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--sd-popover) / <alpha-value>)',
          foreground: 'hsl(var(--sd-popover-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--sd-card) / <alpha-value>)',
          foreground: 'hsl(var(--sd-card-foreground) / <alpha-value>)',
        },
        // ── legacy aliases (transitional) ────────────────────────────────────
        // Let migrating code use `bg-surface`/`text-subtle` etc. while the hex
        // tokens still back inline styles. Alpha-aware (hsl(var(--…) / <alpha-value>))
        // so opacity modifiers like `bg-blue/10` actually emit CSS — the colors
        // here are mirrored as HSL-channel vars in globals.css. Removed in Phase 5.
        surface: 'hsl(var(--sd-card) / <alpha-value>)',
        'surface-2': 'hsl(var(--sd-secondary) / <alpha-value>)',
        'surface-3': 'var(--surface-3)',
        'text-2': 'var(--text-2)',
        subtle: 'var(--subtle)',
        brand: 'hsl(var(--sd-primary) / <alpha-value>)',
        'brand-fg': 'hsl(var(--sd-primary-foreground) / <alpha-value>)',
        blue: 'hsl(var(--blue-hsl) / <alpha-value>)',
        green: 'hsl(var(--green-hsl) / <alpha-value>)',
        red: 'hsl(var(--red-hsl) / <alpha-value>)',
        amber: 'hsl(var(--amber-hsl) / <alpha-value>)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['var(--font-jb-mono)', 'JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Type scale collapsing the 12/12.5/13/13.5 drift onto 11/12/13/14/16/18/20/24/30.
        // tuple = [size, { lineHeight, letterSpacing }]. Defaults kept for xs(12)/lg(18)/xl(20).
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],      // 11 — captions/labels
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],                               // 13 — body-small (override 14)
        base: ['0.875rem', { lineHeight: '1.5rem' }],                               // 14 — body (override 16)
        md: ['1rem', { lineHeight: '1.5rem' }],                                     // 16 — subtitle
        '2xl': ['1.5rem', { lineHeight: '1.875rem', letterSpacing: '-0.02em' }],    // 24 — h2 (tight)
        '3xl': ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em' }],   // 30 — h1 (tight)
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-md)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        card: 'var(--shadow-card)',
        hover: 'var(--shadow-hover)',
        modal: 'var(--shadow-modal)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
