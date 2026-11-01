import { useEffect, useState } from "react";
import type { ScenarioInfo } from "@argus/protocol";
import { useApp } from "../ctx";

export function ConfigBar() {
  const { config, setConfig, api } = useApp();
  const [draft, setDraft] = useState(config);
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .listScenarios()
      .then((s) => {
        if (!live) return;
        setScenarios(s);
        setErr(null);
        if (!config.scenario && s[0]) setConfig({ ...config, scenario: s[0].name });
      })
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  return (
    <form
      className="config-bar"
      onSubmit={(e) => {
        e.preventDefault();
        setConfig(draft);
      }}
    >
      <label>
        Gateway{" "}
        <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
      </label>
      <label>
        Token{" "}
        <input
          type="password"
          value={draft.token}
          onChange={(e) => setDraft({ ...draft, token: e.target.value })}
        />
      </label>
      <button type="submit">Save</button>
      <label>
        Scenario{" "}
        <select value={config.scenario} onChange={(e) => setConfig({ ...config, scenario: e.target.value })}>
          {scenarios.length === 0 && (
            <option value={config.scenario}>{config.scenario || "(none loaded)"}</option>
          )}
          {scenarios.map((s) => (
            <option key={s.name} value={s.name} title={s.description}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {err && <span className="err small">scenarios: {err}</span>}
    </form>
  );
}
