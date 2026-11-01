import { createContext, useContext } from "react";
import type { ApiClient } from "./lib/api";
import type { Config } from "./lib/config";

export interface Ctx {
  config: Config;
  setConfig(c: Config): void;
  api: ApiClient;
}
export const AppCtx = createContext<Ctx | null>(null);
export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("AppCtx missing");
  return c;
}
