---
name: Meteorological Dark
colors:
  surface: '#051424'
  surface-dim: '#051424'
  surface-bright: '#2c3a4c'
  surface-container-lowest: '#010f1f'
  surface-container-low: '#0d1c2d'
  surface-container: '#122131'
  surface-container-high: '#1c2b3c'
  surface-container-highest: '#273647'
  on-surface: '#d4e4fa'
  on-surface-variant: '#c6c6cd'
  inverse-surface: '#d4e4fa'
  inverse-on-surface: '#233143'
  outline: '#909097'
  outline-variant: '#45464d'
  surface-tint: '#bec6e0'
  primary: '#bec6e0'
  on-primary: '#283044'
  primary-container: '#0f172a'
  on-primary-container: '#798098'
  inverse-primary: '#565e74'
  secondary: '#7bd0ff'
  on-secondary: '#00354a'
  secondary-container: '#00a6e0'
  on-secondary-container: '#00374d'
  tertiary: '#4edea3'
  on-tertiary: '#003824'
  tertiary-container: '#001c10'
  on-tertiary-container: '#009365'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#dae2fd'
  primary-fixed-dim: '#bec6e0'
  on-primary-fixed: '#131b2e'
  on-primary-fixed-variant: '#3f465c'
  secondary-fixed: '#c4e7ff'
  secondary-fixed-dim: '#7bd0ff'
  on-secondary-fixed: '#001e2c'
  on-secondary-fixed-variant: '#004c69'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#051424'
  on-background: '#d4e4fa'
  surface-variant: '#273647'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-sm:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: '1.2'
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.5'
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  data-lg:
    fontFamily: JetBrains Mono
    fontSize: 20px
    fontWeight: '500'
    lineHeight: '1.2'
  data-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.2'
  data-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: '1.2'
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '700'
    lineHeight: '1'
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 16px
  margin-mobile: 16px
  margin-desktop: 32px
  container-max: 1440px
---

## Brand & Style

This design system is engineered for high-stakes, data-intensive environments where precision and real-time decision-making are paramount. The brand personality is authoritative, technical, and analytical, bridging the gap between meteorological science and financial trading. 

The aesthetic leverages a **Terminal-Infused Glassmorphism** style. It uses deep, oceanic dark modes to provide a high-contrast foundation for vibrant, glowing data visualizations. Interface elements feel like precision instruments—highly structured, dense with information, yet visually polished through subtle translucency and sharp, architectural lines. The emotional response should be one of calm control amidst volatile environmental data.

## Colors

The palette is optimized for long-duration focus in low-light environments. 

- **Primary (Deep Navy):** Acts as the void—the base atmospheric layer. Use for all background surfaces and structural containers.
- **Secondary (Electric Blue):** The "Lidar" color. Reserved for active weather data, primary CTA paths, and interactive data points.
- **Success (Emerald Green):** Used exclusively for positive financial outcomes, "High Probability" indicators, and settled winning bets.
- **Danger (Rose Red):** Signals high-risk thresholds, heat warnings, and liquidated stakes.
- **Accents (Amber):** Used for "Best Time to Bet" alerts and critical temporal warnings (e.g., "Storm Impending").
- **Neutral (Slate):** Used for secondary labels, inactive states, and grid lines.

## Typography

The typographic system utilizes a dual-font approach to differentiate between narrative UX and technical data.

**Inter** is used for the interface architecture, providing a neutral, legible foundation for labels, navigation, and descriptions. 

**JetBrains Mono** is employed for all variable data—odds, timestamps, coordinates, and strike prices. This ensures that numerical values align vertically in tables and charts, facilitating rapid scanning of shifting digits. 

For mobile, `display-lg` should scale down to 32px. All data-centric text must maintain a minimum weight of 400 to ensure legibility against dark, blurred backgrounds.

## Layout & Spacing

This design system uses a **Strict Fluid Grid** modeled after financial dashboards. 

- **Grid:** 12-column system for desktop, 4-column for mobile.
- **Rhythm:** A 4px baseline grid governs all spacing. Use increments of 8px (2 units) for standard padding and 16px (4 units) for logical section separation.
- **Density:** High. Components should be compact to maximize "above the fold" data visibility. 
- **Adaptation:** On mobile, complex data tables reflow into "Card-Stacks" with sticky headers for the primary metric (e.g., the current temperature or odds ratio).

## Elevation & Depth

Depth is achieved through **Luminescent Glassmorphism** rather than traditional shadows.

1.  **Base Layer:** Solid Deep Navy (#0F172A).
2.  **Mid Layer (Cards/Panels):** Semi-transparent Navy (80% opacity) with a 12px Backdrop Blur and a 1px border of #FFFFFF (10% opacity).
3.  **Top Layer (Modals/Popovers):** Semi-transparent Navy (60% opacity) with a 24px Backdrop Blur and a subtle outer glow using the Primary color.
4.  **Interactive Glow:** Active stakes or selected odds cards feature a 1px border of Electric Blue with a soft 4px outer bloom (box-shadow: 0 0 8px #38BDF840).

## Shapes

The shape language is **Precision-Industrial**. Elements use small, tight radii to maintain a professional, "software-as-a-tool" appearance. 

- **Base Components:** 4px (0.25rem) radius for buttons and input fields.
- **Large Containers:** 8px (0.5rem) radius for dashboard cards and main navigation panels.
- **Data Points:** 0px (Sharp) for chart markers and sparkline nodes to emphasize mathematical exactness.

## Components

- **Buttons:** Primary buttons are solid Electric Blue with JetBrains Mono text. Secondary buttons are "Ghost" style with a 1px border and no fill.
- **Chips (Odds):** Use a monospaced font. The background should be a subtle tint of the status color (e.g., 10% Emerald Green for winning odds) with a high-contrast text color.
- **Lists/Tables:** Use a "Zebra" stripe pattern with alternating 2% opacity white fills. Hover states should highlight the entire row with a 1px Electric Blue left-border.
- **Input Fields:** Darker than the card background. On focus, the 1px border glows Electric Blue.
- **Sparklines:** Use 2px stroke width. Winning trends use Emerald Green; losing trends use Rose Red. Use a gradient fill below the line (20% opacity to 0%).
- **Active Stakes:** Cards representing live bets should have a subtle "pulse" animation on the border using the Accent Amber color if the event is "In-Play."