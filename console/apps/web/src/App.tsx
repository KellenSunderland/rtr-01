import { useMemo, useState } from "react";
import { ApiClient } from "./lib/api";
import { loadConfig, saveConfig, type Config } from "./lib/config";
import { AppCtx } from "./ctx";
import { ConfigBar } from "./components/ConfigBar";
import { StreamsPage } from "./pages/StreamsPage";
import { SessionPage } from "./pages/SessionPage";

export function App() {
  const [config, setCfg] = useState<Config>(() => loadConfig());
  const [page, setPage] = useState<"streams" | "session">("streams");
  const api = useMemo(() => new ApiClient(config), [config.baseUrl, config.token]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx = useMemo(
    () => ({
      config,
      api,
      setConfig: (c: Config) => {
        saveConfig(c);
        setCfg(c);
      },
    }),
    [config, api],
  );
  return (
    <AppCtx.Provider value={ctx}>
      <header>
        <h1>Argus</h1>
        <nav>
          <button className={page === "streams" ? "on" : ""} onClick={() => setPage("streams")}>
            Streams
          </button>
          <button className={page === "session" ? "on" : ""} onClick={() => setPage("session")}>
            Session
          </button>
        </nav>
        <ConfigBar />
      </header>
      <main>{page === "streams" ? <StreamsPage /> : <SessionPage />}</main>
    </AppCtx.Provider>
  );
}
