export interface Config {
  baseUrl: string;
  token: string;
  scenario: string;
}
const KEY = "argus.console.config";
export const DEFAULT_CONFIG: Config = {
  baseUrl: (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? "http://localhost:8080",
  token: "dev-token",
  scenario: "",
};

export function loadConfig(storage: Pick<Storage, "getItem"> = localStorage): Config {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return DEFAULT_CONFIG;
    const p = JSON.parse(raw) as Partial<Config>;
    return {
      baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : DEFAULT_CONFIG.baseUrl,
      token: typeof p.token === "string" ? p.token : DEFAULT_CONFIG.token,
      scenario: typeof p.scenario === "string" ? p.scenario : "",
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
export function saveConfig(c: Config, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(KEY, JSON.stringify(c));
}
