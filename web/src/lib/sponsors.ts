/**
 * Monthly sponsors from $50, by name or logo, in the Support dialog as in the
 * README: empty until the first, and the row shows only then. A logo is a file
 * tradoor serves itself (public/sponsors/), never one read from elsewhere.
 */
export interface Sponsor {
  name: string;
  url: string;
  logo?: string;
}

export const SPONSORS: readonly Sponsor[] = [];
