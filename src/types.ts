export interface BundleWindow {
  start: string;
  end: string;
  samples: number;
  whole_span: boolean;
}

export interface SiteData {
  label: string;
  lat: number;
  lon: number;
  coordinates_note: string;
  horizon_source: string;
  horizon_is_placeholder: boolean;
  h_site_m?: number;
  t: string[];
  sunAlt: number[];
  sunAz: number[];
  sunHorizon: number[];
  earthAlt: number[];
  earthAz: number[];
  earthHorizon: number[];
  lit: number[];
  sunRadius: number[];
  windows: { sunlit: BundleWindow[]; dark: BundleWindow[]; comms: BundleWindow[] };
}

export interface BundleMeta {
  step_hours: number;
  aberration: unknown;
  sunlit_rule: string;
  comms_rule: string;
  horizon_source: string;
  horizon_is_placeholder: boolean;
}

export interface Bundle {
  meta: BundleMeta;
  sites: Record<string, SiteData>;
}