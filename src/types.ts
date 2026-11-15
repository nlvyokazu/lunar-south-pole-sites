// 1:1 with the data contract for public/data/bundle.json (schema 1).
// Timestamps are UTC strings with NO timezone suffix; parse by appending "Z".

export interface Kernel {
  name: string;
  sha256: string;
}

export interface Meta {
  schema: number;
  generated_utc: string;
  sites: string[];
  step_hours: number;
  frame: string;
  radius_km: number;
  ephemeris: string;
  kernels: Kernel[];
  horizon_source: string;
  horizon_is_placeholder: boolean;
  synthetic: boolean;
}

// W in the contract. whole_span = true means "no event in this span".
export interface TimeWindow {
  start: string;
  end: string;
  samples: number;
  whole_span: boolean;
}

export interface SiteWindows {
  sunlit: TimeWindow[];
  dark: TimeWindow[];
  comms: TimeWindow[];
}

// The contract gives only "stats: { ... }" with no field list, so values are
// left open. Cross-check use only.
export type Stats = Record<string, number | string | boolean | null>;

export interface Site {
  label: string;
  lat: number;
  lon: number;
  coordinates_note: string;
  t: string[];
  sunAlt: number[];
  sunAz: number[];
  sunHorizon: number[];
  earthAlt: number[];
  earthAz: number[];
  earthHorizon: number[];
  lit: number[];
  sunRadius: number[];
  windows: SiteWindows;
  stats?: Stats;
}

export interface Bundle {
  meta: Meta;
  sites: Record<string, Site>;
}
