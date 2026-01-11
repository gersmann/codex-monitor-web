import { useCallback, useEffect, useRef, useState } from "react";
import "./styles/base.css";
import "./styles/buttons.css";
import "./styles/sidebar.css";
import "./styles/home.css";
import "./styles/main.css";
import "./styles/messages.css";
import "./styles/approvals.css";
import "./styles/composer.css";
import "./styles/diff.css";
import "./styles/debug.css";
import { Sidebar } from "./components/Sidebar";
import { Home } from "./components/Home";
import { MainHeader } from "./components/MainHeader";
import { Messages } from "./components/Messages";
import { Approvals } from "./components/Approvals";
import { Composer } from "./components/Composer";
import { GitDiffPanel } from "./components/GitDiffPanel";
import { DebugPanel } from "./components/DebugPanel";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useThreads } from "./hooks/useThreads";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useGitStatus } from "./hooks/useGitStatus";
import { useModels } from "./hooks/useModels";
import { useSkills } from "./hooks/useSkills";
import type { DebugEntry } from "./types";

function App() {
  const [input, setInput] = useState("");
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [hasDebugAlerts, setHasDebugAlerts] = useState(false);

  const shouldLogEntry = useCallback((entry: DebugEntry) => {
    if (entry.source === "error" || entry.source === "stderr") {
      return true;
    }
    const label = entry.label.toLowerCase();
    if (label.includes("warn") || label.includes("warning")) {
      return true;
    }
    if (typeof entry.payload === "string") {
      const payload = entry.payload.toLowerCase();
      return payload.includes("warn") || payload.includes("warning");
    }
    return false;
  }, []);

  const addDebugEntry = useCallback(
    (entry: DebugEntry) => {
      if (!shouldLogEntry(entry)) {
        return;
      }
      setHasDebugAlerts(true);
      setDebugEntries((prev) => [...prev, entry].slice(-200));
    },
    [shouldLogEntry],
  );

  const handleCopyDebug = async () => {
    const text = debugEntries
      .map((entry) => {
        const timestamp = new Date(entry.timestamp).toLocaleTimeString();
        const payload =
          entry.payload !== undefined
            ? typeof entry.payload === "string"
              ? entry.payload
              : JSON.stringify(entry.payload, null, 2)
            : "";
        return [entry.source.toUpperCase(), timestamp, entry.label, payload]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
    if (text) {
      await navigator.clipboard.writeText(text);
    }
  };

  const {
    workspaces,
    activeWorkspace,
    activeWorkspaceId,
    setActiveWorkspaceId,
    addWorkspace,
    connectWorkspace,
    markWorkspaceConnected,
    hasLoaded,
  } = useWorkspaces({ onDebug: addDebugEntry });

  const { status: gitStatus, refresh: refreshGitStatus } =
    useGitStatus(activeWorkspace);
  const {
    models,
    selectedModel,
    selectedModelId,
    setSelectedModelId,
    reasoningOptions,
    selectedEffort,
    setSelectedEffort,
  } = useModels({ activeWorkspace, onDebug: addDebugEntry });
  const { skills } = useSkills({ activeWorkspace, onDebug: addDebugEntry });

  const resolvedModel = selectedModel?.model ?? null;
  const fileStatus =
    gitStatus.files.length > 0
      ? `${gitStatus.files.length} file${gitStatus.files.length === 1 ? "" : "s"} changed`
      : "Working tree clean";

  const {
    setActiveThreadId,
    activeThreadId,
    activeItems,
    approvals,
    threadsByWorkspace,
    threadStatusById,
    removeThread,
    startThread,
    startThreadForWorkspace,
    listThreadsForWorkspace,
    sendUserMessage,
    handleApprovalDecision,
  } = useThreads({
    activeWorkspace,
    onWorkspaceConnected: markWorkspaceConnected,
    onDebug: addDebugEntry,
    model: resolvedModel,
    effort: selectedEffort,
    onMessageActivity: refreshGitStatus,
  });

  useWindowDrag("titlebar");

  const restoredWorkspaces = useRef(new Set<string>());

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }
    workspaces.forEach((workspace) => {
      if (restoredWorkspaces.current.has(workspace.id)) {
        return;
      }
      restoredWorkspaces.current.add(workspace.id);
      (async () => {
        try {
          if (!workspace.connected) {
            await connectWorkspace(workspace);
          }
          await listThreadsForWorkspace(workspace);
        } catch {
          // Silent: connection errors show in debug panel.
        }
      })();
    });
  }, [connectWorkspace, hasLoaded, listThreadsForWorkspace, workspaces]);

  async function handleOpenProject() {
    const workspace = await addWorkspace();
    if (workspace) {
      setActiveThreadId(null, workspace.id);
    }
  }

  async function handleAddWorkspace() {
    const workspace = await addWorkspace();
    if (workspace) {
      setActiveThreadId(null, workspace.id);
    }
  }

  async function handleNewThread() {
    if (activeWorkspace && !activeWorkspace.connected) {
      await connectWorkspace(activeWorkspace);
    }
    await startThread();
  }

  async function handleSend() {
    if (!input.trim()) {
      return;
    }
    if (activeWorkspace && !activeWorkspace.connected) {
      await connectWorkspace(activeWorkspace);
    }
    await sendUserMessage(input);
    setInput("");
  }

  function handleSelectSkill(name: string) {
    const snippet = `$${name}`;
    setInput((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) {
        return snippet + " ";
      }
      if (trimmed.includes(snippet)) {
        return prev;
      }
      return `${prev.trim()} ${snippet} `;
    });
  }

  return (
    <div className="app">
      <div className="drag-strip" id="titlebar" />
      <Sidebar
        workspaces={workspaces}
        threadsByWorkspace={threadsByWorkspace}
        threadStatusById={threadStatusById}
        activeWorkspaceId={activeWorkspaceId}
        activeThreadId={activeThreadId}
        onAddWorkspace={handleAddWorkspace}
        onSelectWorkspace={setActiveWorkspaceId}
        onConnectWorkspace={connectWorkspace}
        onAddAgent={(workspace) => {
          setActiveWorkspaceId(workspace.id);
          (async () => {
            if (!workspace.connected) {
              await connectWorkspace(workspace);
            }
            await startThreadForWorkspace(workspace.id);
          })();
        }}
        onSelectThread={(workspaceId, threadId) => {
          setActiveWorkspaceId(workspaceId);
          setActiveThreadId(threadId, workspaceId);
        }}
        onDeleteThread={(workspaceId, threadId) => {
          removeThread(workspaceId, threadId);
        }}
      />

      <section className="main">
        {!activeWorkspace && (
          <Home
            onOpenProject={handleOpenProject}
            onAddWorkspace={handleAddWorkspace}
            onCloneRepository={() => {}}
          />
        )}

      {activeWorkspace && (
          <>
            <div className="main-topbar">
              <MainHeader
                workspace={activeWorkspace}
                branchName={gitStatus.branchName || "unknown"}
              />
            <div className="actions">
              {hasDebugAlerts && (
                <button
                  className="ghost icon-button"
                  onClick={() => setDebugOpen((prev) => !prev)}
                  aria-label="Debug"
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M9 7.5V6.5a3 3 0 0 1 6 0v1"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                    <rect
                      x="7"
                      y="7.5"
                      width="10"
                      height="9"
                      rx="3"
                      stroke="currentColor"
                      strokeWidth="1.4"
                    />
                    <path
                      d="M4 12h3m10 0h3M6 8l2 2m8-2-2 2M6 16l2-2m8 2-2-2"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                    <circle cx="10" cy="12" r="0.8" fill="currentColor" />
                    <circle cx="14" cy="12" r="0.8" fill="currentColor" />
                  </svg>
                </button>
              )}
            </div>
          </div>

            <div className="content">
              <Messages
                items={activeItems}
                isThinking={
                  activeThreadId
                    ? threadStatusById[activeThreadId]?.isProcessing ?? false
                    : false
                }
              />
            </div>

            <div className="right-panel">
              <GitDiffPanel
                branchName={gitStatus.branchName || "unknown"}
                totalAdditions={gitStatus.totalAdditions}
                totalDeletions={gitStatus.totalDeletions}
                fileStatus={fileStatus}
                error={gitStatus.error}
                files={gitStatus.files}
              />
              <Approvals approvals={approvals} onDecision={handleApprovalDecision} />
            </div>

            <Composer
              value={input}
              onChange={setInput}
              onSend={handleSend}
              models={models}
              selectedModelId={selectedModelId}
              onSelectModel={setSelectedModelId}
              reasoningOptions={reasoningOptions}
              selectedEffort={selectedEffort}
              onSelectEffort={setSelectedEffort}
              skills={skills}
              onSelectSkill={handleSelectSkill}
            />
            <DebugPanel
              entries={debugEntries}
              isOpen={debugOpen}
              onToggle={() => setDebugOpen((prev) => !prev)}
              onClear={() => {
                setDebugEntries([]);
                setHasDebugAlerts(false);
              }}
              onCopy={handleCopyDebug}
            />
          </>
        )}
      </section>
    </div>
  );
}

export default App;
