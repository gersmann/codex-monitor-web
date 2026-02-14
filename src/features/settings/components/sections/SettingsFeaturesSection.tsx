import type { CodexFeature } from "@/types";
import type { SettingsFeaturesSectionProps } from "@settings/hooks/useSettingsFeaturesSection";
import { fileManagerName, openInFileManagerLabel } from "@utils/platformPaths";

function formatFeatureLabel(feature: CodexFeature): string {
  const displayName = feature.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return feature.name
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function featureSubtitle(feature: CodexFeature): string {
  if (feature.description?.trim()) {
    return feature.description;
  }
  if (feature.announcement?.trim()) {
    return feature.announcement;
  }
  return `Feature key: features.${feature.name}`;
}

export function SettingsFeaturesSection({
  appSettings,
  hasFeatureWorkspace,
  hasCodexHomeOverrides,
  openConfigError,
  featureError,
  featuresLoading,
  featureUpdatingKey,
  stableFeatures,
  experimentalFeatures,
  hasDynamicFeatureRows,
  onOpenConfig,
  onToggleCodexFeature,
  onUpdateAppSettings,
}: SettingsFeaturesSectionProps) {
  return (
    <section className="settings-section">
      <div className="settings-section-title">Features</div>
      <div className="settings-section-subtitle">
        Manage stable and experimental Codex features.
      </div>
      {hasCodexHomeOverrides && (
        <div className="settings-help">
          Feature settings are stored in the default CODEX_HOME config.toml.
          <br />
          Workspace overrides are not updated.
        </div>
      )}
      <div className="settings-toggle-row">
        <div>
          <div className="settings-toggle-title">Config file</div>
          <div className="settings-toggle-subtitle">
            Open the Codex config in {fileManagerName()}.
          </div>
        </div>
        <button type="button" className="ghost" onClick={onOpenConfig}>
          {openInFileManagerLabel()}
        </button>
      </div>
      {openConfigError && <div className="settings-help">{openConfigError}</div>}
      <div className="settings-subsection-title">Stable Features</div>
      <div className="settings-subsection-subtitle">
        Production-ready features enabled by default.
      </div>
      <div className="settings-toggle-row">
        <div>
          <div className="settings-toggle-title">Personality</div>
          <div className="settings-toggle-subtitle">
            Choose Codex communication style (writes top-level <code>personality</code> in
            config.toml).
          </div>
        </div>
        <select
          id="features-personality-select"
          className="settings-select"
          value={appSettings.personality}
          onChange={(event) =>
            void onUpdateAppSettings({
              ...appSettings,
              personality: event.target.value as (typeof appSettings)["personality"],
            })
          }
          aria-label="Personality"
        >
          <option value="friendly">Friendly</option>
          <option value="pragmatic">Pragmatic</option>
        </select>
      </div>
      <div className="settings-toggle-row">
        <div>
          <div className="settings-toggle-title">
            Pause queued messages when a response is required
          </div>
          <div className="settings-toggle-subtitle">
            Keep queued messages paused while Codex is waiting for plan accept/changes
            or your answers.
          </div>
        </div>
        <button
          type="button"
          className={`settings-toggle ${appSettings.pauseQueuedMessagesWhenResponseRequired ? "on" : ""}`}
          onClick={() =>
            void onUpdateAppSettings({
              ...appSettings,
              pauseQueuedMessagesWhenResponseRequired:
                !appSettings.pauseQueuedMessagesWhenResponseRequired,
            })
          }
          aria-pressed={appSettings.pauseQueuedMessagesWhenResponseRequired}
        >
          <span className="settings-toggle-knob" />
        </button>
      </div>
      {stableFeatures.map((feature) => (
        <div className="settings-toggle-row" key={feature.name}>
          <div>
            <div className="settings-toggle-title">{formatFeatureLabel(feature)}</div>
            <div className="settings-toggle-subtitle">{featureSubtitle(feature)}</div>
          </div>
          <button
            type="button"
            className={`settings-toggle ${feature.enabled ? "on" : ""}`}
            onClick={() => onToggleCodexFeature(feature)}
            aria-pressed={feature.enabled}
            disabled={featureUpdatingKey === feature.name}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
      ))}
      {hasFeatureWorkspace &&
        !featuresLoading &&
        !featureError &&
        stableFeatures.length === 0 && (
        <div className="settings-help">No stable feature flags returned by Codex.</div>
      )}
      <div className="settings-subsection-title">Experimental Features</div>
      <div className="settings-subsection-subtitle">
        Preview and under-development features.
      </div>
      {experimentalFeatures.map((feature) => (
        <div className="settings-toggle-row" key={feature.name}>
          <div>
            <div className="settings-toggle-title">{formatFeatureLabel(feature)}</div>
            <div className="settings-toggle-subtitle">{featureSubtitle(feature)}</div>
          </div>
          <button
            type="button"
            className={`settings-toggle ${feature.enabled ? "on" : ""}`}
            onClick={() => onToggleCodexFeature(feature)}
            aria-pressed={feature.enabled}
            disabled={featureUpdatingKey === feature.name}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
      ))}
      {hasFeatureWorkspace &&
        !featuresLoading &&
        !featureError &&
        hasDynamicFeatureRows &&
        experimentalFeatures.length === 0 && (
          <div className="settings-help">
            No preview or under-development feature flags returned by Codex.
          </div>
        )}
      {featuresLoading && (
        <div className="settings-help">Loading Codex feature flags...</div>
      )}
      {!hasFeatureWorkspace && !featuresLoading && (
        <div className="settings-help">
          Connect a workspace to load Codex feature flags.
        </div>
      )}
      {featureError && <div className="settings-help">{featureError}</div>}
    </section>
  );
}
