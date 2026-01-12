import { IconCodex, IconGit, IconLog, IconProjects } from "./icons";

type TabKey = "projects" | "codex" | "git" | "log";

type TabBarProps = {
  activeTab: TabKey;
  onSelect: (tab: TabKey) => void;
};

const tabs: { id: TabKey; label: string; icon: JSX.Element }[] = [
  { id: "projects", label: "Projects", icon: <IconProjects className="tabbar-icon" /> },
  { id: "codex", label: "Codex", icon: <IconCodex className="tabbar-icon" /> },
  { id: "git", label: "Git", icon: <IconGit className="tabbar-icon" /> },
  { id: "log", label: "Log", icon: <IconLog className="tabbar-icon" /> },
];

export function TabBar({ activeTab, onSelect }: TabBarProps) {
  return (
    <nav className="tabbar" aria-label="Primary">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`tabbar-item ${activeTab === tab.id ? "active" : ""}`}
          onClick={() => onSelect(tab.id)}
          aria-current={activeTab === tab.id ? "page" : undefined}
        >
          {tab.icon}
          <span className="tabbar-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
