import en from "../content/en.json";
import id from "../content/id.json";

export const LOCALES = ["en", "id"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const PREF_KEY = "atelier.lang";

const dicts = { en, id } as const;
export type Dict = typeof en;

export const isLocale = (v?: string): v is Locale => !!v && (LOCALES as readonly string[]).includes(v);
export const getDict = (l: Locale): Dict => dicts[l] as Dict;
export const pathFor = (l: Locale) => (l === DEFAULT_LOCALE ? "/" : `/${l}/`);
